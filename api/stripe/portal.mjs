import { userFromAuthorization } from "../../site/stripe/auth.mjs";
import { stripeClient, supabaseAdmin } from "../../site/stripe/clients.mjs";
import { json, safeMessage } from "../../site/stripe/http.mjs";
import { handlePortal } from "../../site/stripe/routes.mjs";
import { createBillingStore } from "../../site/stripe/store.mjs";

export async function POST(request) {
  try {
    const supabase = supabaseAdmin();
    return await handlePortal(request, {
      stripe: stripeClient(),
      store: createBillingStore(supabase),
      getUser: (authorization) => userFromAuthorization(supabase, authorization),
    });
  } catch (err) {
    console.error("stripe portal failed", safeMessage(err));
    return json(500, { error: "Could not open billing." });
  }
}
