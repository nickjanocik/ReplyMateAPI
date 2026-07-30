import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import { ApiError } from "../_shared/errors.ts";
import {
  createGeminiChatResponse,
  DEFAULT_GEMINI_CHAT_MODEL,
  getGeminiChatModel,
  readGeminiText,
  readGeminiUsage,
  toGeminiContents,
} from "../_shared/providers/gemini.ts";

Deno.test("assistant turns are mapped to Gemini's model role", () => {
  assertEquals(
    toGeminiContents([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]),
    [
      { role: "user", parts: [{ text: "hi" }] },
      { role: "model", parts: [{ text: "hello" }] },
    ],
  );
});

Deno.test("model id falls back to the configured default", () => {
  Deno.env.delete("GEMINI_CHAT_MODEL");
  assertEquals(getGeminiChatModel(), DEFAULT_GEMINI_CHAT_MODEL);
  assertEquals(getGeminiChatModel("gemini-3.6-flash"), "gemini-3.6-flash");
  // projects.default_model holds OpenAI ids; forwarding one would 404.
  assertEquals(getGeminiChatModel("gpt-5.4-nano"), DEFAULT_GEMINI_CHAT_MODEL);
  assertEquals(getGeminiChatModel("gpt-5.4-mini"), DEFAULT_GEMINI_CHAT_MODEL);
  Deno.env.set("GEMINI_CHAT_MODEL", "gemini-3.5-flash");
  assertEquals(getGeminiChatModel(), "gemini-3.5-flash");
  Deno.env.delete("GEMINI_CHAT_MODEL");
});

Deno.test("multi-part candidates are joined and usage never over-reports cache", () => {
  const payload = {
    candidates: [{ content: { parts: [{ text: "one" }, { text: "two" }] } }],
    usageMetadata: { promptTokenCount: 10, cachedContentTokenCount: 99, candidatesTokenCount: 4 },
  };
  assertEquals(readGeminiText(payload), "one\ntwo");
  assertEquals(readGeminiUsage(payload), {
    inputTokens: 10,
    cachedInputTokens: 10,
    outputTokens: 4,
  });
});

Deno.test("a bad model id becomes an actionable error", async () => {
  Deno.env.set("GEMINI_API_KEY", "test-key");
  const fetcher = () =>
    Promise.resolve(
      new Response(JSON.stringify({ error: { message: "models/nope is not found" } }), {
        status: 404,
      }),
    );
  const error = await assertRejects(
    () =>
      createGeminiChatResponse(
        { model: "nope", instructions: "i", messages: [{ role: "user", content: "q" }] },
        fetcher as unknown as typeof fetch,
      ),
    ApiError,
  );
  assertEquals(error.code, "MODEL_NOT_FOUND");
});

Deno.test("a safety block is reported distinctly from an empty reply", async () => {
  Deno.env.set("GEMINI_API_KEY", "test-key");
  const fetcher = () =>
    Promise.resolve(
      new Response(JSON.stringify({ candidates: [{ finishReason: "SAFETY", content: {} }] }), {
        status: 200,
      }),
    );
  const error = await assertRejects(
    () =>
      createGeminiChatResponse(
        { instructions: "i", messages: [{ role: "user", content: "q" }] },
        fetcher as unknown as typeof fetch,
      ),
    ApiError,
  );
  assertEquals(error.code, "EMPTY_MODEL_RESPONSE");
  assertEquals(error.details, "SAFETY");
});

Deno.test("a successful call returns text, usage and the resolved model", async () => {
  Deno.env.set("GEMINI_API_KEY", "test-key");
  let sentUrl = "";
  const fetcher = (url: string | URL, init?: RequestInit) => {
    sentUrl = String(url);
    const body = JSON.parse(String(init?.body));
    assertEquals(body.systemInstruction.parts[0].text, "be brief");
    return Promise.resolve(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "The 2-bed is $1,840." }] } }],
          usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 8 },
        }),
        { status: 200 },
      ),
    );
  };
  const result = await createGeminiChatResponse(
    {
      model: "gemini-3.1-flash-lite",
      instructions: "be brief",
      messages: [{ role: "user", content: "price?" }],
    },
    fetcher as unknown as typeof fetch,
  );
  assertEquals(result.content, "The 2-bed is $1,840.");
  assertEquals(result.model, "gemini-3.1-flash-lite");
  assertEquals(result.usage.outputTokens, 8);
  assertEquals(sentUrl.includes("gemini-3.1-flash-lite:generateContent"), true);
});
