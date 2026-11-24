import { randomBytes } from "node:crypto";
import { LOOKUP_KEYS, isSitePlan } from "./plans.mjs";

export const SUCCESS_URL = "https://costgrid.org/?checkout=success";
export const CANCEL_URL = "https://costgrid.org/#pricing";
export const PORTAL_RETURN_URL = "https://costgrid.org/";

/** Dashboard label for this checkout flow. The suffix is 8 random letters. */
export function integrationIdentifier() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  const bytes = randomBytes(8);
  let suffix = "";
  for (let i = 0; i < 8; i++) suffix += alphabet[bytes[i] % 26];
  return `costgrid_checkout_${suffix}`;
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export async function createCheckout({ stripe, store, user, plan }) {
  if (!isSitePlan(plan)) throw httpError(400, "Choose Pro or Team.");
  const lookupKey = LOOKUP_KEYS[plan];
  const prices = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 1 });
  const price = prices.data && prices.data[0];
  if (!price) throw httpError(500, "That plan is not available yet.");

  const existing = await store.getByUserId(user.id);
  let customerId = existing && existing.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create(
      {
        email: user.email || undefined,
        metadata: { supabase_user_id: user.id },
      },
      { idempotencyKey: `costgrid_customer_${user.id}` },
    );
    customerId = customer.id;
    await store.saveCustomer(user.id, customerId);
  }

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    client_reference_id: user.id,
    metadata: { supabase_user_id: user.id },
    subscription_data: { metadata: { supabase_user_id: user.id } },
    line_items: [{ price: price.id, quantity: 1 }],
    success_url: SUCCESS_URL,
    cancel_url: CANCEL_URL,
    integration_identifier: integrationIdentifier(),
  });
  if (!session.url) throw httpError(502, "Stripe did not return a checkout URL.");
  return { url: session.url };
}

export async function createPortal({ stripe, store, user }) {
  const existing = await store.getByUserId(user.id);
  if (!existing || !existing.stripe_customer_id) throw httpError(409, "No billing account yet.");
  const session = await stripe.billingPortal.sessions.create({
    customer: existing.stripe_customer_id,
    return_url: PORTAL_RETURN_URL,
  });
  if (!session.url) throw httpError(502, "Stripe did not return a billing portal URL.");
  return { url: session.url };
}
