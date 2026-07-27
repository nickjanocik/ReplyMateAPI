import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import {
  createChatResponse,
  createEmbeddings,
  estimateChatCost,
  estimateEmbeddingCost,
} from "../_shared/openai.ts";
import { ApiError } from "../_shared/errors.ts";

Deno.test("cost estimates account for cached and embedding tokens", () => {
  assertEquals(
    estimateChatCost("gpt-5.4-nano", {
      inputTokens: 1000,
      cachedInputTokens: 400,
      outputTokens: 200,
    }),
    0.000378,
  );
  assertEquals(estimateEmbeddingCost("text-embedding-3-small", 1000), 0.00002);
});

Deno.test("OpenAI helpers parse embeddings and response output", async () => {
  Deno.env.set("OPENAI_API_KEY", "test-key");
  const embeddingFetcher: typeof fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          data: [{ index: 0, embedding: Array(1536).fill(0.25) }],
          usage: { total_tokens: 7 },
        }),
        { status: 200 },
      ),
    );
  const embedded = await createEmbeddings(["hello"], embeddingFetcher);
  assertEquals(embedded.inputTokens, 7);
  assertEquals(embedded.embeddings[0].length, 1536);

  const responseFetcher: typeof fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          output: [{
            type: "message",
            content: [{ type: "output_text", text: "Grounded answer" }],
          }],
          usage: { input_tokens: 12, input_tokens_details: { cached_tokens: 2 }, output_tokens: 3 },
        }),
        { status: 200 },
      ),
    );
  const result = await createChatResponse({
    model: "gpt-5.4-nano",
    instructions: "Use context.",
    messages: [{ role: "user", content: "Question" }],
  }, responseFetcher);
  assertEquals(result.content, "Grounded answer");
  assertEquals(result.usage.cachedInputTokens, 2);
});

Deno.test("OpenAI failures become stable API errors", async () => {
  Deno.env.set("OPENAI_API_KEY", "test-key");
  const failingFetcher: typeof fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          error: { message: "rate limited" },
        }),
        { status: 429 },
      ),
    );
  await assertRejects(
    () => createEmbeddings(["hello"], failingFetcher),
    ApiError,
    "model provider rejected",
  );
});

Deno.test("OpenAI quota failures become actionable API errors", async () => {
  Deno.env.set("OPENAI_API_KEY", "test-key");
  const failingFetcher: typeof fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          error: {
            message: "You exceeded your current quota.",
            type: "insufficient_quota",
            code: "insufficient_quota",
          },
        }),
        { status: 429 },
      ),
    );
  const error = await assertRejects(
    () =>
      createChatResponse({
        model: "gpt-5.4-nano",
        instructions: "Use context.",
        messages: [{ role: "user", content: "Question" }],
      }, failingFetcher),
    ApiError,
    "quota is exhausted",
  );
  assertEquals(error.code, "OPENAI_QUOTA_EXCEEDED");
});

Deno.test("explicit mock mode returns deterministic embeddings and grounded chat", async () => {
  Deno.env.set("OPENAI_MODE", "mock");
  Deno.env.delete("OPENAI_API_KEY");
  try {
    const first = await createEmbeddings(["The launch color is cobalt blue."]);
    const second = await createEmbeddings(["The launch color is cobalt blue."]);
    assertEquals(first.embeddings, second.embeddings);
    assertEquals(first.embeddings[0].length, 1536);

    const response = await createChatResponse({
      model: "gpt-5.4-nano",
      instructions:
        "Use context.\n\nRetrieved project context:\n[Source 1: Facts; chunk=1]\nThe launch color is cobalt blue.",
      messages: [{ role: "user", content: "What is the launch color?" }],
    });
    assertEquals(response.content.includes("cobalt blue"), true);
  } finally {
    Deno.env.delete("OPENAI_MODE");
  }
});
