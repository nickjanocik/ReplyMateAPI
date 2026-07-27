import type { JsonRecord } from "./types.ts";

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing", "past_due"]);
const SUBSCRIPTION_STATUS_PRIORITY: Record<string, number> = {
  active: 0,
  trialing: 1,
  past_due: 2,
};

export function decodeJwtPayload(token: string): JsonRecord {
  try {
    const part = token.split(".")[1];
    if (!part) return {};
    const padded = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(
      Math.ceil(part.length / 4) * 4,
      "=",
    );
    return JSON.parse(atob(padded)) as JsonRecord;
  } catch {
    return {};
  }
}

export function tenureDays(createdAt?: string, now = Date.now()): number {
  if (!createdAt) return 0;
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) return 0;
  return Math.max(0, Math.floor((now - created) / (24 * 60 * 60 * 1000)));
}

function dateValue(value: unknown): number {
  if (typeof value !== "string") return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function chooseCurrentSubscription(rows: JsonRecord[]): JsonRecord | null {
  const active = rows.filter((row) =>
    typeof row.status === "string" && ACTIVE_SUBSCRIPTION_STATUSES.has(row.status)
  );
  active.sort((a, b) => {
    const priorityA = SUBSCRIPTION_STATUS_PRIORITY[String(a.status)] ?? 99;
    const priorityB = SUBSCRIPTION_STATUS_PRIORITY[String(b.status)] ?? 99;
    if (priorityA !== priorityB) return priorityA - priorityB;
    return dateValue(b.current_period_end) - dateValue(a.current_period_end) ||
      dateValue(b.created_at) - dateValue(a.created_at);
  });
  return active[0] ?? null;
}

export function planSummary(subscription: JsonRecord | null): JsonRecord {
  if (!subscription) {
    return {
      name: "Free",
      status: "free",
      source: "default",
      current_period_start: null,
      current_period_end: null,
    };
  }
  return {
    id: subscription.id,
    name: subscription.plan ?? "Paid",
    status: subscription.status,
    source: "stripe",
    project_id: subscription.project_id ?? null,
    stripe_customer_id: subscription.stripe_customer_id ?? null,
    stripe_subscription_id: subscription.stripe_subscription_id ?? null,
    current_period_start: subscription.current_period_start ?? null,
    current_period_end: subscription.current_period_end ?? null,
  };
}

export function factorsFrom(data: JsonRecord | null | undefined): JsonRecord[] {
  if (!data) return [];
  const all = data.all;
  if (Array.isArray(all)) return all as JsonRecord[];
  const totp = data.totp;
  const phone = data.phone;
  return [
    ...(Array.isArray(totp) ? totp : []),
    ...(Array.isArray(phone) ? phone : []),
  ] as JsonRecord[];
}

function publicFactor(factor: JsonRecord): JsonRecord {
  return {
    id: factor.id,
    type: factor.factor_type ?? factor.type ?? "unknown",
    friendly_name: factor.friendly_name ?? null,
    status: factor.status ?? null,
    created_at: factor.created_at ?? null,
    updated_at: factor.updated_at ?? null,
  };
}

export function securitySummaryFromFactors(
  token: string,
  data: JsonRecord | null | undefined,
  available: boolean,
): JsonRecord {
  const claims = decodeJwtPayload(token);
  const aal = typeof claims.aal === "string" ? claims.aal : "aal1";
  if (!available) {
    return {
      aal,
      totp_enabled: false,
      verified_factor_count: 0,
      factors: [],
      factors_available: false,
    };
  }
  const factors = factorsFrom(data);
  const totpFactors = factors.filter((factor) => (factor.factor_type ?? factor.type) === "totp");
  const verifiedTotpFactors = totpFactors.filter((factor) => factor.status === "verified");
  return {
    aal,
    totp_enabled: verifiedTotpFactors.length > 0,
    verified_factor_count: verifiedTotpFactors.length,
    factors_available: true,
    factors: totpFactors.map(publicFactor),
  };
}
