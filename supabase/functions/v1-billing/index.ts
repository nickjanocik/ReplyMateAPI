import { createAdminClient, requireUser } from "../_shared/auth.ts";
import { ApiError, apiHandler, jsonResponse, requireMethod } from "../_shared/errors.ts";
import { enumField, readJson, stringField } from "../_shared/validation.ts";
import { entitlementSummary, loadEntitlement } from "../_shared/entitlements.ts";
import {
  PLAN_ORDER,
  PLANS,
  requireInterval,
  requirePurchasablePlan,
  UNIT_COSTS,
} from "../_shared/plans.ts";
import {
  ensureStripeCustomer,
  resolvePriceId,
  safeReturnUrl,
  stripeClient,
  stripeIsTestMode,
  toApiError,
} from "../_shared/stripe.ts";

/**
 * Self-serve billing: read the current plan, start a Checkout Session, or open
 * the Stripe Billing Portal.
 *
 * Nothing here mutates `subscriptions`. Checkout returning successfully only
 * means the browser was redirected; the subscription becomes real when the
 * webhook says so. Writing the plan optimistically on return is how customers
 * end up entitled to a tier they abandoned at the card form.
 */

/** Where to send the browser when the request did not name a return path. */
function appOrigin(req: Request): string {
  const origin = req.headers.get("origin");
  // apiHandler has already rejected disallowed origins by the time we get here.
  if (origin) return origin;
  const configured = Deno.env.get("APP_BASE_URL")?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  throw new ApiError(
    400,
    "VALIDATION_ERROR",
    "Could not determine where to return to. Set APP_BASE_URL or call from a browser.",
  );
}

function publicCatalog() {
  return PLAN_ORDER.map((id) => {
    const plan = PLANS[id];
    return {
      id: plan.id,
      name: plan.name,
      blurb: plan.blurb,
      monthly_price: plan.monthlyPrice,
      annual_price: plan.annualPrice,
      trial_days: plan.trialDays,
      featured: plan.featured,
      purchasable: plan.lookupKeys !== null,
      entitlements: plan.entitlements,
    };
  });
}

Deno.serve(apiHandler(async (req) => {
  requireMethod(req, ["GET", "POST"]);
  const url = new URL(req.url);

  // The catalog is the same for everyone and the pricing page is public, so it
  // is the one route here that does not require a session.
  if (req.method === "GET" && url.searchParams.get("resource") === "plans") {
    return jsonResponse({ plans: publicCatalog(), unit_costs_reference: UNIT_COSTS });
  }

  const { user } = await requireUser(req);
  const admin = createAdminClient();

  if (req.method === "GET") {
    const entitlement = await loadEntitlement(admin, user.id);
    return jsonResponse({
      billing: entitlementSummary(entitlement),
      plans: publicCatalog(),
      test_mode: Deno.env.get("STRIPE_SECRET_KEY") ? stripeIsTestMode() : null,
    });
  }

  const input = await readJson(req);
  const action = enumField(input, "action", ["checkout", "portal"] as const, true)!;
  const origin = appOrigin(req);

  try {
    return await handleWrite({ action, input, origin, admin, user });
  } catch (error) {
    // Stripe SDK rejections are plain objects, not ApiErrors, so without this
    // a dashboard misconfiguration reaches the browser as "An unexpected error
    // occurred" and the actual reason only exists in the function logs.
    throw toApiError(error);
  }
}));

async function handleWrite(context: {
  action: "checkout" | "portal";
  input: Record<string, unknown>;
  origin: string;
  admin: ReturnType<typeof createAdminClient>;
  user: { id: string; email?: string };
}): Promise<Response> {
  const { action, input, origin, admin, user } = context;
  const stripe = stripeClient();
  const customerId = await ensureStripeCustomer(admin, user);

  if (action === "portal") {
    const returnUrl = safeReturnUrl(
      stringField(input, "return_path", { max: 500 }),
      origin,
      "/account",
    );
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });
    return jsonResponse({ url: session.url });
  }

  const plan = requirePurchasablePlan(input.plan);
  const interval = requireInterval(input.interval);
  const price = await resolvePriceId(plan, interval, stripe);

  const entitlement = await loadEntitlement(admin, user.id, { withUsage: false });
  if (entitlement.entitled && entitlement.subscription?.stripe_subscription_id) {
    // Checking out again on top of a live subscription bills the customer twice
    // and leaves two subscriptions racing to set the same plan row. Plan
    // changes belong in the portal, which prorates them.
    throw new ApiError(
      409,
      "SUBSCRIPTION_EXISTS",
      `You are already on ${entitlement.plan.name}. Use "Manage billing" to change plan.`,
    );
  }

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price, quantity: 1 }],
    // Stripe copies these onto the subscription, which is what the webhook
    // reads to attribute it to a user. Without them an incoming
    // customer.subscription.created event has no idea whose it is.
    subscription_data: {
      ...(plan.trialDays > 0 ? { trial_period_days: plan.trialDays } : {}),
      metadata: { supabase_user_id: user.id, plan: plan.id, interval },
    },
    metadata: { supabase_user_id: user.id, plan: plan.id, interval },
    client_reference_id: user.id,
    allow_promotion_codes: true,
    // Needed for sales tax and for the AVS check on the card.
    billing_address_collection: "required",
    // Deliberately no `consent_collection.terms_of_service`: Stripe rejects the
    // whole session unless a Terms URL is set under Public business details in
    // the Dashboard, so enabling it here would make checkout fail closed on a
    // setting this code cannot see. The consent that A2P vetting actually cares
    // about is captured on the opt-in form, not at the card form.
    success_url: safeReturnUrl(
      stringField(input, "success_path", { max: 500 }),
      origin,
      "/account?checkout=success",
    ),
    cancel_url: safeReturnUrl(
      stringField(input, "cancel_path", { max: 500 }),
      origin,
      "/pricing?checkout=cancelled",
    ),
  });

  if (!session.url) {
    throw new ApiError(502, "CHECKOUT_FAILED", "Stripe did not return a checkout URL.");
  }
  return jsonResponse({ url: session.url, session_id: session.id });
}
