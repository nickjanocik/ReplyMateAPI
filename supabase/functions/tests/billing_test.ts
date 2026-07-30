import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import {
  buildSubscriptionRow,
  HANDLED_SUBSCRIPTION_EVENTS,
  subscriptionPeriod,
  subscriptionPlan,
  unixToIso,
} from "../_shared/billingSync.ts";
import {
  assertProjectAllowance,
  assertReplyAllowance,
  calendarMonthStart,
  type Entitlement,
  entitlementSummary,
  meterStart,
  planIdFromSubscription,
  replyAllowance,
} from "../_shared/entitlements.ts";
import { PLANS } from "../_shared/plans.ts";
import { safeReturnUrl } from "../_shared/stripe.ts";
import { ApiError } from "../_shared/errors.ts";

const JAN = 1_767_225_600; // 2026-01-01T00:00:00Z
const FEB = 1_769_904_000; // 2026-02-01T00:00:00Z

/* ── Stripe payload mapping ─────────────────────────────────────────────── */

Deno.test("period is read from the subscription item, where Stripe now puts it", () => {
  // 2025-03-31 and later: the top-level fields are simply absent.
  const modern = {
    id: "sub_1",
    items: {
      data: [{
        current_period_start: JAN,
        current_period_end: FEB,
        price: { id: "price_1", lookup_key: "replymate_growth_monthly" },
      }],
    },
  };
  const period = subscriptionPeriod(modern);
  assertEquals(period.start, "2026-01-01T00:00:00.000Z");
  assertEquals(period.end, "2026-02-01T00:00:00.000Z");
});

Deno.test("period still resolves from a pre-2025 top-level payload", () => {
  const legacy = {
    id: "sub_1",
    current_period_start: JAN,
    current_period_end: FEB,
    items: { data: [{ price: { id: "price_1" } }] },
  };
  const period = subscriptionPeriod(legacy);
  assertEquals(period.start, "2026-01-01T00:00:00.000Z");
  assertEquals(period.end, "2026-02-01T00:00:00.000Z");
});

Deno.test("a subscription with no items yields nulls rather than throwing", () => {
  assertEquals(subscriptionPeriod({ id: "sub_1" }), { start: null, end: null });
  assertEquals(subscriptionPeriod({ id: "sub_1", items: { data: [] } }).start, null);
});

Deno.test("unixToIso rejects non-finite and non-numeric input", () => {
  assertEquals(unixToIso(JAN), "2026-01-01T00:00:00.000Z");
  assertEquals(unixToIso(null), null);
  assertEquals(unixToIso("1767225600"), null);
  assertEquals(unixToIso(Number.NaN), null);
  assertEquals(unixToIso(Number.POSITIVE_INFINITY), null);
});

Deno.test("the price lookup key beats stale metadata after a portal plan change", () => {
  // Customer bought Starter, then upgraded to Growth in the Billing Portal.
  // Stripe does not rewrite subscription metadata, so it still says starter.
  const upgraded = {
    id: "sub_1",
    metadata: { plan: "starter", supabase_user_id: "user-1" },
    items: {
      data: [{
        price: {
          id: "price_growth",
          lookup_key: "replymate_growth_monthly",
          recurring: { interval: "month" },
        },
      }],
    },
  };
  const plan = subscriptionPlan(upgraded);
  assertEquals(plan.planId, "growth");
  assertEquals(plan.priceId, "price_growth");
  assertEquals(plan.interval, "month");
});

Deno.test("metadata is the fallback when the price carries no lookup key", () => {
  const plan = subscriptionPlan({
    id: "sub_1",
    metadata: { plan: "scale" },
    items: { data: [{ price: { id: "price_x", recurring: { interval: "year" } } }] },
  });
  assertEquals(plan.planId, "scale");
  assertEquals(plan.interval, "year");
});

Deno.test("an unrecognised price grants no tier at all", () => {
  // Someone attaching an unrelated Stripe price must not accidentally be
  // entitled to the top tier; null means the account reads as Free.
  const plan = subscriptionPlan({
    id: "sub_1",
    metadata: {},
    items: { data: [{ price: { id: "price_y", lookup_key: "some_other_product" } }] },
  });
  assertEquals(plan.planId, null);
  assertEquals(plan.lookupKey, "some_other_product");
});

Deno.test("deletion is canceled regardless of the status in the payload", () => {
  const row = buildSubscriptionRow({
    subscription: { id: "sub_1", status: "active", items: { data: [] } },
    userId: "user-1",
    eventType: "customer.subscription.deleted",
    eventCreatedAt: "2026-02-01T00:00:00.000Z",
  });
  assertEquals(row.status, "canceled");
});

