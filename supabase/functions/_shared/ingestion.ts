import type { SupabaseClient } from "@supabase/supabase-js";
import { chunkText, hashText, normalizeText } from "./chunking.ts";
import { ApiError } from "./errors.ts";
import { createEmbeddings, estimateEmbeddingCost, getEmbeddingModel } from "./openai.ts";
import type { KnowledgeSource, Project } from "./types.ts";
import { completeAgentRun, recordUsage, startAgentRun } from "./usage.ts";

export async function findDuplicateSource(
  admin: SupabaseClient,
  projectId: string,
  contentHash: string,
  excludeSourceId?: string,
): Promise<KnowledgeSource | null> {
  let query = admin.from("knowledge_sources").select("*").eq("project_id", projectId)
    .eq("content_hash", contentHash).in("status", ["processing", "ready"]);
  if (excludeSourceId) query = query.neq("id", excludeSourceId);
  const { data, error } = await query.limit(1).maybeSingle();
  if (error) {
    throw new ApiError(500, "DATABASE_ERROR", "Could not check duplicate context.", error.message);
  }
  return data as KnowledgeSource | null;
}

export async function ingestSource(input: {
  admin: SupabaseClient;
  sourceId: string;
  project: Project;
  userId: string;
  text: string;
  storeRawText: boolean;
  contentHash?: string;
}): Promise<{ source: KnowledgeSource; chunkCount: number; embeddingCost: number }> {
  const { admin, sourceId, project, userId } = input;
  const normalized = normalizeText(input.text);
  if (!normalized) throw new ApiError(400, "EMPTY_CONTEXT", "Context must contain text.");
  if (normalized.length > project.max_context_chars_per_source) {
    throw new ApiError(
      413,
      "CONTEXT_LIMIT_EXCEEDED",
      "Context exceeds this project's character limit.",
    );
  }

  const chunks = chunkText(normalized);
  if (!chunks.length) throw new ApiError(400, "EMPTY_CONTEXT", "Context must contain text.");
  const { count, error: countError } = await admin.from("knowledge_chunks")
    .select("id", { count: "exact", head: true }).eq("project_id", project.id);
  if (countError) {
    throw new ApiError(500, "DATABASE_ERROR", "Could not check the project chunk limit.");
  }
  if ((count ?? 0) + chunks.length > project.max_chunks_per_project) {
    throw new ApiError(
      409,
      "CHUNK_LIMIT_EXCEEDED",
      "This context would exceed the project's chunk limit.",
    );
  }

  const contentHash = input.contentHash ?? await hashText(normalized);
  const duplicate = await findDuplicateSource(admin, project.id, contentHash, sourceId);
  if (duplicate) {
    throw new ApiError(409, "DUPLICATE_CONTEXT", "This context already exists in the project.", {
      source_id: duplicate.id,
    });
  }

  const { data: job, error: jobError } = await admin.from("job_queue").insert({
    project_id: project.id,
    job_type: "ingest_source",
    payload: { source_id: sourceId },
    status: "queued",
  }).select("id").single();
  if (jobError) throw new ApiError(500, "DATABASE_ERROR", "Could not create the ingestion job.");

  const ingestionRun = await startAgentRun(admin, {
    projectId: project.id,
    userId,
    runType: "ingestion",
  });
  let embeddingRun: string | null = null;

  try {
    await admin.from("job_queue").update({
      status: "processing",
      attempts: 1,
      locked_at: new Date().toISOString(),
    })
      .eq("id", job.id);
    const { error: sourceError } = await admin.from("knowledge_sources").update({
      status: "processing",
      error_message: null,
      content_hash: contentHash,
      embedding_model: getEmbeddingModel(),
      ...(input.storeRawText ? { raw_text: normalized } : {}),
    }).eq("id", sourceId);
    if (sourceError) {
      throw new ApiError(409, "DUPLICATE_CONTEXT", "This context is already being processed.");
    }

    embeddingRun = await startAgentRun(admin, {
      projectId: project.id,
      userId,
      runType: "embedding",
      model: getEmbeddingModel(),
    });
    const embedded = await createEmbeddings(chunks.map((chunk) => chunk.content));
    const embeddingCost = estimateEmbeddingCost(embedded.model, embedded.inputTokens);

    await completeAgentRun(admin, embeddingRun, {
      status: "success",
      inputTokens: embedded.inputTokens,
      estimatedCost: embeddingCost,
      model: embedded.model,
    });
    await recordUsage(admin, {
      projectId: project.id,
      userId,
      runId: embeddingRun,
      eventType: "embedding_tokens",
      quantity: embedded.inputTokens,
      unit: "tokens",
      estimatedCost: embeddingCost,
      provider: "openai",
      metadata: { model: embedded.model, source_id: sourceId, chunks: chunks.length },
    });

    const rows = chunks.map((chunk, index) => ({
      project_id: project.id,
      source_id: sourceId,
      chunk_index: chunk.index,
      content: chunk.content,
      token_count: chunk.tokenCount,
      embedding: embedded.embeddings[index],
      embedding_model: embedded.model,
      metadata: { char_start: chunk.charStart, char_end: chunk.charEnd },
    }));
    const { error: insertError } = await admin.from("knowledge_chunks").insert(rows);
    if (insertError) {
      throw new ApiError(
        500,
        "DATABASE_ERROR",
        "Could not store context chunks.",
        insertError.message,
      );
    }

    const { data: source, error: readyError } = await admin.from("knowledge_sources").update({
      status: "ready",
      error_message: null,
    }).eq("id", sourceId).select("*").single();
    if (readyError) throw new ApiError(500, "DATABASE_ERROR", "Could not finish the source.");

    await admin.from("job_queue").update({ status: "completed", error_message: null }).eq(
      "id",
      job.id,
    );
    await completeAgentRun(admin, ingestionRun, { status: "success" });
    await recordUsage(admin, {
      projectId: project.id,
      userId,
      runId: ingestionRun,
      eventType: "context_chunks_created",
      quantity: chunks.length,
      unit: "chunks",
      estimatedCost: 0,
      provider: "supabase",
      metadata: { source_id: sourceId },
    });
    return { source: source as KnowledgeSource, chunkCount: chunks.length, embeddingCost };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await admin.from("knowledge_chunks").delete().eq("source_id", sourceId);
    await admin.from("knowledge_sources").update({
      status: "failed",
      error_message: message.slice(0, 2000),
    })
      .eq("id", sourceId);
    await admin.from("job_queue").update({
      status: "failed",
      error_message: message.slice(0, 2000),
    })
      .eq("id", job.id);
    await completeAgentRun(admin, ingestionRun, { status: "failed", errorMessage: message });
    if (embeddingRun) {
      await completeAgentRun(admin, embeddingRun, { status: "failed", errorMessage: message });
    }
    throw error;
  }
}
