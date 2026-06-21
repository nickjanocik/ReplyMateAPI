import { ApiError } from "../errors.ts";
import type { MessagingProvider, SendMessageInput, SendMessageResult } from "./messaging.ts";

export class TwilioMessagingProvider implements MessagingProvider {
  constructor() {
    for (
      const name of ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_MESSAGING_SERVICE_SID"]
    ) {
      if (!Deno.env.get(name)) {
        throw new ApiError(
          500,
          "SERVER_MISCONFIGURED",
          `${name} is not configured.`,
        );
      }
    }
  }

  sendMessage(_input: SendMessageInput): Promise<SendMessageResult> {
    // Fail closed until compliance, opt-out, throughput, and RCS fallback behavior are implemented.
    throw new ApiError(
      501,
      "LIVE_MESSAGING_NOT_IMPLEMENTED",
      "Live Twilio sending is disabled in v1.",
    );
  }
}