Deno.test("buildSubscriptionRow captures trial, cancellation and an expanded customer", () => {
  const row = buildSubscriptionRow({
    subscription: {
      id: "sub_1",
      status: "trialing",
      cancel_at_period_end: true,
      trial_end: FEB,
      // Expanded rather than an id string — the shape you get with expand[].
      customer: { id: "cus_123", object: "customer" },
      metadata: { supabase_user_id: "user-1", project_id: "proj-1" },
      items: {
        data: [{
          current_period_start: JAN,
          current_period_end: FEB,
          price: {
            id: "price_starter",
            lookup_key: "replymate_starter_annual",
            recurring: { interval: "year" },
          },
        }],
      },
    },
    userId: "user-1",
    eventType: "customer.subscription.updated",
    eventCreatedAt: "2026-01-15T00:00:00.000Z",
  });

  assertEquals(row.stripe_customer_id, "cus_123");
  assertEquals(row.plan_id, "starter");
  assertEquals(row.billing_interval, "year");
  assertEquals(row.cancel_at_period_end, true);
  assertEquals(row.trial_end, "2026-02-01T00:00:00.000Z");
  assertEquals(row.project_id, "proj-1");
  assertEquals(row.current_period_end, "2026-02-01T00:00:00.000Z");
});

Deno.test("cancel_at_period_end is only true when Stripe says exactly true", () => {
  const build = (value: unknown) =>
    buildSubscriptionRow({
      subscription: { id: "s", cancel_at_period_end: value, items: { data: [] } },
      userId: "u",
      eventType: "customer.subscription.updated",
      eventCreatedAt: "2026-01-01T00:00:00.000Z",
    }).cancel_at_period_end;

  assertEquals(build(true), true);
  assertEquals(build(false), false);
  assertEquals(build(undefined), false);
  assertEquals(build("true"), false);
});

Deno.test("only subscription lifecycle events are handled", () => {
  assert(HANDLED_SUBSCRIPTION_EVENTS.has("customer.subscription.created"));
  assert(HANDLED_SUBSCRIPTION_EVENTS.has("customer.subscription.deleted"));
  assert(!HANDLED_SUBSCRIPTION_EVENTS.has("invoice.paid"));
  assert(!HANDLED_SUBSCRIPTION_EVENTS.has("checkout.session.completed"));
});

/* ── Entitlement resolution ─────────────────────────────────────────────── */

function entitlement(overrides: Partial<Entitlement> = {}): Entitlement {
  return {
    plan: PLANS.free,
    entitled: false,
    status: "free",
    subscription: null,
    periodStart: "2026-07-01T00:00:00.000Z",
    periodEnd: null,
    usage: { repliesSent: 0, projectsActive: 0, contactsTotal: 0, estimatedCost: 0 },
    ...overrides,
  };
}

Deno.test("meterStart uses the Stripe period while it is current", () => {
  const now = new Date("2026-07-15T00:00:00Z");
  assertEquals(
    meterStart({
      current_period_start: "2026-07-04T00:00:00.000Z",
      current_period_end: "2026-08-04T00:00:00.000Z",
    }, now),
    "2026-07-04T00:00:00.000Z",
  );
});

Deno.test("meterStart abandons a period that has already ended", () => {
  // A cancelled subscription stops advancing. Left alone it would pin the
  // window open and let a lapsed account keep spending against one period.
  const now = new Date("2026-07-15T00:00:00Z");
  assertEquals(
    meterStart({
      current_period_start: "2026-01-01T00:00:00.000Z",
      current_period_end: "2026-02-01T00:00:00.000Z",
    }, now),
    "2026-07-01T00:00:00.000Z",
  );
});

Deno.test("meterStart falls back to the calendar month with no subscription", () => {
  const now = new Date("2026-07-15T12:34:56Z");
  assertEquals(meterStart(null, now), "2026-07-01T00:00:00.000Z");
  assertEquals(calendarMonthStart(now), "2026-07-01T00:00:00.000Z");
});

Deno.test("planIdFromSubscription prefers plan_id, then the lookup key", () => {
  assertEquals(planIdFromSubscription({ plan_id: "scale" }), "scale");
  assertEquals(
    planIdFromSubscription({ price_lookup_key: "replymate_growth_annual" }),
    "growth",
  );
  // Legacy rows stored the lookup key in `plan`.
  assertEquals(planIdFromSubscription({ plan: "replymate_starter_monthly" }), "starter");
  assertEquals(planIdFromSubscription({ plan_id: "platinum" }), null);
  assertEquals(planIdFromSubscription(null), null);
});

