import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import {
  COST_PER_REPLY,
  entitlementsFor,
  formatLimit,
  isPlanId,
  PLAN_ORDER,
  planIdFromLookupKey,
  PLANS,
  PURCHASABLE_PLAN_IDS,
  requireInterval,
  requirePurchasablePlan,
  UNIT_COSTS,
  UNLIMITED,
  withinLimit,
} from "../_shared/plans.ts";
import { ApiError } from "../_shared/errors.ts";

/**
 * The catalog is a pricing decision expressed as data, so these tests assert
 * the properties that decision relies on. If a future edit makes a tier
 * unprofitable or non-monotonic, that is a business bug and it should fail
 * here rather than on an invoice.
 */

const STRIPE_FEE = (price: number) => price * UNIT_COSTS.stripePercent + UNIT_COSTS.stripeFixed;

/** Number + campaign, the floor we pay for a customer who sends nothing at all. */
function fixedMonthlyCost(phoneNumbers: number): number {
  return phoneNumbers * UNIT_COSTS.phoneNumberPerMonth +
    (phoneNumbers > 0 ? UNIT_COSTS.campaignPerMonth : 0);
}

Deno.test("every purchasable plan is fully specified", () => {
  for (const id of PURCHASABLE_PLAN_IDS) {
    const plan = PLANS[id];
    assert(plan.lookupKeys, `${id} must have Stripe lookup keys`);
    assert(plan.monthlyPrice !== null && plan.monthlyPrice > 0, `${id} needs a monthly price`);
    assertEquals(plan.annualPrice, plan.monthlyPrice! * 10, `${id} annual should be 10x monthly`);
    assertEquals(
      new Set(Object.values(plan.lookupKeys!)).size,
      2,
      `${id} monthly and annual lookup keys must differ`,
    );
  }
});

Deno.test("lookup keys are unique across the whole catalog", () => {
  const seen = new Set<string>();
  for (const id of PLAN_ORDER) {
    for (const key of Object.values(PLANS[id].lookupKeys ?? {})) {
      assert(!seen.has(key), `duplicate lookup key ${key}`);
      seen.add(key);
    }
  }
});

Deno.test("every tier is profitable at 100% of its included allowance", () => {
  for (const id of PURCHASABLE_PLAN_IDS) {
    const plan = PLANS[id];
    const { repliesPerMonth, phoneNumbers } = plan.entitlements;
    const cost = repliesPerMonth * COST_PER_REPLY +
      fixedMonthlyCost(phoneNumbers) +
      STRIPE_FEE(plan.monthlyPrice!);
    const margin = (plan.monthlyPrice! - cost) / plan.monthlyPrice!;

    assert(
      margin > 0.5,
      `${id} gross margin at full utilisation is ${(margin * 100).toFixed(1)}%, below 50%`,
    );
  }
});

Deno.test("overage is priced above what a reply costs us", () => {
  for (const id of PURCHASABLE_PLAN_IDS) {
    const { overagePerReply } = PLANS[id].entitlements;
    assert(
      overagePerReply > COST_PER_REPLY * 2,
      `${id} overage ${overagePerReply} does not cover ${COST_PER_REPLY} plus margin`,
    );
  }
});

Deno.test("paid tiers get monotonically more of everything as they get pricier", () => {
  const paid = PURCHASABLE_PLAN_IDS.map((id) => PLANS[id]);
  for (let i = 1; i < paid.length; i++) {
    const lower = paid[i - 1].entitlements;
    const upper = paid[i].entitlements;
    assert(paid[i].monthlyPrice! > paid[i - 1].monthlyPrice!, "price must increase");
    assert(upper.repliesPerMonth > lower.repliesPerMonth, "replies must increase");
    assert(upper.projects >= lower.projects, "projects must not decrease");
    assert(upper.phoneNumbers >= lower.phoneNumbers, "numbers must not decrease");
    assert(
      upper.overagePerReply <= lower.overagePerReply,
      "overage should get cheaper, not dearer, higher up",
    );
  }
});

Deno.test("cost per reply is dominated by SMS, not the model", () => {
  // Guards the assumption the whole tier structure rests on. If a model ever
  // gets expensive enough to matter, the meter needs rethinking.
  const smsPart = UNIT_COSTS.smsInboundPerSegment +
    2 * (UNIT_COSTS.smsOutboundPerSegment + UNIT_COSTS.carrierSurchargePerSegment);
  assert(smsPart / COST_PER_REPLY > 0.9, "SMS should be >90% of a reply's cost");
});

Deno.test("free tier cannot send SMS and has no overage escape hatch", () => {
  assertEquals(PLANS.free.entitlements.phoneNumbers, 0);
  assertEquals(PLANS.free.entitlements.overagePerReply, 0);
  assertEquals(PLANS.free.monthlyPrice, 0);
});

Deno.test("planIdFromLookupKey resolves both intervals and rejects strangers", () => {
  assertEquals(planIdFromLookupKey("replymate_growth_monthly"), "growth");
  assertEquals(planIdFromLookupKey("replymate_growth_annual"), "growth");
  assertEquals(planIdFromLookupKey("price_from_some_other_product"), null);
  assertEquals(planIdFromLookupKey(null), null);
  assertEquals(planIdFromLookupKey(undefined), null);
});

Deno.test("requirePurchasablePlan refuses unknown and sales-only plans", () => {
  assertEquals(requirePurchasablePlan("starter").id, "starter");

  const unknown = assertThrows(() => requirePurchasablePlan("platinum"), ApiError);
  assertEquals(unknown.code, "UNKNOWN_PLAN");

  const enterprise = assertThrows(() => requirePurchasablePlan("enterprise"), ApiError);
  assertEquals(enterprise.code, "PLAN_NOT_PURCHASABLE");

  // A client sending the free id must not be able to open a $0 checkout.
  assertThrows(() => requirePurchasablePlan("free"), ApiError);
});

Deno.test("requireInterval defaults to monthly and rejects anything else", () => {
  assertEquals(requireInterval(undefined), "month");
  assertEquals(requireInterval(null), "month");
  assertEquals(requireInterval("month"), "month");
  assertEquals(requireInterval("year"), "year");
  assertThrows(() => requireInterval("week"), ApiError);
  assertThrows(() => requireInterval(12), ApiError);
});

Deno.test("entitlementsFor falls back to Free unless the status is in good standing", () => {
  assertEquals(entitlementsFor("growth", "active").plan.id, "growth");
  assertEquals(entitlementsFor("growth", "trialing").plan.id, "growth");
  // A card retry in progress must not take a business's phone line down.
  assertEquals(entitlementsFor("growth", "past_due").plan.id, "growth");

  for (const status of ["canceled", "unpaid", "incomplete", "incomplete_expired", "paused"]) {
    const result = entitlementsFor("growth", status);
    assertEquals(result.plan.id, "free", `${status} should not stay entitled`);
    assertEquals(result.entitled, false);
  }
  assertEquals(entitlementsFor(null, "active").plan.id, "free");
  assertEquals(entitlementsFor(undefined, undefined).plan.id, "free");
});

Deno.test("UNLIMITED never reads as a real limit", () => {
  assert(withinLimit(999_999, UNLIMITED));
  assert(withinLimit(0, 1));
  assert(!withinLimit(1, 1));
  assertEquals(formatLimit(UNLIMITED), "Unlimited");
  assertEquals(formatLimit(2000), "2,000");
});

Deno.test("isPlanId narrows only to catalog members", () => {
  assert(isPlanId("scale"));
  assert(!isPlanId("Scale"));
  assert(!isPlanId(""));
  assert(!isPlanId(undefined));
});
