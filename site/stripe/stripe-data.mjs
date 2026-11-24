/** Stripe ids arrive as a string or an expanded object. */
export function idOf(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object" && typeof value.id === "string") return value.id;
  return null;
}

/** Billing period end lives on each subscription item in the current API. */
export function periodEndUnix(subscription) {
  const items = subscription.items && Array.isArray(subscription.items.data) ? subscription.items.data : [];
  const ends = items.map((item) => item.current_period_end).filter((value) => typeof value === "number");
  if (ends.length) return Math.min(...ends);
  return typeof subscription.current_period_end === "number" ? subscription.current_period_end : null;
}

export function periodEndIso(subscription) {
  const unix = periodEndUnix(subscription);
  return unix == null ? null : new Date(unix * 1000).toISOString();
}

export function lookupKeyFromSubscription(subscription) {
  const items = subscription.items && Array.isArray(subscription.items.data) ? subscription.items.data : [];
  for (const item of items) {
    const price = item.price;
    if (price && typeof price === "object" && price.lookup_key) return price.lookup_key;
  }
  return null;
}

export async function lookupKeyFor(stripe, subscription) {
  const present = lookupKeyFromSubscription(subscription);
  if (present) return present;
  const items = subscription.items && Array.isArray(subscription.items.data) ? subscription.items.data : [];
  const price = items[0] && items[0].price;
  const priceId = idOf(price);
  if (!priceId || !stripe.prices) return null;
  const full = await stripe.prices.retrieve(priceId);
  return full.lookup_key || null;
}

/** Invoice → subscription, for API version 2025-03-31.basil and later. */
export function subscriptionIdFromInvoice(invoice) {
  const parent = invoice && invoice.parent;
  if (
    parent &&
    parent.type === "subscription_details" &&
    parent.subscription_details &&
    parent.subscription_details.subscription
  ) {
    return idOf(parent.subscription_details.subscription);
  }
  if (invoice && invoice.subscription) return idOf(invoice.subscription);
  return null;
}

/**
 * Charge → subscription, for API version 2025-03-31.basil and later.
 * A charge no longer carries an invoice. The payment intent lists its paid
 * invoice payments, and each invoice's parent points at the subscription.
 */
export async function subscriptionIdsFromCharge(stripe, charge) {
  if (charge.invoice) {
    const invoice = typeof charge.invoice === "string" ? await stripe.invoices.retrieve(charge.invoice) : charge.invoice;
    const subId = subscriptionIdFromInvoice(invoice);
    return subId ? [subId] : [];
  }
  const paymentIntentId = idOf(charge.payment_intent);
  if (!paymentIntentId) return [];
  const ids = [];
  let startingAfter;
  for (;;) {
    const params = {
      payment: { type: "payment_intent", payment_intent: paymentIntentId },
      status: "paid",
      limit: 100,
    };
    if (startingAfter) params.starting_after = startingAfter;
    const page = await stripe.invoicePayments.list(params);
    const data = page.data || [];
    for (const payment of data) {
      const invoiceId = idOf(payment.invoice);
      if (!invoiceId) continue;
      const invoice =
        payment.invoice && typeof payment.invoice === "object" && payment.invoice.parent
          ? payment.invoice
          : await stripe.invoices.retrieve(invoiceId);
      const subId = subscriptionIdFromInvoice(invoice);
      if (subId) ids.push(subId);
    }
    if (!page.has_more || data.length === 0) break;
    startingAfter = data[data.length - 1].id;
  }
  return [...new Set(ids)];
}
