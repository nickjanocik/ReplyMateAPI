import type { SupabaseClient } from "@supabase/supabase-js";
import { ApiError } from "./errors.ts";

export type RunType = "chat" | "embedding" | "ingestion" | "outreach_draft" | "outreach_send";

export async function startAgentRun(
  admin: SupabaseClient,
  input: {
    projectId: string;
    conversationId?: string | null;
    userId: string;
    runType: RunType;
    model?: string | null;
  },
): Promise<string> {
  const { data, error } = await admin.from("agent_runs").insert({
    project_id: input.projectId,
    conversation_id: input.conversationId ?? null,
    user_id: input.userId,
    run_type: input.runType,
    model: input.model ?? null,
    status: "pending",
  }).select("id").single();
  if (error) {
    throw new ApiError(500, "USAGE_LOG_ERROR", "Could not start the usage record.", error.message);
  }
  return data.id as string;
}

export async function completeAgentRun(
  admin: SupabaseClient,
  runId: string,
  input: {
    status: "success" | "failed";
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    estimatedCost?: number;
    errorMessage?: string | null;
    model?: string;
  },
): Promise<void> {
  const update: Record<string, unknown> = { status: input.status };
  if (input.inputTokens !== undefined) update.input_tokens = input.inputTokens;
  if (input.cachedInputTokens !== undefined) update.cached_input_tokens = input.cachedInputTokens;
  if (input.outputTokens !== undefined) update.output_tokens = input.outputTokens;
  if (input.estimatedCost !== undefined) update.estimated_cost = input.estimatedCost;
  if (input.errorMessage !== undefined) update.error_message = input.errorMessage;
  if (input.model !== undefined) update.model = input.model;
  const { error } = await admin.from("agent_runs").update(update).eq("id", runId);
  if (error) console.error("Could not complete agent run", runId, error.message);
}

export async function recordUsage(
  admin: SupabaseClient,
  input: {
    projectId: string;
    userId: string;
    runId?: string | null;
    eventType: string;
    quantity: number;
    unit: string;
    estimatedCost: number;
    provider: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const { error } = await admin.from("usage_ledger").insert({
    project_id: input.projectId,
    user_id: input.userId,
    agent_run_id: input.runId ?? null,
    event_type: input.eventType,
    quantity: input.quantity,
    unit: input.unit,
    estimated_cost: input.estimatedCost,
    provider: input.provider,
    metadata: input.metadata ?? {},
  });
  if (error) console.error("Could not write usage ledger", error.message);
}
