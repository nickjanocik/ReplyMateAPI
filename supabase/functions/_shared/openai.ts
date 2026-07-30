import { ApiError } from "./errors.ts";
import {
  createGeminiChatResponse,
  createGeminiEmbeddings,
  getGeminiChatModel,
  getGeminiEmbeddingModel,
} from "./providers/gemini.ts";
import type { ConversationMessage } from "./types.ts";

const API_BASE = "https://api.openai.com/v1";
const EMBEDDING_DIMENSIONS = 1536;

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

interface ModelPrice {
  input: number;
  cachedInput: number;
  output: number;
}

// USD per one million tokens, reviewed 2026-06-21. Estimates are not invoices.
export const CHAT_MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "gpt-5.4-nano": { input: 0.20, cachedInput: 0.02, output: 1.25 },
  "gpt-5.4-mini": { input: 0.75, cachedInput: 0.075, output: 4.50 },
};

export const EMBEDDING_MODEL_PRICES: Readonly<Record<string, number>> = {
  "text-embedding-3-small": 0.02,
};

type Fetcher = typeof fetch;

/**
 * Which service generates chat replies.
 *
 * Only generation is switchable. Embeddings stay on OpenAI because
 * `knowledge_chunks.embedding` is a fixed `extensions.vector(1536)` column and
 * the match RPCs are typed to it — moving those to another provider needs a
 * migration plus a re-embed of every existing chunk.
 */
export function chatProvider(): "openai" | "gemini" {
  const provider = (Deno.env.get("LLM_PROVIDER") ?? "openai").toLowerCase();
  if (provider === "openai" || provider === "gemini") return provider;
  throw new ApiError(500, "SERVER_MISCONFIGURED", "LLM_PROVIDER must be openai or gemini.");
}

/**
 * Per-million-token prices for the configured Gemini model, read from the
 * environment. Deliberately not hardcoded: publishing a wrong rate would make
 * every usage estimate quietly wrong, so an unset price reports 0 instead.
 */
function geminiPrice(): ModelPrice | null {
  const input = Number(Deno.env.get("GEMINI_INPUT_PRICE_PER_MTOK") ?? "");
  const output = Number(Deno.env.get("GEMINI_OUTPUT_PRICE_PER_MTOK") ?? "");
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  const cached = Number(Deno.env.get("GEMINI_CACHED_INPUT_PRICE_PER_MTOK") ?? "");
  return { input, cachedInput: Number.isFinite(cached) ? cached : input, output };
}

function providerMode(): "live" | "mock" {
  const mode = (Deno.env.get("OPENAI_MODE") ?? "live").toLowerCase();
  if (mode === "live" || mode === "mock") return mode;
  throw new ApiError(500, "SERVER_MISCONFIGURED", "OPENAI_MODE must be live or mock.");
}

