import type { SupabaseClient } from "@supabase/supabase-js";
import { ApiError } from "./errors.ts";
import { chooseCurrentSubscription } from "./account.ts";
import {
  entitlementsFor,
  formatLimit,
  type Plan,
  type PlanId,
  planIdFromLookupKey,
  PLANS,
  UNLIMITED,
  withinLimit,
} from "./plans.ts";
import type { JsonRecord } from "./types.ts";

/**
 * Resolving what a user is allowed to do right now, and refusing the request
 * when they are not.
 *
 * Entitlements are always read from the database at request time. Nothing here
 * trusts a claim on the JWT or a field on the request body — a client that
 * could assert its own tier would be a free upgrade button.
 */

export interface BillingUsage {
  repliesSent: number;
  projectsActive: number;
  contactsTotal: number;
  estimatedCost: number;
}

export interface Entitlement {
  plan: Plan;
  /** True when a paid subscription is currently in good standing. */
  entitled: boolean;
  status: string;
  subscription: JsonRecord | null;
  periodStart: string;
  periodEnd: string | null;
  usage: BillingUsage;
}

const EMPTY_USAGE: BillingUsage = {
  repliesSent: 0,
  projectsActive: 0,
  contactsTotal: 0,
  estimatedCost: 0,
};

/**
 * Free accounts have no Stripe period, so the meter has to reset on something.
 * A calendar month is the only boundary the user can predict without an
 * invoice to look at.
 */
