import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1.0.14";
import {
  chatProvider,
  createChatResponse,
  createEmbeddings,
  estimateChatCost,
  getEmbeddingModel,
} from "../_shared/openai.ts";
import { normalizeVector } from "../_shared/providers/gemini.ts";

function setEnv(env: Record<string, string | null>) {
  for (const [key, value] of Object.entries(env)) {
    if (value === null) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
}

const MSG = [{ role: "user" as const, content: "How much is the 2-bed?" }];

Deno.test("mock mode short-circuits before any provider, even with gemini selected", async () => {
  setEnv({ OPENAI_MODE: "mock", LLM_PROVIDER: "gemini", GEMINI_API_KEY: "k" });
  let called = false;
  const spy = () => {
    called = true;
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
  const result = await createChatResponse(
    { model: null as unknown as string, instructions: "i", messages: MSG },
    spy as unknown as typeof fetch,
  );
  assertEquals(called, false, "mock must not make a network call");
  assertEquals(result.model, "gemini-3.1-flash-lite");

  const embeddings = await createEmbeddings(["a", "b"], spy as unknown as typeof fetch);
  assertEquals(called, false);
  assertEquals(embeddings.embeddings.length, 2);
  assertEquals(embeddings.embeddings[0].length, 1536, "mock must match the vector(1536) column");
});

Deno.test("live + gemini routes chat to the Gemini endpoint", async () => {
  setEnv({ OPENAI_MODE: "live", LLM_PROVIDER: "gemini", GEMINI_API_KEY: "k" });
  let url = "";
  const spy = (u: string | URL) => {
    url = String(u);
    return Promise.resolve(
      new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }),
        { status: 200 },
      ),
    );
  };
  const result = await createChatResponse(
    { model: null as unknown as string, instructions: "i", messages: MSG },
    spy as unknown as typeof fetch,
  );
  assertEquals(url.startsWith("https://generativelanguage.googleapis.com"), true, url);
  assertEquals(url.includes(":generateContent"), true);
  assertEquals(result.content, "ok");
});

Deno.test("live + gemini routes embeddings to Gemini and normalises them", async () => {
  setEnv({ OPENAI_MODE: "live", LLM_PROVIDER: "gemini", GEMINI_API_KEY: "k" });
  let url = "";
  const raw = Array.from({ length: 1536 }, () => 0.5);
  const spy = (u: string | URL) => {
    url = String(u);
    return Promise.resolve(
      new Response(JSON.stringify({ embeddings: [{ values: raw }] }), { status: 200 }),
    );
  };
  const result = await createEmbeddings(["chunk"], spy as unknown as typeof fetch);
  assertEquals(url.includes(":batchEmbedContents"), true, url);
  assertEquals(result.embeddings[0].length, 1536);
  const magnitude = Math.sqrt(result.embeddings[0].reduce((s, v) => s + v * v, 0));
  assertAlmostEquals(magnitude, 1, 1e-9, "stored vectors must be unit length");
  assertEquals(getEmbeddingModel(), "gemini-embedding-001");
});

Deno.test("live + openai keeps both calls on OpenAI", async () => {
  setEnv({ OPENAI_MODE: "live", LLM_PROVIDER: "openai", OPENAI_API_KEY: "k" });
  const urls: string[] = [];
  const spy = (u: string | URL) => {
    urls.push(String(u));
    return Promise.resolve(
      new Response(
        JSON.stringify({
          output: [{ content: [{ type: "output_text", text: "ok" }] }],
          data: [{ index: 0, embedding: Array.from({ length: 1536 }, () => 0.1) }],
          usage: {},
        }),
        { status: 200 },
      ),
    );
  };
  await createChatResponse(
    { model: "gpt-5.4-nano", instructions: "i", messages: MSG },
    spy as unknown as typeof fetch,
  );
  await createEmbeddings(["chunk"], spy as unknown as typeof fetch);
  assertEquals(urls.every((u) => u.startsWith("https://api.openai.com")), true, urls.join(","));
  assertEquals(chatProvider(), "openai");
});

Deno.test("an unpriced Gemini model estimates zero instead of throwing", () => {
  setEnv({
    OPENAI_MODE: "live",
    LLM_PROVIDER: "gemini",
    GEMINI_INPUT_PRICE_PER_MTOK: null,
    GEMINI_OUTPUT_PRICE_PER_MTOK: null,
  });
  const cost = estimateChatCost("gemini-3.1-flash-lite", {
    inputTokens: 1000,
    cachedInputTokens: 0,
    outputTokens: 500,
  });
  assertEquals(cost, 0);
});

Deno.test("configured Gemini prices are applied per million tokens", () => {
  setEnv({
    OPENAI_MODE: "live",
    LLM_PROVIDER: "gemini",
    GEMINI_INPUT_PRICE_PER_MTOK: "0.10",
    GEMINI_OUTPUT_PRICE_PER_MTOK: "0.40",
  });
  const cost = estimateChatCost("gemini-3.1-flash-lite", {
    inputTokens: 1_000_000,
    cachedInputTokens: 0,
    outputTokens: 1_000_000,
  });
  assertAlmostEquals(cost, 0.5, 1e-9);
  setEnv({ GEMINI_INPUT_PRICE_PER_MTOK: null, GEMINI_OUTPUT_PRICE_PER_MTOK: null });
});

Deno.test("normalizeVector leaves a zero vector alone", () => {
  assertEquals(normalizeVector([0, 0, 0]), [0, 0, 0]);
});
