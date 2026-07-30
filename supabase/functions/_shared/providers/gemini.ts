import { ApiError } from "../errors.ts";
import type { ConversationMessage } from "../types.ts";
// Type-only, so it is erased at runtime and creates no import cycle with
// openai.ts (which imports this module).
import type { TokenUsage } from "../openai.ts";

/**
 * Chat generation and embeddings via the Gemini API.
 *
 * Embeddings are truncated to 1536 dimensions with `outputDimensionality` so
 * they fit the existing `knowledge_chunks.embedding vector(1536)` column — no
 * migration needed. Switching provider still invalidates previously stored
 * vectors, which live in a different embedding space and must be re-embedded.
 */

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

export const DEFAULT_GEMINI_CHAT_MODEL = "gemini-3.1-flash-lite";

type Fetcher = typeof fetch;

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    cachedContentTokenCount?: number;
    candidatesTokenCount?: number;
  };
  error?: { message?: string; status?: string };
}

export function geminiApiKey(): string {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) {
    throw new ApiError(
      500,
      "SERVER_MISCONFIGURED",
      "GEMINI_API_KEY is not configured.",
    );
  }
  return key;
}

/**
 * Callers pass `projects.default_model`, which the schema constrains to OpenAI
 * ids (`gpt-5.4-nano` / `gpt-5.4-mini`). Forwarding one of those to Gemini
 * produces a 404, so a requested model is only honoured when it actually is a
 * Gemini id; otherwise the configured Gemini model wins.
 */
export function getGeminiChatModel(requested?: string | null): string {
  const candidate = requested?.trim();
  if (candidate && candidate.toLowerCase().startsWith("gemini-")) return candidate;
  return Deno.env.get("GEMINI_CHAT_MODEL")?.trim() || DEFAULT_GEMINI_CHAT_MODEL;
}

/**
 * Gemini has no "assistant" role — replies are `model` — and the system prompt
 * is a separate `systemInstruction` rather than a message.
 */
export function toGeminiContents(messages: ConversationMessage[]) {
  return messages.map((message) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: message.content }],
  }));
}

export function readGeminiText(payload: GeminiResponse): string {
  return (payload.candidates ?? [])
    .flatMap((candidate) => candidate.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
}

export function readGeminiUsage(payload: GeminiResponse): TokenUsage {
  const usage = payload.usageMetadata ?? {};
  const inputTokens = usage.promptTokenCount ?? 0;
  const cached = usage.cachedContentTokenCount ?? 0;
  return {
    inputTokens,
    // Never report more cached than total; downstream cost maths subtracts them.
    cachedInputTokens: Math.min(cached, inputTokens),
    outputTokens: usage.candidatesTokenCount ?? 0,
  };
}

export async function createGeminiChatResponse(
  options: {
    model?: string | null;
    instructions: string;
    messages: ConversationMessage[];
    maxOutputTokens?: number;
  },
  fetcher: Fetcher = fetch,
): Promise<{ content: string; usage: TokenUsage; model: string }> {
  const model = getGeminiChatModel(options.model);

  const response = await fetcher(
    `${API_BASE}/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": geminiApiKey(),
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: options.instructions }] },
        contents: toGeminiContents(options.messages),
        generationConfig: { maxOutputTokens: options.maxOutputTokens ?? 800 },
      }),
    },
  );

  const raw = await response.text();
  let payload: GeminiResponse;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    throw new ApiError(502, "INVALID_MODEL_RESPONSE", "Gemini returned a malformed response.");
  }

  if (!response.ok) {
    const detail = payload.error?.message ?? raw.slice(0, 300);
    // A wrong model id is the most common setup mistake, and Gemini reports it
    // as a plain 404 — surface it as something actionable.
    if (response.status === 404) {
      throw new ApiError(
        502,
        "MODEL_NOT_FOUND",
        `Gemini has no model "${model}". Set GEMINI_CHAT_MODEL to a valid id.`,
        detail,
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new ApiError(502, "MODEL_AUTH_FAILED", "Gemini rejected the API key.", detail);
    }
    if (response.status === 429) {
      throw new ApiError(429, "MODEL_RATE_LIMITED", "Gemini rate limit reached.", detail);
    }
    throw new ApiError(502, "MODEL_REQUEST_FAILED", "Gemini request failed.", detail);
  }

  const content = readGeminiText(payload);
  if (!content) {
    const finish = payload.candidates?.[0]?.finishReason;
    throw new ApiError(
      502,
      "EMPTY_MODEL_RESPONSE",
      finish === "SAFETY"
        ? "Gemini blocked the response under its safety filters."
        : "Gemini returned no text response.",
      finish,
    );
  }

  return { content, model, usage: readGeminiUsage(payload) };
}

export const DEFAULT_GEMINI_EMBEDDING_MODEL = "gemini-embedding-001";

/** Fixed by `knowledge_chunks.embedding extensions.vector(1536)`. */
const EMBEDDING_DIMENSIONS = 1536;

export function getGeminiEmbeddingModel(): string {
  return Deno.env.get("GEMINI_EMBEDDING_MODEL")?.trim() || DEFAULT_GEMINI_EMBEDDING_MODEL;
}

/**
 * Gemini normalises its full-width vectors, but a truncated
 * `outputDimensionality` comes back un-normalised (L2 ≈ 0.7 at 1536). Cosine
 * search does not care about magnitude, but OpenAI and the mock both return
 * unit vectors — matching them keeps the stored data uniform and keeps any
 * future switch to an inner-product operator correct.
 */
export function normalizeVector(values: number[]): number[] {
  const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (!magnitude) return values;
  return values.map((value) => value / magnitude);
}

export async function createGeminiEmbeddings(
  inputs: string[],
  fetcher: Fetcher = fetch,
): Promise<{ embeddings: number[][]; inputTokens: number; model: string }> {
  const model = getGeminiEmbeddingModel();
  const key = geminiApiKey();

  // batchEmbedContents keeps one round trip per ingest batch.
  const response = await fetcher(
    `${API_BASE}/models/${encodeURIComponent(model)}:batchEmbedContents`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        requests: inputs.map((text) => ({
          model: `models/${model}`,
          content: { parts: [{ text }] },
          outputDimensionality: EMBEDDING_DIMENSIONS,
        })),
      }),
    },
  );

  const raw = await response.text();
  let payload: { embeddings?: Array<{ values?: number[] }>; error?: { message?: string } };
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    throw new ApiError(502, "INVALID_EMBEDDING_RESPONSE", "Gemini returned a malformed response.");
  }

  if (!response.ok) {
    const detail = payload.error?.message ?? raw.slice(0, 300);
    if (response.status === 401 || response.status === 403) {
      throw new ApiError(502, "MODEL_AUTH_FAILED", "Gemini rejected the API key.", detail);
    }
    if (response.status === 429) {
      throw new ApiError(429, "MODEL_RATE_LIMITED", "Gemini embedding rate limit reached.", detail);
    }
    throw new ApiError(502, "EMBEDDING_REQUEST_FAILED", "Gemini embedding request failed.", detail);
  }

  const vectors = (payload.embeddings ?? []).map((item) => item.values ?? []);
  if (vectors.length !== inputs.length || vectors.some((v) => v.length !== EMBEDDING_DIMENSIONS)) {
    throw new ApiError(
      502,
      "INVALID_EMBEDDING_RESPONSE",
      `Gemini returned embeddings that do not match ${EMBEDDING_DIMENSIONS} dimensions.`,
    );
  }

  return {
    embeddings: vectors.map(normalizeVector),
    // Gemini's embed endpoints do not report token usage.
    inputTokens: 0,
    model,
  };
}
