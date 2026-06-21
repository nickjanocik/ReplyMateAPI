import Stripe from "stripe";
import { createAdminClient } from "../_shared/auth.ts";
import { ApiError, errorResponse, jsonResponse, requireMethod } from "../_shared/errors.ts";

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new ApiError(500, "SERVER_MISCONFIGURED", `${name} is not configured.`);
  return value;
}

function unixDate(value: unknown): string | null {
  return typeof value === "number" ? new Date(value * 1000).toISOString() : null;
}

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  try {
    requireMethod(req, ["POST"]);
    const signature = req.headers.get("stripe-signature");
    if (!signature) throw new ApiError(400, "INVALID_SIGNATURE", "Stripe-Signature is required.");
    const body = await req.text();
    const stripe = new Stripe(requiredEnv("STRIPE_SECRET_KEY"), {
      httpClient: Stripe.createFetchHttpClient(),
    });
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
      if (
        ![
          "customer.subscription.created",
          "customer.subscription.updated",
          "customer.subscription.deleted",
        ].includes(event.type)
      ) {
        await admin.from("provider_webhook_events").update({
          status: "ignored",
          processed_at: new Date().toISOString(),
        }).eq("id", eventRow.id);
        return jsonResponse({ received: true, ignored: true });
      }

      const subscription = event.data.object as unknown as Record<string, unknown>;
      const subscriptionId = String(subscription.id ?? "");
      const metadata = (subscription.metadata ?? {}) as Record<string, string>;
      const { data: existing } = await admin.from("subscriptions").select(
        "user_id,stripe_event_created_at",
      )
        .eq("stripe_subscription_id", subscriptionId).maybeSingle();
      const userId = existing?.user_id ?? metadata.supabase_user_id;
      if (!userId) {
        await admin.from("provider_webhook_events").update({
          status: "ignored",
          error_message: "Missing metadata.supabase_user_id on an unknown subscription.",
          processed_at: new Date().toISOString(),
        }).eq("id", eventRow.id);
        return jsonResponse({ received: true, ignored: true });
      }

      const eventTime = new Date(event.created * 1000).toISOString();
      if (existing?.stripe_event_created_at && existing.stripe_event_created_at > eventTime) {
        await admin.from("provider_webhook_events").update({
          status: "ignored",
          processed_at: new Date().toISOString(),
        })
          .eq("id", eventRow.id);
        return jsonResponse({ received: true, stale: true });
      }
      const items = subscription.items as {
        data?: Array<{ price?: { lookup_key?: string | null } }>;
      } | undefined;
      const { error } = await admin.from("subscriptions").upsert({
        user_id: userId,
        project_id: metadata.project_id || null,
        stripe_customer_id: typeof subscription.customer === "string"
          ? subscription.customer
          : null,
        stripe_subscription_id: subscriptionId,
        plan: metadata.plan || items?.data?.[0]?.price?.lookup_key || null,
        status: event.type === "customer.subscription.deleted"
          ? "canceled"
          : String(subscription.status ?? "unknown"),
        current_period_start: unixDate(subscription.current_period_start),
        current_period_end: unixDate(subscription.current_period_end),
        stripe_event_created_at: eventTime,
      }, { onConflict: "stripe_subscription_id" });
      if (error) {
        throw new ApiError(
          500,
          "DATABASE_ERROR",
          "Could not update subscription state.",
          error.message,
        );
      }
      await admin.from("provider_webhook_events").update({
        status: "processed",
        processed_at: new Date().toISOString(),
      }).eq("id", eventRow.id);
      return jsonResponse({ received: true });
    } catch (error) {
      await admin.from("provider_webhook_events").update({
        status: "failed",
        error_message: error instanceof Error ? error.message.slice(0, 2000) : "Webhook failed",
        processed_at: new Date().toISOString(),
      }).eq("id", eventRow.id);
      throw error;
    }
  } catch (error) {
    return errorResponse(error, requestId);
  }
});
