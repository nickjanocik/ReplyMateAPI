import { assertEquals } from "jsr:@std/assert@1.0.14";
import {
  chooseCurrentSubscription,
  planSummary,
  securitySummaryFromFactors,
  tenureDays,
} from "../_shared/account.ts";

function jwtWithPayload(payload: Record<string, unknown>): string {
  const encoded = btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/,
    "",
  );
  return `header.${encoded}.signature`;
}

Deno.test("account plan falls back to Free without an active subscription", () => {
  assertEquals(chooseCurrentSubscription([{ status: "canceled", plan: "old" }]), null);
  assertEquals(planSummary(null), {
    name: "Free",
    status: "free",
    source: "default",
    current_period_start: null,
    current_period_end: null,
  });
});

Deno.test("account plan chooses the best current user-level subscription", () => {
  const subscription = chooseCurrentSubscription([
    {
      id: "past",
      status: "past_due",
      plan: "Starter",
      current_period_end: "2026-07-01T00:00:00Z",
    },
    {
      id: "active",
      status: "active",
      plan: "Pro",
      current_period_end: "2026-06-01T00:00:00Z",
    },
    {
      id: "trial",
      status: "trialing",
      plan: "Trial",
      current_period_end: "2026-08-01T00:00:00Z",
    },
  ]);
  assertEquals(subscription?.id, "active");
  assertEquals(planSummary(subscription).name, "Pro");
});

Deno.test("account tenure is non-negative and day based", () => {
  assertEquals(
    tenureDays("2026-06-01T00:00:00Z", Date.parse("2026-06-04T12:00:00Z")),
    3,
  );
  assertEquals(tenureDays("not-a-date"), 0);
  assertEquals(tenureDays("2026-06-04T00:00:00Z", Date.parse("2026-06-01T00:00:00Z")), 0);
});

Deno.test("account security summary reports verified TOTP factors and AAL", () => {
  const summary = securitySummaryFromFactors(jwtWithPayload({ aal: "aal2" }), {
    totp: [
      { id: "factor-1", factor_type: "totp", status: "verified", friendly_name: "Phone" },
      { id: "factor-2", factor_type: "totp", status: "unverified" },
    ],
  }, true);
  assertEquals(summary.aal, "aal2");
  assertEquals(summary.totp_enabled, true);
  assertEquals(summary.verified_factor_count, 1);
  assertEquals((summary.factors as unknown[]).length, 2);
});

Deno.test("account security summary tolerates unavailable MFA factor state", () => {
  const summary = securitySummaryFromFactors(jwtWithPayload({ aal: "aal1" }), null, false);
  assertEquals(summary.aal, "aal1");
  assertEquals(summary.totp_enabled, false);
  assertEquals(summary.factors_available, false);
});
