import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

/**
 * Lives under api/ so Node resolves `stripe` from api/node_modules.
 * Vercel does not publish a path containing "/_" as a function.
 * Nothing here runs at import time: missing env vars throw only when a
 * request calls stripeClient() or supabaseAdmin().
 */

/** Matches the stripe package's pinned API version. */
export const STRIPE_API_VERSION = "2026-11-18.endive";

export function stripeClient() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set.");
  return new Stripe(key, { apiVersion: STRIPE_API_VERSION });
}

export function supabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
