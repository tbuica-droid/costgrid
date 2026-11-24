-- Website subscriptions. Stripe webhooks, using the service role, are the only
-- writer. A signed-in person can read their own row and cannot insert or change
-- it, so a plan cannot be self-granted.
--
-- This is its own table, not new columns on profiles. profiles requires company
-- and spend (20260924_profiles.sql) and notified_at is not writable by visitors
-- (20261114_inquiry_notify.sql). A person can subscribe before they answer
-- those questions, and this file does not change those grants.
--
-- Run once in the Supabase SQL editor, after 20261114_inquiry_notify.sql.

create table public.billing (
  user_id uuid primary key references auth.users (id) on delete cascade,
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  plan text not null default 'free' check (plan in ('free', 'pro', 'team')),
  plan_status text check (
    plan_status is null or plan_status in (
      'active',
      'trialing',
      'past_due',
      'canceled',
      'unpaid',
      'incomplete',
      'incomplete_expired',
      'paused',
      'refunded'
    )
  ),
  current_period_end timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.billing enable row level security;

create policy "read own billing" on public.billing
  for select to authenticated
  using (auth.uid() = user_id);

revoke all on public.billing from anon, authenticated;
grant select on public.billing to authenticated;
grant select, insert, update, delete on public.billing to service_role;

-- Processed Stripe event ids. A second delivery of the same event does nothing.
-- No policies: with row level security on and no policy, anon and authenticated
-- cannot read or write. The service role bypasses row level security.
create table public.stripe_events (
  id text primary key,
  type text not null,
  processed_at timestamptz not null default now()
);

alter table public.stripe_events enable row level security;

revoke all on public.stripe_events from anon, authenticated;
grant select, insert, delete on public.stripe_events to service_role;
