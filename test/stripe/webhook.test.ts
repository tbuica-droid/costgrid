import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import { STRIPE_API_VERSION } from "../../site/stripe/clients.mjs";
import { handleWebhook } from "../../site/stripe/webhook.mjs";

const SECRET = "whsec_test_secret";
const USER = "11111111-1111-1111-1111-111111111111";

const stripe = new Stripe("sk_test_51H000000000000000000000000000000", {
  apiVersion: STRIPE_API_VERSION,
});

function subscription(lookupKey: string, status = "active") {
  return {
    id: "sub_1",
    object: "subscription",
    customer: "cus_1",
    status,
    metadata: { supabase_user_id: USER },
    items: {
      data: [
        {
          current_period_end: 1_800_000_000,
          price: { id: "price_1", lookup_key: lookupKey },
        },
      ],
    },
  };
}

function invoiceEvent(type: string, id = "evt_invoice") {
  return {
    id,
    object: "event",
    type,
    data: {
      object: {
        id: "in_1",
        object: "invoice",
        parent: {
          type: "subscription_details",
          subscription_details: {
            subscription: "sub_1",
            metadata: { supabase_user_id: USER },
          },
        },
      },
    },
  };
}

function memoryStore() {
  const events = new Set<string>();
  const updates: Array<{ userId: string; fields: Record<string, unknown> }> = [];
  return {
    updates,
    getByUserId: vi.fn(async () => null),
    getByCustomerId: vi.fn(async () => null),
    getBySubscriptionId: vi.fn(async () => null),
    saveCustomer: vi.fn(async () => {}),
    updateBilling: vi.fn(async (userId: string, fields: Record<string, unknown>) => {
      updates.push({ userId, fields });
    }),
    claimEvent: vi.fn(async (id: string) => {
      if (events.has(id)) return false;
      events.add(id);
      return true;
    }),
    releaseEvent: vi.fn(async (id: string) => {
      events.delete(id);
    }),
  };
}

function signed(event: unknown) {
  const payload = JSON.stringify(event);
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
  return { payload, signature };
}

function withSubscription(lookupKey: string, status = "active") {
  const client = new Stripe("sk_test_51H000000000000000000000000000000", {
    apiVersion: STRIPE_API_VERSION,
  });
  client.subscriptions.retrieve = vi.fn(async () => subscription(lookupKey, status)) as typeof client.subscriptions.retrieve;
  return client;
}

