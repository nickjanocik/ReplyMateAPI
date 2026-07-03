import { ApiError } from "./errors.ts";
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

function apiKey(): string {
  const value = Deno.env.get("OPENAI_API_KEY");
  if (!value) throw new ApiError(500, "SERVER_MISCONFIGURED", "OPENAI_API_KEY is not configured.");
  return value;
}

export function getChatModel(requested?: string | null): string {
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
    throw new ApiError(502, "OPENAI_ERROR", "The model provider rejected the request.", providerMessage);
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
  const price = CHAT_MODEL_PRICES[model];
  if (!price) throw new ApiError(500, "UNPRICED_MODEL", `No pricing is configured for ${model}.`);
  const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const regular = usage.inputTokens - cached;
  return (regular * price.input + cached * price.cachedInput + usage.outputTokens * price.output) /
    1_000_000;
}

export function estimateEmbeddingCost(model: string, inputTokens: number): number {
  const price = EMBEDDING_MODEL_PRICES[model];
  if (price === undefined) {
    throw new ApiError(500, "UNPRICED_MODEL", `No pricing is configured for ${model}.`);
  }
  return inputTokens * price / 1_000_000;
}
