import { ApiError } from "../errors.ts";
import type { MessagingProvider } from "./messaging.ts";
import { MockMessagingProvider } from "./mockMessaging.ts";
import { TwilioMessagingProvider } from "./twilio.ts";

export function messagingProvider(): MessagingProvider {
  const mode = (Deno.env.get("MESSAGING_MODE") ?? "mock").toLowerCase();
  if (mode === "mock") return new MockMessagingProvider();
  if (mode === "live") return new TwilioMessagingProvider();
  throw new ApiError(500, "SERVER_MISCONFIGURED", "MESSAGING_MODE must be mock or live.");
}

export * from "./messaging.ts";