describe("stripe webhook", () => {
  it("rejects a bad signature and does not record the event", async () => {
    const store = memoryStore();
    const { payload } = signed(invoiceEvent("invoice.paid"));
    const result = await handleWebhook({
      stripe,
      store,
      rawBody: payload,
      signature: "t=1,v1=not-a-signature",
      webhookSecret: SECRET,
    });
    expect(result.status).toBe(400);
    expect(store.claimEvent).not.toHaveBeenCalled();
    expect(store.updateBilling).not.toHaveBeenCalled();
  });

  it("applies an event once", async () => {
    const store = memoryStore();
    const client = withSubscription("costgrid_pro_monthly");
    const { payload, signature } = signed(invoiceEvent("invoice.paid", "evt_once"));
    const first = await handleWebhook({ stripe: client, store, rawBody: payload, signature, webhookSecret: SECRET });
    const second = await handleWebhook({ stripe: client, store, rawBody: payload, signature, webhookSecret: SECRET });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(store.updateBilling).toHaveBeenCalledTimes(1);
    expect(store.updates[0]).toMatchObject({
      userId: USER,
      fields: { plan: "pro", plan_status: "active", stripe_subscription_id: "sub_1" },
    });
  });

  it("maps price lookup keys onto site plans", async () => {
    const store = memoryStore();
    const client = withSubscription("costgrid_team_monthly");
    const { payload, signature } = signed(invoiceEvent("invoice.paid", "evt_team"));
    const result = await handleWebhook({ stripe: client, store, rawBody: payload, signature, webhookSecret: SECRET });
    expect(result.status).toBe(200);
    expect(store.updates[0]?.fields.plan).toBe("team");
    expect(store.updates[0]?.fields.current_period_end).toBe(new Date(1_800_000_000 * 1000).toISOString());
  });

  it("does not keep an unmapped price, and releases the claim so Stripe can retry", async () => {
    const store = memoryStore();
    const client = withSubscription("costgrid_unknown");
    const { payload, signature } = signed(invoiceEvent("invoice.paid", "evt_unknown"));
    const result = await handleWebhook({ stripe: client, store, rawBody: payload, signature, webhookSecret: SECRET });
    expect(result.status).toBe(500);
    expect(store.updateBilling).not.toHaveBeenCalled();
    expect(store.releaseEvent).toHaveBeenCalledWith("evt_unknown");
    const retry = await handleWebhook({ stripe: client, store, rawBody: payload, signature, webhookSecret: SECRET });
    expect(retry.status).toBe(500);
    expect(store.claimEvent).toHaveBeenCalledTimes(2);
  });

  it("does not grant access when checkout completes unpaid", async () => {
    const store = memoryStore();
    const event = {
      id: "evt_unpaid",
      object: "event",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_1",
          object: "checkout.session",
          mode: "subscription",
          payment_status: "unpaid",
          subscription: "sub_1",
          client_reference_id: USER,
        },
      },
    };
    const { payload, signature } = signed(event);
    const result = await handleWebhook({ stripe, store, rawBody: payload, signature, webhookSecret: SECRET });
    expect(result.status).toBe(200);
    expect(store.updateBilling).not.toHaveBeenCalled();
  });

  it("sets the plan back to free when a subscription charge is fully refunded", async () => {
    const store = memoryStore();
    const client = withSubscription("costgrid_pro_monthly");
    client.invoicePayments.list = vi.fn(async () => ({
      data: [
        {
          id: "inpay_1",
          invoice: {
            id: "in_1",
            parent: { type: "subscription_details", subscription_details: { subscription: "sub_1" } },
          },
        },
      ],
      has_more: false,
    })) as typeof client.invoicePayments.list;
    const event = {
      id: "evt_refund",
      object: "event",
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_1",
          object: "charge",
          amount: 9900,
          amount_refunded: 9900,
          customer: "cus_1",
          payment_intent: "pi_1",
        },
      },
    };
    const { payload, signature } = signed(event);
    const result = await handleWebhook({ stripe: client, store, rawBody: payload, signature, webhookSecret: SECRET });
    expect(result.status).toBe(200);
    expect(client.invoicePayments.list).toHaveBeenCalledWith(
      expect.objectContaining({
        payment: { type: "payment_intent", payment_intent: "pi_1" },
        status: "paid",
      }),
    );
    expect(store.updates[0]?.fields).toMatchObject({ plan: "free", plan_status: "refunded" });
  });

  it("leaves the plan alone on a partial refund", async () => {
    const store = memoryStore();
    const event = {
      id: "evt_partial",
      object: "event",
      type: "charge.refunded",
      data: { object: { id: "ch_2", amount: 9900, amount_refunded: 1000, payment_intent: "pi_2" } },
    };
    const { payload, signature } = signed(event);
    const result = await handleWebhook({ stripe, store, rawBody: payload, signature, webhookSecret: SECRET });
    expect(result.status).toBe(200);
    expect(store.updateBilling).not.toHaveBeenCalled();
  });

  it("revokes a deleted subscription", async () => {
    const store = memoryStore();
    const client = withSubscription("costgrid_pro_monthly", "canceled");
    const event = {
      id: "evt_deleted",
      object: "event",
      type: "customer.subscription.deleted",
      data: { object: subscription("costgrid_pro_monthly", "canceled") },
    };
    const { payload, signature } = signed(event);
    const result = await handleWebhook({ stripe: client, store, rawBody: payload, signature, webhookSecret: SECRET });
    expect(result.status).toBe(200);
    expect(store.updates[0]?.fields).toMatchObject({ plan: "free", plan_status: "canceled" });
  });
});
