import { ApiError } from "./errors.ts";

/**
 * The plan catalog, and the unit costs it was derived from.
 *
 * This module is the *enforcement* authority: entitlements checked at request
 * time come from here, never from anything the client sends. The frontend keeps
 * a display mirror at `lib/plans.ts`; the amount actually charged always comes
 * from the Stripe Price, so a drifted marketing number can never overcharge.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Unit costs (verified 2026-07-29). Every tier below is sized against these.
 *
 * Twilio US outbound SMS      $0.0083 / segment   twilio.com/en-us/sms/pricing/us
 * Twilio US inbound SMS       $0.0083 / segment   (same)
 * A2P 10DLC carrier surcharge $0.0030 / segment   (pass-through, 0.0025–0.007)
 * Twilio long-code number     $1.15   / month
 * A2P low-volume campaign     $10.50  / month     (+$44 brand, +$15 vetting once)
 * Gemini 3.1 Flash-Lite       $0.25/Mtok in, $1.50/Mtok out
 * gemini-embedding-001        $0.15/Mtok
 * Stripe                      2.9% + $0.30 per charge
 *
 * These are recorded so the numbers can be re-checked rather than trusted, and
 * so a price change has one obvious place to land. They are documentation, not
 * live billing inputs — actual spend is metered from `usage_ledger`.
 * ──────────────────────────────────────────────────────────────────────────── */
export const UNIT_COSTS = {
  smsOutboundPerSegment: 0.0083,
  smsInboundPerSegment: 0.0083,
  carrierSurchargePerSegment: 0.003,
  phoneNumberPerMonth: 1.15,
  campaignPerMonth: 10.5,
  geminiInputPerMTok: 0.25,
  geminiOutputPerMTok: 1.5,
  geminiEmbeddingPerMTok: 0.15,
  stripePercent: 0.029,
  stripeFixed: 0.3,
} as const;

/**
 * One AI reply costs: 1 inbound segment + ~2 outbound segments (a useful reply
 * runs past the 153-char concatenated-GSM7 boundary) + retrieval + generation.
 *
 *   inbound     0.0083
 *   outbound    2 x (0.0083 + 0.0030)  = 0.0226
 *   embedding   ~40 tok @ 0.15/M       = 0.000006
 *   generation  ~1800 in + 60 out      = 0.00054
 *                                      ≈ 0.0315
 *
 * The model is ~2% of a reply; SMS is ~97%. That is the single most important
 * fact about this business's margins, and it is why tiers meter *replies* and
 * not tokens.
 */
export const COST_PER_REPLY = 0.0315;

export type PlanId = "free" | "starter" | "growth" | "scale" | "enterprise";
export type BillingInterval = "month" | "year";

export interface PlanEntitlements {
  /** Monthly outbound AI replies included. */
  repliesPerMonth: number;
  /** Concurrent active projects. */
  projects: number;
  /** Registered 10DLC numbers. */
  phoneNumbers: number;
  /** Knowledge sources per project. */
  knowledgeSources: number;
  /** Charged per reply beyond `repliesPerMonth`; 0 disables overage (hard cap). */
  overagePerReply: number;
  seats: number;
  analytics: boolean;
  prioritySupport: boolean;
  /** Whether A2P brand + campaign registration is handled for the customer. */
  managedRegistration: boolean;
}

export interface Plan {
  id: PlanId;
  name: string;
  blurb: string;
  /** USD/month when billed monthly. `null` means "talk to us". */
  monthlyPrice: number | null;
  /** USD/year when billed annually — 10x monthly, i.e. two months free. */
  annualPrice: number | null;
  /** Stripe Price lookup keys, resolved at checkout. */
  lookupKeys: Record<BillingInterval, string> | null;
  trialDays: number;
  entitlements: PlanEntitlements;
  featured: boolean;
}

/**
 * `Infinity` would not survive JSON, so "unlimited" is this sentinel. Anything
 * comparing against a limit must go through `withinLimit`.
 */
export const UNLIMITED = -1;

export function withinLimit(used: number, limit: number): boolean {
  return limit === UNLIMITED || used < limit;
}

export function formatLimit(limit: number): string {
  return limit === UNLIMITED ? "Unlimited" : limit.toLocaleString("en-US");
}

