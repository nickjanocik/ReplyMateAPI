import type { MessagingProvider, SendMessageInput, SendMessageResult } from "./messaging.ts";

export class MockMessagingProvider implements MessagingProvider {
  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const bytes = new TextEncoder().encode(`${input.projectId}:${input.to}:${input.body}`);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const id = Array.from(new Uint8Array(digest).slice(0, 12))
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return {
      provider: "mock",
      providerMessageId: `mock_${id}`,
      requestedChannel: input.requestedChannel,
      actualChannel: input.requestedChannel,
      status: "mock_delivered",
    };
  }
}