function hashToken(token: string): number {
  let value = 2166136261;
  for (let index = 0; index < token.length; index++) {
    value ^= token.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

function mockEmbedding(input: string): number[] {
  const vector = Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  const words = input.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const features = [
    ...words,
    ...words.slice(0, -1).map((word, index) => `${word}_${words[index + 1]}`),
  ];
  for (const feature of features) vector[hashToken(feature) % EMBEDDING_DIMENSIONS] += 1;
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude) return vector.map((value) => value / magnitude);
  vector[0] = 1;
  return vector;
}

function mockChatContent(instructions: string, messages: ConversationMessage[]): string {
  const latest = messages.at(-1)?.content ?? "";
  if (instructions.includes("drafting a consented business SMS")) {
    const name = latest.match(/^Contact name:\s*(.+)$/m)?.[1]?.trim();
    const goal = latest.match(/^Outreach goal:\s*([\s\S]+)$/m)?.[1]?.trim() ||
      "Thank you for connecting with us.";
    const greeting = name && name !== "unknown" ? `Hi ${name}, ` : "Hi, ";
    return `${greeting}${goal}`.slice(0, 480);
  }
  const context = instructions.split("Retrieved project context:\n")[1];
  if (!context) {
    return "I don't have relevant project context to answer that yet.";
  }
  const grounded = context.replace(/^\[Source[^\n]*\]\s*/gm, "").replace(/\s+/g, " ").trim();
  if (!grounded) return "I don't have relevant project context to answer that yet.";
  return `Based on the project context: ${grounded.slice(0, 700)}`;
}

function apiKey(): string {
  const value = Deno.env.get("OPENAI_API_KEY");
  if (!value) throw new ApiError(500, "SERVER_MISCONFIGURED", "OPENAI_API_KEY is not configured.");
  return value;
}

export function getChatModel(requested?: string | null): string {
  // Gemini ids are validated by Gemini itself; the OpenAI price table does not
  // apply to them.
  if (chatProvider() === "gemini") return getGeminiChatModel(requested);
  const model = requested || Deno.env.get("OPENAI_CHAT_MODEL") || "gpt-5.4-nano";
  if (!CHAT_MODEL_PRICES[model]) {
    throw new ApiError(
      400,
      "UNSUPPORTED_MODEL",
      "The configured chat model is not approved or priced.",
    );
  }
  return model;
}

export function getEmbeddingModel(): string {
  if (chatProvider() === "gemini") return getGeminiEmbeddingModel();
  const model = Deno.env.get("OPENAI_EMBEDDING_MODEL") || "text-embedding-3-small";
  if (!EMBEDDING_MODEL_PRICES[model]) {
    throw new ApiError(
      500,
      "UNSUPPORTED_EMBEDDING_MODEL",
      "The embedding model must be text-embedding-3-small in v1.",
    );
  }
  return model;
}

async function openAIRequest<T>(
  path: string,
  body: unknown,
  fetcher: Fetcher,
): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "authorization": `Bearer ${apiKey()}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (error) {
    throw new ApiError(502, "OPENAI_UNAVAILABLE", "OpenAI could not be reached.", String(error));
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const providerError = payload && typeof payload === "object" && "error" in payload
      ? (payload as { error: Record<string, unknown> }).error
      : null;
    const providerMessage = typeof providerError?.message === "string"
      ? providerError.message
      : `HTTP ${response.status}`;
    const providerCode = typeof providerError?.code === "string" ? providerError.code : null;
    const providerType = typeof providerError?.type === "string" ? providerError.type : null;

    if (providerCode === "insufficient_quota" || providerType === "insufficient_quota") {
      throw new ApiError(
        502,
        "OPENAI_QUOTA_EXCEEDED",
        "OpenAI quota is exhausted for the configured API key.",
        providerMessage,
      );
    }
    if (providerCode === "model_not_found" || providerCode === "invalid_model") {
      throw new ApiError(
        502,
        "OPENAI_MODEL_UNAVAILABLE",
        "The configured OpenAI model is not available to this API key.",
        providerMessage,
      );
    }
    if (providerCode === "rate_limit_exceeded" || providerType === "rate_limit_exceeded") {
      throw new ApiError(
        502,
        "OPENAI_RATE_LIMITED",
        "OpenAI rate limited the request.",
        providerMessage,
      );
    }
    throw new ApiError(
      502,
      "OPENAI_ERROR",
      "The model provider rejected the request.",
      providerMessage,
    );
  }
  return payload as T;
}

interface EmbeddingsResponse {
  data: Array<{ index: number; embedding: number[] }>;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

export async function createEmbeddings(
  inputs: string[],
  fetcher: Fetcher = fetch,
): Promise<{ embeddings: number[][]; inputTokens: number; model: string }> {
  if (!inputs.length) {
    throw new ApiError(400, "EMPTY_EMBEDDING_INPUT", "Embedding input cannot be empty.");
  }
  const model = getEmbeddingModel();
  if (providerMode() === "mock") {
    return {
      embeddings: inputs.map(mockEmbedding),
      inputTokens: inputs.reduce((sum, input) => sum + Math.ceil(input.length / 4), 0),
      model,
    };
  }
  if (chatProvider() === "gemini") {
    return await createGeminiEmbeddings(inputs, fetcher);
  }

  const payload = await openAIRequest<EmbeddingsResponse>("/embeddings", {
    model,
    input: inputs,
    dimensions: EMBEDDING_DIMENSIONS,
    encoding_format: "float",
  }, fetcher);

  const ordered = [...payload.data].sort((a, b) => a.index - b.index).map((item) => item.embedding);
  if (
    ordered.length !== inputs.length ||
    ordered.some((value) => value.length !== EMBEDDING_DIMENSIONS)
  ) {
    throw new ApiError(
      502,
      "INVALID_EMBEDDING_RESPONSE",
      "OpenAI returned incompatible embeddings.",
    );
  }
  return { embeddings: ordered, inputTokens: payload.usage?.total_tokens ?? 0, model };
}

interface ResponsesResponse {
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  usage?: {
    input_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens?: number;
  };
}

export async function createChatResponse(
  options: {
    model: string;
    instructions: string;
    messages: ConversationMessage[];
    maxOutputTokens?: number;
  },
  fetcher: Fetcher = fetch,
): Promise<{ content: string; usage: TokenUsage; model: string }> {
  const model = getChatModel(options.model);
  if (providerMode() === "mock") {
    const content = mockChatContent(options.instructions, options.messages);
    return {
      content,
      model,
      usage: {
        inputTokens: Math.ceil(
          (options.instructions.length + options.messages.reduce(
            (sum, message) => sum + message.content.length,
            0,
          )) / 4,
        ),
        cachedInputTokens: 0,
        outputTokens: Math.ceil(content.length / 4),
      },
    };
  }
  if (chatProvider() === "gemini") {
    return await createGeminiChatResponse({
      model: options.model,
      instructions: options.instructions,
      messages: options.messages,
      maxOutputTokens: options.maxOutputTokens,
    }, fetcher);
  }

  const payload = await openAIRequest<ResponsesResponse>("/responses", {
    model,
    instructions: options.instructions,
    input: options.messages,
    max_output_tokens: options.maxOutputTokens ?? 800,
    store: false,
  }, fetcher);

  const content = (payload.output ?? []).flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "output_text" && typeof part.text === "string")
    .map((part) => part.text).join("\n").trim();
  if (!content) {
    throw new ApiError(502, "EMPTY_MODEL_RESPONSE", "OpenAI returned no text response.");
  }

  return {
    content,
    model,
    usage: {
      inputTokens: payload.usage?.input_tokens ?? 0,
      cachedInputTokens: payload.usage?.input_tokens_details?.cached_tokens ?? 0,
      outputTokens: payload.usage?.output_tokens ?? 0,
    },
  };
}

export function estimateChatCost(model: string, usage: TokenUsage): number {
  const price = CHAT_MODEL_PRICES[model] ??
    (chatProvider() === "gemini" ? geminiPrice() : null);
  if (!price) throw new ApiError(500, "UNPRICED_MODEL", `No pricing is configured for ${model}.`);
  const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const regular = usage.inputTokens - cached;
  return (regular * price.input + cached * price.cachedInput + usage.outputTokens * price.output) /
    1_000_000;
}

export function estimateEmbeddingCost(model: string, inputTokens: number): number {
  if (chatProvider() === "gemini") {
    const rate = Number(Deno.env.get("GEMINI_EMBEDDING_PRICE_PER_MTOK") ?? "");
    return (Number.isFinite(rate) ? rate : 0) * (inputTokens / 1_000_000);
  }
  const price = EMBEDDING_MODEL_PRICES[model];
  if (price === undefined) {
    throw new ApiError(500, "UNPRICED_MODEL", `No pricing is configured for ${model}.`);
  }
  return inputTokens * price / 1_000_000;
}
