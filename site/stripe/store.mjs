function throwIf(error) {
  if (error) throw error;
}

/** Service-role access to billing and stripe_events. Callers pass the client. */
export function createBillingStore(supabase) {
  return {
    async getByUserId(userId) {
      const { data, error } = await supabase
        .from("billing")
        .select("user_id, stripe_customer_id, stripe_subscription_id, plan, plan_status, current_period_end")
        .eq("user_id", userId)
        .maybeSingle();
      throwIf(error);
      return data;
    },

    async getByCustomerId(customerId) {
      const { data, error } = await supabase
        .from("billing")
        .select("user_id, stripe_customer_id, stripe_subscription_id, plan, plan_status")
        .eq("stripe_customer_id", customerId)
        .maybeSingle();
      throwIf(error);
      return data;
    },

    async getBySubscriptionId(subscriptionId) {
      const { data, error } = await supabase
        .from("billing")
        .select("user_id, stripe_customer_id, stripe_subscription_id, plan, plan_status")
        .eq("stripe_subscription_id", subscriptionId)
        .maybeSingle();
      throwIf(error);
      return data;
    },

    async saveCustomer(userId, stripeCustomerId) {
      const { error } = await supabase.from("billing").upsert(
        {
          user_id: userId,
          stripe_customer_id: stripeCustomerId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" },
      );
      throwIf(error);
    },

    async updateBilling(userId, fields) {
      const { error } = await supabase.from("billing").upsert(
        {
          user_id: userId,
          ...fields,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" },
      );
      throwIf(error);
    },

    async claimEvent(id, type) {
      const { error } = await supabase.from("stripe_events").insert({ id, type });
      if (error && error.code === "23505") return false;
      throwIf(error);
      return true;
    },

    async releaseEvent(id) {
      const { error } = await supabase.from("stripe_events").delete().eq("id", id);
      throwIf(error);
    },
  };
}
