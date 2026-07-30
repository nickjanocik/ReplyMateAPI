import Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ApiError } from "./errors.ts";
import type { BillingInterval, Plan } from "./plans.ts";

/**
 * Stripe client construction, price resolution and customer reuse.
 *
 * Deno has no Node http stack, so the SDK has to be told to use fetch and the
 * Web Crypto provider; the defaults silently fail at runtime rather than at
 * import time, which is a miserable thing to debug.
 */

let cached: Stripe | null = null;

export function stripeSecretKey(): string {
  const key = Deno.env.get("STRIPE_SECRET_KEY")?.trim();
  if (!key) {
    throw new ApiError(
      500,
      "SERVER_MISCONFIGURED",
      "Billing is not configured: STRIPE_SECRET_KEY is missing.",
    );
  }
  return key;
}

export function stripeClient(): Stripe {
  if (cached) return cached;
  cached = new Stripe(stripeSecretKey(), {
    httpClient: Stripe.createFetchHttpClient(),
  });
  return cached;
}

/** Test-mode keys start `sk_test_`; surfaced so the UI can badge the checkout. */
export function stripeIsTestMode(): boolean {
  return stripeSecretKey().startsWith("sk_test_");
}

function priceEnvName(plan: Plan, interval: BillingInterval): string {
  return `STRIPE_PRICE_${plan.id.toUpperCase()}_${interval === "year" ? "ANNUAL" : "MONTHLY"}`;
}

/**
 * Prices are found by Stripe lookup key rather than pinned in env vars, so
 * rotating a price is a dashboard change and not a redeploy. An explicit
 * `STRIPE_PRICE_*` env var still wins, which is what makes it possible to point
 * a staging deployment at throwaway prices.
 */
export async function resolvePriceId(
  plan: Plan,
  interval: BillingInterval,
  stripe: Stripe = stripeClient(),
): Promise<string> {
  const override = Deno.env.get(priceEnvName(plan, interval))?.trim();
  if (override) return override;

  if (!plan.lookupKeys) {
    throw new ApiError(400, "PLAN_NOT_PURCHASABLE", `${plan.name} has no self-serve price.`);
  }
  const lookupKey = plan.lookupKeys[interval];
  const { data } = await stripe.prices.list({
    lookup_keys: [lookupKey],
    active: true,
    limit: 1,
  });
  const price = data[0];
  if (!price) {
    throw new ApiError(
      500,
      "PRICE_NOT_FOUND",
      `No active Stripe price has lookup key "${lookupKey}".`,
      `Create it in Stripe, or set ${priceEnvName(plan, interval)} to a price id.`,
    );
  }
  return price.id;
}

/**
 * One Stripe customer per user, for the life of the account.
 *
 * Creating a fresh customer on each checkout is the classic version of this
 * bug: the saved card, the invoice history and the Billing Portal session all
 * attach to whichever customer happened to be created last, and the others
 * become invisible orphans that still hold payment methods.
 */
export async function ensureStripeCustomer(
  admin: SupabaseClient,
  user: { id: string; email?: string | null },
  stripe: Stripe = stripeClient(),
): Promise<string> {
  const { data: existing, error } = await admin.from("billing_customers")
    .select("stripe_customer_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) {
    throw new ApiError(
      500,
      "DATABASE_ERROR",
      "Could not read your billing profile.",
      error.message,
    );
  }
  if (existing?.stripe_customer_id) return existing.stripe_customer_id as string;

  const customer = await stripe.customers.create({
    email: user.email ?? undefined,
    metadata: { supabase_user_id: user.id },
  });

  const { error: insertError } = await admin.from("billing_customers").insert({
    user_id: user.id,
    stripe_customer_id: customer.id,
  });
  if (insertError) {
    // A concurrent checkout in a second tab can win the race. Whoever lost
    // re-reads the winner's customer and abandons its own, rather than
    // returning a customer the rest of the system does not know about.
    const { data: raced } = await admin.from("billing_customers")
      .select("stripe_customer_id").eq("user_id", user.id).maybeSingle();
    if (raced?.stripe_customer_id) return raced.stripe_customer_id as string;
    throw new ApiError(
      500,
      "DATABASE_ERROR",
      "Could not save your billing profile.",
      insertError.message,
    );
  }
  return customer.id;
}

/**
 * Turn a Stripe SDK rejection into an ApiError that says what to do about it.
 *
 * Without this a misconfigured Stripe account surfaces as a bare
 * `INTERNAL_ERROR` with the real reason buried in the function logs — which is
 * exactly the class of problem that only ever shows up in production, where
 * nobody is tailing them.
 */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;

  const raw = error as { type?: string; code?: string; statusCode?: number; message?: string };
  if (typeof raw?.type !== "string" || !raw.type.startsWith("Stripe")) {
    return new ApiError(500, "INTERNAL_ERROR", "An unexpected error occurred.");
  }

  const message = raw.message ?? "Stripe rejected the request.";
  switch (raw.type) {
    case "StripeAuthenticationError":
      return new ApiError(500, "STRIPE_AUTH_FAILED", "Stripe rejected the API key.", message);
    case "StripeInvalidRequestError":
      // Almost always a setup problem on our side (missing price, unconfigured
      // dashboard setting), so it is a 500 with Stripe's own wording attached.
      return new ApiError(500, "STRIPE_REQUEST_INVALID", "Stripe rejected the request.", message);
    case "StripeRateLimitError":
      return new ApiError(429, "STRIPE_RATE_LIMITED", "Stripe is rate limiting us.", message);
    case "StripeConnectionError":
      return new ApiError(502, "STRIPE_UNREACHABLE", "Could not reach Stripe.", message);
    case "StripeCardError":
      return new ApiError(402, "CARD_DECLINED", message);
    default:
      return new ApiError(502, "STRIPE_ERROR", "Stripe returned an error.", message);
  }
}

/**
 * Only send customers back to origins we control.
 *
 * Checkout return URLs are attacker-supplied input: a request body naming an
 * arbitrary origin turns the billing endpoint into an open redirect stamped
 * with our domain's credibility. The allowlist is the same one CORS uses.
 */
export function safeReturnUrl(candidate: unknown, fallbackOrigin: string, path: string): string {
  const base = fallbackOrigin.replace(/\/+$/, "");
  if (typeof candidate !== "string" || !candidate.trim()) return `${base}${path}`;
  let url: URL;
  try {
    url = new URL(candidate, base);
  } catch {
    return `${base}${path}`;
  }
  if (url.origin !== new URL(base).origin) return `${base}${path}`;
  return url.toString();
}
