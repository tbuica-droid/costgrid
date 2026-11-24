import { describe, expect, it, vi } from "vitest";
import { CANCEL_URL, PORTAL_RETURN_URL, SUCCESS_URL, createCheckout } from "../../site/stripe/checkout.mjs";
import { handleCheckout, handlePortal } from "../../site/stripe/routes.mjs";

const USER = { id: "11111111-1111-1111-1111-111111111111", email: "ana@northwind.test" };

function stripeMock(priceId = "price_pro") {
  return {
    prices: {
      list: vi.fn(async () => ({ data: [{ id: priceId, lookup_key: "costgrid_pro_monthly" }] })),
    },
    customers: {
      create: vi.fn(async () => ({ id: "cus_new" })),
    },
    checkout: {
      sessions: {
        create: vi.fn(async () => ({ url: "https://checkout.stripe.com/c/pay/cs_test_123" })),
      },
    },
    billingPortal: {
      sessions: {
        create: vi.fn(async () => ({ url: "https://billing.stripe.com/p/session/test_123" })),
      },
    },
  };
}

function storeMock(row: { stripe_customer_id?: string } | null = null) {
  return {
    getByUserId: vi.fn(async () => row),
    saveCustomer: vi.fn(async () => {}),
  };
}

function request(body: unknown, authorization?: string) {
  return new Request("https://costgrid.org/api/stripe/checkout", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("checkout auth", () => {
  it("requires a signed-in user", async () => {
    const stripe = stripeMock();
    const missing = await handleCheckout(request({ plan: "pro" }), {
      stripe,
      store: storeMock(),
      getUser: async () => null,
    });
    expect(missing.status).toBe(401);
    const invalid = await handleCheckout(request({ plan: "pro" }, "Bearer not-a-token"), {
      stripe,
      store: storeMock(),
      getUser: async () => null,
    });
    expect(invalid.status).toBe(401);
    expect(stripe.prices.list).not.toHaveBeenCalled();
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("rejects an unknown plan before calling Stripe", async () => {
    const stripe = stripeMock();
    const response = await handleCheckout(request({ plan: "business" }, "Bearer token"), {
      stripe,
      store: storeMock(),
      getUser: async () => USER,
    });
    expect(response.status).toBe(400);
    expect(stripe.prices.list).not.toHaveBeenCalled();
  });

  it("looks up the price, reuses no customer, and returns the hosted checkout URL", async () => {
    const stripe = stripeMock();
    const store = storeMock(null);
    const response = await handleCheckout(request({ plan: "pro" }, "Bearer token"), {
      stripe,
      store,
      getUser: async () => USER,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ url: "https://checkout.stripe.com/c/pay/cs_test_123" });
    expect(stripe.prices.list).toHaveBeenCalledWith({ lookup_keys: ["costgrid_pro_monthly"], limit: 1 });
    expect(stripe.customers.create).toHaveBeenCalledWith(
      { email: USER.email, metadata: { supabase_user_id: USER.id } },
      { idempotencyKey: `costgrid_customer_${USER.id}` },
    );
    expect(store.saveCustomer).toHaveBeenCalledWith(USER.id, "cus_new");
    const session = stripe.checkout.sessions.create.mock.calls[0][0];
    expect(session).toMatchObject({
      mode: "subscription",
      customer: "cus_new",
      client_reference_id: USER.id,
      metadata: { supabase_user_id: USER.id },
      subscription_data: { metadata: { supabase_user_id: USER.id } },
      line_items: [{ price: "price_pro", quantity: 1 }],
      success_url: SUCCESS_URL,
      cancel_url: CANCEL_URL,
    });
    expect(session.payment_method_types).toBeUndefined();
    expect(session.integration_identifier).toMatch(/^costgrid_checkout_[a-z]{8}$/);
  });

  it("reuses the stored Stripe customer", async () => {
    const stripe = stripeMock("price_team");
    stripe.prices.list.mockResolvedValue({ data: [{ id: "price_team", lookup_key: "costgrid_team_monthly" }] });
    const store = storeMock({ stripe_customer_id: "cus_existing" });
    await createCheckout({ stripe, store, user: USER, plan: "team" });
    expect(stripe.prices.list).toHaveBeenCalledWith({ lookup_keys: ["costgrid_team_monthly"], limit: 1 });
    expect(stripe.customers.create).not.toHaveBeenCalled();
    expect(stripe.checkout.sessions.create.mock.calls[0][0].customer).toBe("cus_existing");
  });

  it("opens the billing portal only for a stored customer", async () => {
    const stripe = stripeMock();
    const missing = await handlePortal(request({}, "Bearer token"), {
      stripe,
      store: storeMock(null),
      getUser: async () => USER,
    });
    expect(missing.status).toBe(409);
    const response = await handlePortal(request({}, "Bearer token"), {
      stripe,
      store: storeMock({ stripe_customer_id: "cus_existing" }),
      getUser: async () => USER,
    });
    expect(response.status).toBe(200);
    expect(stripe.billingPortal.sessions.create).toHaveBeenCalledWith({
      customer: "cus_existing",
      return_url: PORTAL_RETURN_URL,
    });
  });
});
