import { createAdminClient } from "../_shared/auth.ts";
import { ApiError, errorResponse, requireMethod } from "../_shared/errors.ts";

function constantTimeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
  return difference === 0;
}

async function twilioSignature(
  url: string,
  params: URLSearchParams,
  token: string,
): Promise<string> {
  let value = url;
  const keys = [...new Set(params.keys())].sort();
  for (const key of keys) {
    for (const entry of params.getAll(key)) value += `${key}${entry}`;
  }
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(token),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(value)),
  );
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary);
}

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  try {
    requireMethod(req, ["POST"]);
    const authToken = Deno.env.get("TWILIO_AUTH_TOKEN");
    if (!authToken) {
      throw new ApiError(500, "SERVER_MISCONFIGURED", "TWILIO_AUTH_TOKEN is not configured.");
    }
    const signature = req.headers.get("x-twilio-signature");
    if (!signature) throw new ApiError(400, "INVALID_SIGNATURE", "X-Twilio-Signature is required.");
    const params = new URLSearchParams(await req.text());
    const expected = await twilioSignature(req.url, params, authToken);
    if (!constantTimeEqual(signature, expected)) {
      throw new ApiError(403, "INVALID_SIGNATURE", "Twilio webhook signature verification failed.");
    }

    const admin = createAdminClient();
    const messageSid = params.get("MessageSid") ?? params.get("SmsSid");
    const messageStatus = params.get("MessageStatus");
    const eventId = `${messageSid ?? "unknown"}:${messageStatus ?? "inbound"}`;
    await admin.from("provider_webhook_events").upsert({
      provider: "twilio",
      event_id: eventId,
      event_type: messageStatus ? "message.status" : "message.inbound",
      status: "processed",
      processed_at: new Date().toISOString(),
      metadata: { message_sid: messageSid, message_status: messageStatus },
    }, { onConflict: "provider,event_id", ignoreDuplicates: true });

    if (messageSid && messageStatus) {
      await admin.from("outbound_messages").update({
        status: messageStatus,
        ...(messageStatus === "sent" || messageStatus === "delivered"
          ? { sent_at: new Date().toISOString() }
          : {}),
      }).eq("provider", "twilio").eq("provider_message_id", messageSid);
    }

    // TODO: Persist and route opted-in inbound SMS/RCS only after consent and conversation mapping exist.
    return new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
      status: 200,
      headers: { "content-type": "application/xml; charset=utf-8" },
    });
  } catch (error) {
    return errorResponse(error, requestId);
  }
});