Deno.test("paid plans absorb an overrun as overage instead of dropping the reply", () => {
  const growth = entitlement({
    plan: PLANS.growth,
    entitled: true,
    status: "active",
    usage: { repliesSent: 2000, projectsActive: 1, contactsTotal: 0, estimatedCost: 0 },
  });
  const allowance = replyAllowance(growth);
  assertEquals(allowance.allowed, true);
  assertEquals(allowance.remaining, 0);
  assertEquals(allowance.overagePerReply, PLANS.growth.entitlements.overagePerReply);
  assertReplyAllowance(growth); // must not throw
});

Deno.test("a paid plan under its allowance is charged no overage", () => {
  const allowance = replyAllowance(entitlement({
    plan: PLANS.growth,
    entitled: true,
    usage: { repliesSent: 1999, projectsActive: 1, contactsTotal: 0, estimatedCost: 0 },
  }));
  assertEquals(allowance.overagePerReply, 0);
  assertEquals(allowance.remaining, 1);
});

Deno.test("free is a hard stop, because there is no card to charge", () => {
  const exhausted = entitlement({
    usage: { repliesSent: 25, projectsActive: 1, contactsTotal: 0, estimatedCost: 0 },
  });
  assertEquals(replyAllowance(exhausted).allowed, false);
  const error = assertThrows(() => assertReplyAllowance(exhausted), ApiError);
  assertEquals(error.status, 402);
  assertEquals(error.code, "REPLY_QUOTA_EXHAUSTED");
});

Deno.test("unlimited plans never exhaust", () => {
  const allowance = replyAllowance(entitlement({
    plan: PLANS.enterprise,
    entitled: true,
    usage: { repliesSent: 5_000_000, projectsActive: 40, contactsTotal: 0, estimatedCost: 0 },
  }));
  assertEquals(allowance.allowed, true);
  assertEquals(allowance.overagePerReply, 0);
});

Deno.test("project allowance refuses at the limit and names the upgrade", () => {
  const atLimit = entitlement({
    plan: PLANS.starter,
    entitled: true,
    usage: { repliesSent: 0, projectsActive: 1, contactsTotal: 0, estimatedCost: 0 },
  });
  const error = assertThrows(() => assertProjectAllowance(atLimit), ApiError);
  assertEquals(error.status, 402);
  assertEquals(error.code, "PLAN_LIMIT_REACHED");
  assert(error.message.includes("Growth"), "should point at the next tier up");

  // One below the limit is fine.
  assertProjectAllowance(entitlement({
    plan: PLANS.starter,
    entitled: true,
    usage: { repliesSent: 0, projectsActive: 0, contactsTotal: 0, estimatedCost: 0 },
  }));
});

Deno.test("entitlementSummary reports remaining as null when unlimited", () => {
  const summary = entitlementSummary(entitlement({ plan: PLANS.enterprise, entitled: true }));
  assertEquals((summary.usage as Record<string, unknown>).replies_remaining, null);

  const capped = entitlementSummary(entitlement({
    plan: PLANS.starter,
    entitled: true,
    usage: { repliesSent: 120, projectsActive: 1, contactsTotal: 3, estimatedCost: 1.23 },
  }));
  assertEquals((capped.usage as Record<string, unknown>).replies_remaining, 380);
  assertEquals(capped.plan_id, "starter");
});

/* ── Return-URL safety ──────────────────────────────────────────────────── */

Deno.test("checkout return URLs cannot be redirected off our origin", () => {
  const origin = "https://app.example.com";
  assertEquals(
    safeReturnUrl("https://evil.test/steal", origin, "/account"),
    "https://app.example.com/account",
  );
  assertEquals(
    safeReturnUrl("//evil.test", origin, "/account"),
    "https://app.example.com/account",
  );
  assertEquals(
    safeReturnUrl("javascript:alert(1)", origin, "/account"),
    "https://app.example.com/account",
  );
  // A same-origin relative path is honoured.
  assertEquals(
    safeReturnUrl("/dashboard?welcome=1", origin, "/account"),
    "https://app.example.com/dashboard?welcome=1",
  );
  // So is a same-origin absolute URL.
  assertEquals(
    safeReturnUrl("https://app.example.com/pricing", origin, "/account"),
    "https://app.example.com/pricing",
  );
  // Missing or blank input takes the default path.
  assertEquals(safeReturnUrl(undefined, origin, "/account"), "https://app.example.com/account");
  assertEquals(safeReturnUrl("  ", origin, "/account"), "https://app.example.com/account");
  assertEquals(safeReturnUrl(42, origin, "/account"), "https://app.example.com/account");
});

Deno.test("a trailing slash on the origin does not double up in the fallback", () => {
  assertEquals(
    safeReturnUrl(undefined, "https://app.example.com/", "/account"),
    "https://app.example.com/account",
  );
});
