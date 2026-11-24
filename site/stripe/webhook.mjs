import { ENTITLED_STATUSES, entitlementFor } from "./plans.mjs";
import {
  idOf,
  lookupKeyFor,
  periodEndIso,
  subscriptionIdFromInvoice,
  subscriptionIdsFromCharge,
} from "./stripe-data.mjs";

export const HANDLED_EVENTS = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "invoice.paid",
  "invoice.payment_failed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "charge.refunded",
]);

async function resolveUserId(store, { customerId, subscriptionId, metadataUserId }) {
  if (customerId) {
    const byCustomer = await store.getByCustomerId(customerId);
    if (byCustomer) return byCustomer.user_id;
  }
  if (subscriptionId) {
    const bySubscription = await store.getBySubscriptionId(subscriptionId);
    if (bySubscription) return bySubscription.user_id;
  }
  if (metadataUserId) return metadataUserId;
  const error = new Error("No CostGrid user for this Stripe event");
  error.code = "unknown_user";
  throw error;
}

async function syncSubscription(stripe, store, subscription, fallbackUserId) {
  const lookupKey = await lookupKeyFor(stripe, subscription);
  const entitled = entitlementFor(subscription.status, lookupKey);
  const customerId = idOf(subscription.customer);
  const userId = await resolveUserId(store, {
    customerId,
    subscriptionId: subscription.id,
    metadataUserId: fallbackUserId || (subscription.metadata && subscription.metadata.supabase_user_id) || null,
  });
  await store.updateBilling(userId, {
    stripe_customer_id: customerId,
    stripe_subscription_id: subscription.id,
    plan: entitled.plan,
    plan_status: entitled.plan_status,
    current_period_end: periodEndIso(subscription),
  });
}

async function loadSubscription(stripe, subscriptionId) {
  return stripe.subscriptions.retrieve(subscriptionId, { expand: ["items.data.price"] });
}

async function onCheckoutSession(stripe, store, session) {
  if (session.mode && session.mode !== "subscription") return;
  // Delayed payment methods complete while still unpaid. Access waits for
  // async_payment_succeeded or invoice.paid.
  if (session.payment_status === "unpaid") return;
  const subscriptionId = idOf(session.subscription);
  if (!subscriptionId) return;
  const subscription = await loadSubscription(stripe, subscriptionId);
  const fallback = session.client_reference_id || (session.metadata && session.metadata.supabase_user_id) || null;
  await syncSubscription(stripe, store, subscription, fallback);
}

async function onCheckoutFailed(store, session) {
  const userId = session.client_reference_id || (session.metadata && session.metadata.supabase_user_id) || null;
  if (!userId) {
    const error = new Error("No CostGrid user for this checkout");
    error.code = "unknown_user";
    throw error;
  }
  const row = await store.getByUserId(userId);
  if (row && (row.plan === "pro" || row.plan === "team") && ENTITLED_STATUSES.has(row.plan_status)) return;
  await store.updateBilling(userId, {
    stripe_customer_id: idOf(session.customer) || (row && row.stripe_customer_id) || null,
    stripe_subscription_id: idOf(session.subscription) || null,
    plan: "free",
    plan_status: "incomplete",
    current_period_end: null,
  });
}

async function onInvoice(stripe, store, invoice) {
  const subscriptionId = subscriptionIdFromInvoice(invoice);
  if (!subscriptionId) return;
  const subscription = await loadSubscription(stripe, subscriptionId);
  const details = invoice.parent && invoice.parent.subscription_details;
  const fallback = (details && details.metadata && details.metadata.supabase_user_id) || null;
  await syncSubscription(stripe, store, subscription, fallback);
}

async function onRefund(stripe, store, charge) {
  const full = typeof charge.amount === "number" && charge.amount > 0 && charge.amount_refunded >= charge.amount;
  if (!full) return;
  const subscriptionIds = await subscriptionIdsFromCharge(stripe, charge);
  for (const subscriptionId of subscriptionIds) {
    const subscription = await loadSubscription(stripe, subscriptionId);
    const customerId = idOf(charge.customer) || idOf(subscription.customer);
    const userId = await resolveUserId(store, {
      customerId,
      subscriptionId,
      metadataUserId: (subscription.metadata && subscription.metadata.supabase_user_id) || null,
    });
    await store.updateBilling(userId, {
      stripe_customer_id: customerId,
      stripe_subscription_id: subscriptionId,
      plan: "free",
      plan_status: "refunded",
      current_period_end: null,
    });
  }
}

async function dispatch(event, { stripe, store }) {
  const object = event.data.object;
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      await onCheckoutSession(stripe, store, object);
      return;
    case "checkout.session.async_payment_failed":
      await onCheckoutFailed(store, object);
      return;
    case "invoice.paid":
    case "invoice.payment_failed":
      await onInvoice(stripe, store, object);
      return;
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await syncSubscription(stripe, store, object, null);
      return;
    case "charge.refunded":
      await onRefund(stripe, store, object);
      return;
    default:
      return;
  }
}

/**
 * Verifies the signature, claims the event id, then updates billing.
 * A duplicate id is acknowledged and not applied again. A failure releases the
 * claim so Stripe's retry can try again. Events this integration does not act
 * on are acknowledged and not recorded.
 */
export async function handleWebhook({ stripe, store, rawBody, signature, webhookSecret }) {
  if (!webhookSecret) return { status: 500, body: { error: "Webhook is not configured." } };
  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch {
    return { status: 400, body: { error: "Invalid signature." } };
  }
  if (!HANDLED_EVENTS.has(event.type)) return { status: 200, body: { received: true } };
  const claimed = await store.claimEvent(event.id, event.type);
  if (!claimed) return { status: 200, body: { received: true } };
  try {
    await dispatch(event, { stripe, store });
  } catch {
    try {
      await store.releaseEvent(event.id);
    } catch {
      // The claim is stuck until it is removed by hand. Stripe will retry and
      // see the duplicate until then, which is the safer failure.
    }
    return { status: 500, body: { error: "Could not process the event." } };
  }
  return { status: 200, body: { received: true } };
}