export const PLANS: Readonly<Record<PlanId, Plan>> = {
  free: {
    id: "free",
    name: "Free",
    blurb: "Build and test an agent before you connect a number.",
    monthlyPrice: 0,
    annualPrice: 0,
    lookupKeys: null,
    trialDays: 0,
    featured: false,
    entitlements: {
      // No number, no campaign: web-chat testing only, so this costs us the
      // model calls and nothing else. 25 replies is roughly $0.02 of spend.
      repliesPerMonth: 25,
      projects: 1,
      phoneNumbers: 0,
      knowledgeSources: 5,
      overagePerReply: 0,
      seats: 1,
      analytics: false,
      prioritySupport: false,
      managedRegistration: false,
    },
  },
  starter: {
    id: "starter",
    name: "Starter",
    blurb: "One number, one agent, answering the questions you keep retyping.",
    monthlyPrice: 79,
    annualPrice: 790,
    lookupKeys: { month: "replymate_starter_monthly", year: "replymate_starter_annual" },
    trialDays: 14,
    featured: false,
    entitlements: {
      // 500 x $0.0315 = $15.75 variable, + $11.65 number/campaign, + $2.59
      // Stripe = $29.99 at full use → 62% gross margin, ~76% at typical use.
      repliesPerMonth: 500,
      projects: 1,
      phoneNumbers: 1,
      knowledgeSources: 25,
      overagePerReply: 0.12,
      seats: 2,
      analytics: false,
      prioritySupport: false,
      managedRegistration: true,
    },
  },
  growth: {
    id: "growth",
    name: "Growth",
    blurb: "Several properties or locations, each with its own agent and number.",
    monthlyPrice: 199,
    annualPrice: 1990,
    lookupKeys: { month: "replymate_growth_monthly", year: "replymate_growth_annual" },
    trialDays: 14,
    featured: true,
    entitlements: {
      // 2000 x $0.0315 = $63.00, + $12.80 numbers/campaign, + $6.07 Stripe
      // = $81.87 at full use → 59% gross margin, ~74% at typical use.
      repliesPerMonth: 2000,
      projects: 3,
      phoneNumbers: 2,
      knowledgeSources: 100,
      overagePerReply: 0.09,
      seats: 5,
      analytics: true,
      prioritySupport: true,
      managedRegistration: true,
    },
  },
  scale: {
    id: "scale",
    name: "Scale",
    blurb: "High inbound volume across a portfolio, with reporting to match.",
    monthlyPrice: 499,
    annualPrice: 4990,
    lookupKeys: { month: "replymate_scale_monthly", year: "replymate_scale_annual" },
    trialDays: 14,
    featured: false,
    entitlements: {
      // 6000 x $0.0315 = $189.00, + $16.25 numbers/campaign, + $14.77 Stripe
      // = $220.02 at full use → 56% gross margin, ~72% at typical use.
      repliesPerMonth: 6000,
      projects: 10,
      phoneNumbers: 5,
      knowledgeSources: 500,
      overagePerReply: 0.07,
      seats: 15,
      analytics: true,
      prioritySupport: true,
      managedRegistration: true,
    },
  },
  enterprise: {
    id: "enterprise",
    name: "Enterprise",
    blurb: "Custom volume, custom terms, and a human who knows your account.",
    monthlyPrice: null,
    annualPrice: null,
    lookupKeys: null,
    trialDays: 0,
    featured: false,
    entitlements: {
      repliesPerMonth: UNLIMITED,
      projects: UNLIMITED,
      phoneNumbers: UNLIMITED,
      knowledgeSources: UNLIMITED,
      overagePerReply: 0.05,
      seats: UNLIMITED,
      analytics: true,
      prioritySupport: true,
      managedRegistration: true,
    },
  },
};

/** Ordered for display, cheapest first. */
export const PLAN_ORDER: readonly PlanId[] = ["free", "starter", "growth", "scale", "enterprise"];

/** Plans a customer can buy with a card, i.e. everything with a Stripe price. */
export const PURCHASABLE_PLAN_IDS = PLAN_ORDER.filter((id) => PLANS[id].lookupKeys !== null);

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === "string" && value in PLANS;
}

export function getPlan(id: PlanId): Plan {
  return PLANS[id];
}

export function requirePurchasablePlan(value: unknown): Plan {
  if (!isPlanId(value)) {
    throw new ApiError(
      400,
      "UNKNOWN_PLAN",
      `Unknown plan. Choose one of: ${PURCHASABLE_PLAN_IDS.join(", ")}.`,
    );
  }
  const plan = PLANS[value];
  if (!plan.lookupKeys) {
    throw new ApiError(
      400,
      "PLAN_NOT_PURCHASABLE",
      `${plan.name} is not self-serve. Contact sales to arrange it.`,
    );
  }
  return plan;
}

export function requireInterval(value: unknown): BillingInterval {
  if (value === undefined || value === null || value === "month") return "month";
  if (value === "year") return "year";
  throw new ApiError(400, "VALIDATION_ERROR", "interval must be month or year.");
}

/**
 * Stripe subscriptions carry `metadata.plan`, but metadata is writable from the
 * dashboard and can go stale after a plan change made in the Billing Portal.
 * The Price lookup key travels with the actual line item, so it is the more
 * trustworthy of the two; `metadata.plan` is only the fallback.
 */
export function planIdFromLookupKey(lookupKey: string | null | undefined): PlanId | null {
  if (!lookupKey) return null;
  for (const id of PLAN_ORDER) {
    const keys = PLANS[id].lookupKeys;
    if (!keys) continue;
    if (keys.month === lookupKey || keys.year === lookupKey) return id;
  }
  return null;
}

/**
 * Which entitlements apply right now.
 *
 * `past_due` deliberately keeps full entitlements: Stripe retries a failed card
 * for over a week, and cutting a business's phone line off on the first retry
 * costs far more in churn than the handful of replies it saves. `unpaid` and
 * `canceled` fall back to Free.
 */
const ENTITLED_STATUSES = new Set(["active", "trialing", "past_due"]);

export function entitlementsFor(
  planId: PlanId | null | undefined,
  status: string | null | undefined,
): { plan: Plan; entitled: boolean } {
  const plan = planId && isPlanId(planId) ? PLANS[planId] : PLANS.free;
  const entitled = Boolean(status && ENTITLED_STATUSES.has(status));
  if (!entitled || plan.id === "free") return { plan: PLANS.free, entitled: false };
  return { plan, entitled: true };
}
