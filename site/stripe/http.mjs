export function json(status, body) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

/** Messages that name a missing setting and contain no secret. */
export function configErrorMessage(err) {
  const message = err && err.message ? String(err.message) : "";
  if (
    message === "STRIPE_SECRET_KEY is not set." ||
    message === "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set." ||
    message === "Webhook is not configured."
  ) {
    return message;
  }
  return null;
}

/** A log line that cannot contain a key, a webhook secret, or a JWT. */
export function safeMessage(err) {
  const message = err && err.message ? String(err.message) : "error";
  if (/sk_|rk_|whsec_|service_role|eyJ|supabase/i.test(message)) return "error";
  return message.slice(0, 300);
}

/**
 * The raw request bytes, which Stripe's signature is computed over.
 * Vercel must not parse the body first (config.api.bodyParser is false).
 */
export async function readRawBody(request) {
  if (typeof request.text === "function") {
    const text = await request.text();
    if (typeof text === "string") return text;
  }
  if (typeof request.body === "string") return request.body;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(request.body)) return request.body.toString("utf8");
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