export function calendarMonthStart(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/**
 * A subscription's period start is the right meter boundary, but only while it
 * is current. Stripe stops advancing the period once a subscription ends, so a
 * cancelled row would otherwise pin the window open forever and let a lapsed
 * customer keep spending against a period that never rolls over.
 */
export function meterStart(
  subscription: JsonRecord | null,
  now = new Date(),
): string {
  const start = subscription?.current_period_start;
  const end = subscription?.current_period_end;
  if (typeof start !== "string") return calendarMonthStart(now);
  if (typeof end === "string" && Date.parse(end) < now.getTime()) return calendarMonthStart(now);
  return start;
}

export function planIdFromSubscription(subscription: JsonRecord | null): PlanId | null {
  if (!subscription) return null;
  const stored = subscription.plan_id;
  if (typeof stored === "string" && stored in PLANS) return stored as PlanId;
  // Older rows predate plan_id; fall back the same way the webhook resolves it.
  return planIdFromLookupKey(
    typeof subscription.price_lookup_key === "string" ? subscription.price_lookup_key : null,
  ) ?? planIdFromLookupKey(typeof subscription.plan === "string" ? subscription.plan : null);
}

export async function loadEntitlement(
  admin: SupabaseClient,
  userId: string,
  options: { withUsage?: boolean } = {},
): Promise<Entitlement> {
  const { data, error } = await admin.from("subscriptions")
    .select(
      "id,plan,plan_id,price_id,price_lookup_key,billing_interval,status,cancel_at_period_end," +
        "trial_end,stripe_customer_id,stripe_subscription_id,current_period_start," +
        "current_period_end,created_at",
    )
    .eq("user_id", userId);
  if (error) {
    throw new ApiError(500, "DATABASE_ERROR", "Could not read your subscription.", error.message);
  }

  const subscription = chooseCurrentSubscription((data ?? []) as unknown as JsonRecord[]);
  const status = typeof subscription?.status === "string" ? subscription.status : "free";
  const { plan, entitled } = entitlementsFor(planIdFromSubscription(subscription), status);
  const periodStart = meterStart(subscription);

  return {
    plan,
    entitled,
    status: entitled ? status : "free",
    subscription,
    periodStart,
    periodEnd: typeof subscription?.current_period_end === "string"
      ? subscription.current_period_end
      : null,
    usage: options.withUsage === false ? EMPTY_USAGE : await loadUsage(admin, userId, periodStart),
  };
}

export async function loadUsage(
  admin: SupabaseClient,
  userId: string,
  since: string,
): Promise<BillingUsage> {
  const { data, error } = await admin.rpc("billing_period_usage", {
    p_user_id: userId,
    p_since: since,
  });
  if (error) {
    // Usage is informational on read paths and advisory on write paths. Failing
    // the whole request because a count could not be produced would take the
    // product down over a reporting query, so degrade to zero and log instead.
    console.error("billing_period_usage failed", error.message);
    return EMPTY_USAGE;
  }
  const row = (Array.isArray(data) ? data[0] : data) as JsonRecord | undefined;
  return {
    repliesSent: Number(row?.replies_sent ?? 0),
    projectsActive: Number(row?.projects_active ?? 0),
    contactsTotal: Number(row?.contacts_total ?? 0),
    estimatedCost: Number(row?.estimated_cost ?? 0),
  };
}

function upgradeHint(current: PlanId): string {
  switch (current) {
    case "free":
      return "Start a Starter plan to connect a number and raise the limit.";
    case "starter":
      return "Upgrade to Growth for 2,000 replies a month across 3 projects.";
    case "growth":
      return "Upgrade to Scale for 6,000 replies a month across 10 projects.";
    default:
      return "Contact us to arrange a custom volume.";
  }
}

export function assertProjectAllowance(entitlement: Entitlement): void {
  const limit = entitlement.plan.entitlements.projects;
  if (withinLimit(entitlement.usage.projectsActive, limit)) return;
  throw new ApiError(
    402,
    "PLAN_LIMIT_REACHED",
    `${entitlement.plan.name} includes ${formatLimit(limit)} active project${
      limit === 1 ? "" : "s"
    }, and you have ${entitlement.usage.projectsActive}. ${upgradeHint(entitlement.plan.id)}`,
    { limit_type: "projects", limit, used: entitlement.usage.projectsActive },
  );
}

export interface ReplyAllowance {
  allowed: boolean;
  /** Charged per reply once the included allowance is used up. */
  overagePerReply: number;
  remaining: number;
  limit: number;
  used: number;
}

/**
 * Replies past the included allowance are billed as overage rather than
 * blocked, on every plan that has an overage rate. Silently dropping a reply to
 * a real person who texted a business is a worse failure than an unexpected
 * line on an invoice — Free is the exception, because it has no card on file to
 * charge and so has to be a hard stop.
 */
export function replyAllowance(entitlement: Entitlement): ReplyAllowance {
  const { repliesPerMonth, overagePerReply } = entitlement.plan.entitlements;
  const used = entitlement.usage.repliesSent;
  const remaining = repliesPerMonth === UNLIMITED
    ? Number.MAX_SAFE_INTEGER
    : Math.max(0, repliesPerMonth - used);
  const withinIncluded = withinLimit(used, repliesPerMonth);
  return {
    allowed: withinIncluded || overagePerReply > 0,
    overagePerReply: withinIncluded ? 0 : overagePerReply,
    remaining,
    limit: repliesPerMonth,
    used,
  };
}

export function assertReplyAllowance(entitlement: Entitlement): ReplyAllowance {
  const allowance = replyAllowance(entitlement);
  if (allowance.allowed) return allowance;
  throw new ApiError(
    402,
    "REPLY_QUOTA_EXHAUSTED",
    `You have used all ${
      formatLimit(allowance.limit)
    } replies included with ${entitlement.plan.name} this period. ${
      upgradeHint(entitlement.plan.id)
    }`,
    { limit_type: "replies", limit: allowance.limit, used: allowance.used },
  );
}

/** Shape returned to the browser by /v1-billing and /v1-account. */
export function entitlementSummary(entitlement: Entitlement): JsonRecord {
  const { plan, usage } = entitlement;
  const allowance = replyAllowance(entitlement);
  return {
    plan_id: plan.id,
    name: plan.name,
    status: entitlement.status,
    entitled: entitlement.entitled,
    interval: entitlement.subscription?.billing_interval ?? null,
    cancel_at_period_end: Boolean(entitlement.subscription?.cancel_at_period_end),
    trial_end: entitlement.subscription?.trial_end ?? null,
    current_period_start: entitlement.subscription?.current_period_start ?? entitlement.periodStart,
    current_period_end: entitlement.periodEnd,
    meter_start: entitlement.periodStart,
    entitlements: plan.entitlements,
    usage: {
      replies_sent: usage.repliesSent,
      replies_included: plan.entitlements.repliesPerMonth,
      replies_remaining: allowance.limit === UNLIMITED ? null : allowance.remaining,
      projects_active: usage.projectsActive,
      projects_included: plan.entitlements.projects,
      contacts_total: usage.contactsTotal,
      estimated_provider_cost: Number(usage.estimatedCost.toFixed(6)),
    },
  };
}
