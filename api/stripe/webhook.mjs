import { stripeClient, supabaseAdmin } from "../_lib/clients.mjs";
import { configErrorMessage, json, readRawBody, safeMessage } from "../../site/stripe/http.mjs";
import { createBillingStore } from "../../site/stripe/store.mjs";
import { handleWebhook } from "../../site/stripe/webhook.mjs";

export async function POST(request) {
  try {
    const rawBody = await readRawBody(request);
    const result = await handleWebhook({
      stripe: stripeClient(),
      store: createBillingStore(supabaseAdmin()),
      rawBody,
      signature: request.headers.get("stripe-signature") || "",
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",
    });
    return json(result.status, result.body);
  } catch (err) {
    console.error("stripe webhook failed", safeMessage(err));
    return json(500, { error: configErrorMessage(err) || "Could not process the event." });
  }
}
