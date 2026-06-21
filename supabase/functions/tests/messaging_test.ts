import { assertEquals } from "jsr:@std/assert@1.0.14";
import { MockMessagingProvider } from "../_shared/providers/mockMessaging.ts";

Deno.test("mock messaging is deterministic and never sends", async () => {
  const provider = new MockMessagingProvider();
  const input = {
    projectId: "project",
    to: "+15555550100",
    body: "Hello",
    requestedChannel: "sms" as const,
  };
  const first = await provider.sendMessage(input);
  const second = await provider.sendMessage(input);
  assertEquals(first, second);
  assertEquals(first.provider, "mock");
});
