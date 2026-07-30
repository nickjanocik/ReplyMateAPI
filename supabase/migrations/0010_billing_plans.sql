-- Stripe subscription billing and plan entitlements.
--
-- 0002 created `subscriptions` as a scaffold that only the webhook wrote to.
-- Self-serve checkout needs three more things: a stable Stripe customer per
-- user (so a second purchase does not mint a duplicate customer and orphan the
-- first card), the plan/price identity that entitlements are read from, and a
-- cheap way to count metered usage inside the current billing period.

-- ── Stripe customers ────────────────────────────────────────────────────────
-- Kept out of `profiles` because a profile row is user-editable and this is
-- billing identity. One customer per user, enforced by the primary key.
create table public.billing_customers (
  user_id uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.billing_customers is
  'One Stripe customer per user. Written only by the service role during checkout.';

alter table public.billing_customers enable row level security;

create policy billing_customers_select_own on public.billing_customers
  for select to authenticated
  using (user_id = (select auth.uid()));

grant select on public.billing_customers to authenticated;
grant all on public.billing_customers to service_role;

create trigger billing_customers_touch_updated_at before update on public.billing_customers
  for each row execute function public.touch_updated_at();

-- ── Subscription plan identity ──────────────────────────────────────────────
-- `plan` already existed as free text. `plan_id` is the constrained value that
-- entitlements key off, so an unrecognised Stripe price can never silently
-- grant a tier: it lands as null and the account falls back to Free.
alter table public.subscriptions
  add column plan_id text check (
    plan_id is null or plan_id in ('free', 'starter', 'growth', 'scale', 'enterprise')
  ),
  add column price_id text,
  add column price_lookup_key text,
  add column billing_interval text check (
    billing_interval is null or billing_interval in ('month', 'year')
  ),
  add column cancel_at_period_end boolean not null default false,
  add column trial_end timestamptz;

comment on column public.subscriptions.plan_id is
  'Entitlement tier, resolved from the Stripe price lookup key. Null means no recognised tier; treat as Free.';
comment on column public.subscriptions.price_lookup_key is
  'Stripe Price lookup_key. Authoritative over metadata.plan, which goes stale after a Billing Portal plan change.';

-- A user browsing /account reads their own subscription on every page load.
create index subscriptions_user_status_idx
  on public.subscriptions (user_id, status);

-- ── Metered usage ───────────────────────────────────────────────────────────
-- The reply meter scans outbound_messages by project and date, which
-- `outbound_messages_project_created_idx` (0002) already covers.

/*
 * Usage inside one billing period, for every project the user owns.
 *
 * Failed sends are excluded from `replies_sent`: the carrier fee is still
 * incurred, but charging a customer's allowance for a message that never
 * arrived is the kind of thing that produces support tickets and refunds. We
 * absorb it — it is a fraction of a cent, and it keeps the meter defensible.
 *
 * Service-role only. The edge function is the sole caller and already runs
 * with the caller's identity resolved, so there is no reason to expose a
 * function that takes an arbitrary user id to `authenticated`.
 */
create or replace function public.billing_period_usage(
  p_user_id uuid,
  p_since timestamptz
)
returns table (
  replies_sent bigint,
  projects_active bigint,
  contacts_total bigint,
  estimated_cost numeric
)
language sql
stable
set search_path = public, extensions
as $$
  select
    (
      select count(*)
      from public.outbound_messages om
      join public.projects p on p.id = om.project_id
      where p.owner_id = p_user_id
        and om.created_at >= p_since
        and coalesce(om.status, '') not in ('failed', 'undelivered')
    ),
    (
      select count(*)
      from public.projects p
      where p.owner_id = p_user_id
        and p.status = 'active'
    ),
    (
      select count(*)
      from public.contacts c
      join public.projects p on p.id = c.project_id
      where p.owner_id = p_user_id
    ),
    (
      select coalesce(sum(u.estimated_cost), 0)
      from public.usage_ledger u
      join public.projects p on p.id = u.project_id
      where p.owner_id = p_user_id
        and u.created_at >= p_since
    );
$$;

revoke all on function public.billing_period_usage(uuid, timestamptz) from public;
grant execute on function public.billing_period_usage(uuid, timestamptz) to service_role;
