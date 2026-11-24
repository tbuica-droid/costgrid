import { afterEach, describe, expect, it } from "vitest";

const ENV = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const;
const saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));

function clearEnv() {
  for (const name of ENV) delete process.env[name];
}

afterEach(() => {
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

function post(path: string, body = "{}") {
  return new Request(`https://costgrid.org${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

describe("function startup without billing env", () => {
  it("imports and answers 500 naming the missing setting", async () => {
    clearEnv();
    const checkout = await import("../../api/stripe/checkout.mjs");
    const portal = await import("../../api/stripe/portal.mjs");
    const webhook = await import("../../api/stripe/webhook.mjs");

    const checkoutRes = await checkout.POST(post("/api/stripe/checkout", JSON.stringify({ plan: "pro" })));
    expect(checkoutRes.status).toBe(500);
    expect((await checkoutRes.json()).error).toBe("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");

    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
    const stripeRes = await portal.POST(post("/api/stripe/portal"));
    expect(stripeRes.status).toBe(500);
    expect((await stripeRes.json()).error).toBe("STRIPE_SECRET_KEY is not set.");

    process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";
    const webhookRes = await webhook.POST(post("/api/stripe/webhook", "{}"));
    expect(webhookRes.status).toBe(500);
    expect((await webhookRes.json()).error).toBe("Webhook is not configured.");
  });
});