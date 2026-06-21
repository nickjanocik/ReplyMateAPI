import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import { corsHeaders } from "../_shared/cors.ts";
import { ApiError, apiHandler, jsonResponse } from "../_shared/errors.ts";
import { buildRagInstructions, compactHistory } from "../_shared/rag.ts";
import { readJson, stringField } from "../_shared/validation.ts";

Deno.test("CORS reflects only exact allowed origins", () => {
  const allowed = new Request("https://api.example.test", {
    headers: { origin: "https://app.example.test" },
  });
  assertEquals(
    corsHeaders(allowed, "https://app.example.test").get("access-control-allow-origin"),
    "https://app.example.test",
  );
  const blocked = new Request("https://api.example.test", {
    headers: { origin: "https://evil.example.test" },
  });
  assertThrows(() => corsHeaders(blocked, "https://app.example.test"), ApiError);
});

Deno.test("API handler returns a stable forbidden response for blocked origins", async () => {
  Deno.env.set("ALLOWED_ORIGINS", "https://app.example.test");
  const handler = apiHandler(() => Promise.resolve(jsonResponse({ ok: true })));
  const response = await handler(
    new Request("https://api.example.test", {
      headers: { origin: "https://evil.example.test" },
    }),
  );
  assertEquals(response.status, 403);
  assertEquals((await response.json()).error.code, "ORIGIN_NOT_ALLOWED");
});

Deno.test("validation rejects non-JSON and overlong fields", async () => {
  await new Promise<void>((resolve) => {
    readJson(new Request("https://api.example.test", { method: "POST", body: "{}" }))
      .then(() => {
        throw new Error("expected rejection");
      })
      .catch((error) => {
        assertEquals((error as ApiError).code, "INVALID_CONTENT_TYPE");
        resolve();
      });
  });
  assertThrows(() => stringField({ name: "too long" }, "name", { max: 3 }), ApiError);
});

Deno.test("RAG history and retrieved context stay within budgets", () => {
  const history = compactHistory(
    Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 ? "assistant" as const : "user" as const,
      content: "x".repeat(100),
    })),
    12,
    1000,
  );
  assertEquals(history.length, 10);
  const prompt = buildRagInstructions({
    agentName: "Agent",
    chunks: Array.from({ length: 10 }, (_, index) => ({
      chunk_id: String(index),
      source_id: String(index),
      title: "Source",
      content: "y".repeat(1000),
      metadata: {},
      similarity: 0.8,
    })),
    maxContextChars: 2500,
  });
  assertEquals(prompt.includes("chunk=0"), true);
  assertEquals(prompt.includes("chunk=9"), false);
});
