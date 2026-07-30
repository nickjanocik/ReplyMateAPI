import { type BillingInterval, type PlanId, planIdFromLookupKey } from "./plans.ts";

/**
 * Mapping a Stripe subscription onto a `subscriptions` row.
 *
 * Kept separate from the webhook handler because this is where the version
 * skew lives: the same logical field sits in different places depending on
 * which API version rendered the event, and that is only worth trusting if it
 * is covered by tests.
 */

type Unknown = Record<string, unknown>;

function record(value: unknown): Unknown | null {
  return value && typeof value === "object" ? value as Unknown : null;
}

export function unixToIso(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value * 1000).toISOString()
    : null;
}

export function firstItem(subscription: Unknown): Unknown | null {
  const items = record(subscription.items);
  const data = items?.data;
  return Array.isArray(data) ? record(data[0]) : null;
}

/**
 * Stripe moved `current_period_start` / `current_period_end` off the
 * subscription and onto each subscription *item* in the 2025-03-31 API version.
 * Which shape arrives depends on the API version pinned to the webhook
 * endpoint, not on the SDK, so both have to be read — and the item is checked
 * first because a modern payload omits the top-level fields entirely, which
 * would otherwise store nulls and leave every renewal date blank in the UI.
 */
export function subscriptionPeriod(subscription: Unknown): {
  start: string | null;
  end: string | null;
} {
  const item = firstItem(subscription);
  return {
    start: unixToIso(item?.current_period_start) ?? unixToIso(subscription.current_period_start),
    end: unixToIso(item?.current_period_end) ?? unixToIso(subscription.current_period_end),
  };
}

export interface SubscriptionPlanFields {
  planId: PlanId | null;
  priceId: string | null;
  lookupKey: string | null;
  interval: BillingInterval | null;
}

/**
 * The Price lookup key is the authoritative plan signal: it travels with the
 * line item the customer is actually being charged for. `metadata.plan` is only
 * a hint — it is copied once at checkout and is not rewritten when someone
 * switches plan in the Billing Portal, so trusting it first would leave an
 * upgraded customer on their old entitlements.
 */
export function subscriptionPlan(subscription: Unknown): SubscriptionPlanFields {
  const item = firstItem(subscription);
  const price = record(item?.price);
  const lookupKey = typeof price?.lookup_key === "string" ? price.lookup_key : null;
  const metadata = record(subscription.metadata) ?? {};

  const recurring = record(price?.recurring);
  const rawInterval = typeof recurring?.interval === "string" ? recurring.interval : null;

  const metadataPlan = typeof metadata.plan === "string" && metadata.plan ? metadata.plan : null;
  const planId = planIdFromLookupKey(lookupKey) ??
    planIdFromLookupKey(metadataPlan) ??
    knownPlanId(metadataPlan);

  return {
    planId,
    priceId: typeof price?.id === "string" ? price.id : null,
    lookupKey,
    interval: rawInterval === "year" ? "year" : rawInterval === "month" ? "month" : null,
  };
}

function knownPlanId(value: string | null): PlanId | null {
  const ids: PlanId[] = ["free", "starter", "growth", "scale", "enterprise"];
  return ids.find((id) => id === value) ?? null;
}

export interface SubscriptionRow {
  user_id: string;
  project_id: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string;
  plan: string | null;
  plan_id: PlanId | null;
  price_id: string | null;
  price_lookup_key: string | null;
  billing_interval: BillingInterval | null;
  status: string;
  cancel_at_period_end: boolean;
  trial_end: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  stripe_event_created_at: string;
}

export function buildSubscriptionRow(input: {
  subscription: Unknown;
  userId: string;
  eventType: string;
  eventCreatedAt: string;
}): SubscriptionRow {
  const { subscription } = input;
  const metadata = record(subscription.metadata) ?? {};
  const period = subscriptionPeriod(subscription);
  const plan = subscriptionPlan(subscription);

  return {
    user_id: input.userId,
    project_id: typeof metadata.project_id === "string" && metadata.project_id
      ? metadata.project_id
      : null,
    stripe_customer_id: typeof subscription.customer === "string"
      ? subscription.customer
      // An expanded customer arrives as an object rather than an id string.
      : (record(subscription.customer)?.id as string | undefined) ?? null,
    stripe_subscription_id: String(subscription.id ?? ""),
    plan: plan.lookupKey ?? plan.planId ??
      (typeof metadata.plan === "string" ? metadata.plan : null),
    plan_id: plan.planId,
    price_id: plan.priceId,
    price_lookup_key: plan.lookupKey,
    billing_interval: plan.interval,
    // `customer.subscription.deleted` can still carry status "active" in the
    // payload; the event type is what actually says the subscription is gone.
    status: input.eventType === "customer.subscription.deleted"
      ? "canceled"
      : String(subscription.status ?? "unknown"),
    cancel_at_period_end: subscription.cancel_at_period_end === true,
    trial_end: unixToIso(subscription.trial_end),
    current_period_start: period.start,
    current_period_end: period.end,
    stripe_event_created_at: input.eventCreatedAt,
  };
}

/** Subscription lifecycle events the webhook acts on. */
export const HANDLED_SUBSCRIPTION_EVENTS = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
]);
