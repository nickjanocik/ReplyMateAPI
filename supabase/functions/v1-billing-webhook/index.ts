import Stripe from "stripe";
import { createAdminClient } from "../_shared/auth.ts";
import { ApiError, errorResponse, jsonResponse, requireMethod } from "../_shared/errors.ts";
import { stripeClient } from "../_shared/stripe.ts";
import { buildSubscriptionRow, HANDLED_SUBSCRIPTION_EVENTS } from "../_shared/billingSync.ts";

/**
 * Stripe webhook receiver.
 *
 * This is the only writer of `subscriptions`, which is deliberate: the browser
 * returning from Checkout proves nothing about whether the card cleared. Every
 * event is recorded in `provider_webhook_events` before it is acted on, so a
 * duplicate delivery is a unique-violation rather than a double-apply.
 *
 * There is no CORS handling and no `apiHandler` wrapper here — Stripe is not a
 * browser, and the signature check is the authentication.
 */

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new ApiError(500, "SERVER_MISCONFIGURED", `${name} is not configured.`);
  return value;
}

async function markEvent(
  admin: ReturnType<typeof createAdminClient>,
  id: string,
  status: "processed" | "ignored" | "failed",
  errorMessage?: string,
): Promise<void> {
  await admin.from("provider_webhook_events").update({
    status,
    ...(errorMessage ? { error_message: errorMessage.slice(0, 2000) } : {}),
    processed_at: new Date().toISOString(),
  }).eq("id", id);
}

/**
 * Checkout completing tells us the customer id before any subscription event
 * arrives, and the two can land out of order. Binding it here means a user who
 * closes the tab immediately still has a Billing Portal that works.
 */
async function linkCheckoutCustomer(
  admin: ReturnType<typeof createAdminClient>,
  session: Record<string, unknown>,
): Promise<void> {
  const metadata = (session.metadata ?? {}) as Record<string, string>;
  const userId = metadata.supabase_user_id ||
    (typeof session.client_reference_id === "string" ? session.client_reference_id : "");
  const customerId = typeof session.customer === "string" ? session.customer : null;
  if (!userId || !customerId) return;

  await admin.from("billing_customers").upsert(
    { user_id: userId, stripe_customer_id: customerId },
    { onConflict: "user_id" },
  );
}

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  try {
    requireMethod(req, ["POST"]);
    const signature = req.headers.get("stripe-signature");
    if (!signature) throw new ApiError(400, "INVALID_SIGNATURE", "Stripe-Signature is required.");
    const body = await req.text();
    const stripe = stripeClient();

    let event: Stripe.Event;
    try {
      event = await stripe.webhooks.constructEventAsync(
        body,
        signature,
        requiredEnv("STRIPE_WEBHOOK_SECRET"),
        undefined,
        Stripe.createSubtleCryptoProvider(),
      );
    } catch {
      throw new ApiError(400, "INVALID_SIGNATURE", "Stripe webhook signature verification failed.");
    }

    const admin = createAdminClient();
    const { data: eventRow, error: eventError } = await admin.from("provider_webhook_events")
      .insert({
        provider: "stripe",
        event_id: event.id,
        event_type: event.type,
        status: "received",
      }).select("id").single();
    if (eventError?.code === "23505") return jsonResponse({ received: true, duplicate: true });
    if (eventError) {
      throw new ApiError(500, "DATABASE_ERROR", "Could not record the webhook event.");
    }

    try {
      if (event.type === "checkout.session.completed") {
        await linkCheckoutCustomer(admin, event.data.object as unknown as Record<string, unknown>);
        await markEvent(admin, eventRow.id, "processed");
        return jsonResponse({ received: true });
      }

      if (!HANDLED_SUBSCRIPTION_EVENTS.has(event.type)) {
        await markEvent(admin, eventRow.id, "ignored");
        return jsonResponse({ received: true, ignored: true });
      }

      const subscription = event.data.object as unknown as Record<string, unknown>;
      const subscriptionId = String(subscription.id ?? "");
      const metadata = (subscription.metadata ?? {}) as Record<string, string>;
      const { data: existing } = await admin.from("subscriptions")
        .select("user_id,stripe_event_created_at")
        .eq("stripe_subscription_id", subscriptionId).maybeSingle();
      const userId = existing?.user_id ?? metadata.supabase_user_id;
      if (!userId) {
        await markEvent(
          admin,
          eventRow.id,
          "ignored",
          "Missing metadata.supabase_user_id on an unknown subscription.",
        );
        return jsonResponse({ received: true, ignored: true });
      }

      const eventTime = new Date(event.created * 1000).toISOString();
      if (existing?.stripe_event_created_at && existing.stripe_event_created_at > eventTime) {
        // Stripe does not guarantee delivery order. An older event overwriting
        // a newer one would resurrect a cancelled plan.
        await markEvent(admin, eventRow.id, "ignored");
        return jsonResponse({ received: true, stale: true });
      }

      const row = buildSubscriptionRow({
        subscription,
        userId,
        eventType: event.type,
        eventCreatedAt: eventTime,
      });

      const { error } = await admin.from("subscriptions").upsert(row, {
        onConflict: "stripe_subscription_id",
      });
      if (error) {
        throw new ApiError(
          500,
          "DATABASE_ERROR",
          "Could not update subscription state.",
          error.message,
        );
      }

      if (row.stripe_customer_id) {
        // Keeps the portal working for subscriptions created outside Checkout,
        // e.g. one an operator sets up by hand in the Stripe dashboard.
        await admin.from("billing_customers").upsert(
          { user_id: userId, stripe_customer_id: row.stripe_customer_id },
          { onConflict: "user_id" },
        );
      }

      await markEvent(admin, eventRow.id, "processed");
      return jsonResponse({ received: true, plan: row.plan_id, status: row.status });
    } catch (error) {
      await markEvent(
        admin,
        eventRow.id,
        "failed",
        error instanceof Error ? error.message : "Webhook failed",
      );
      throw error;
    }
  } catch (error) {
    return errorResponse(error, requestId);
  }
});
