import {
  createAdminClient,
  requireProject,
  requireProjectRole,
  requireUser,
} from "../_shared/auth.ts";
import { hashText, normalizeText } from "../_shared/chunking.ts";
import { ApiError, apiHandler, jsonResponse, requireMethod } from "../_shared/errors.ts";
import { findDuplicateSource, ingestSource } from "../_shared/ingestion.ts";
import { readJson, stringField, uuidField } from "../_shared/validation.ts";

const SOURCE_LIST_FIELDS = [
  "id",
  "project_id",
  "created_by",
  "source_type",
  "title",
  "storage_path",
  "original_filename",
  "mime_type",
  "file_size_bytes",
  "content_hash",
  "embedding_model",
  "status",
  "error_message",
  "created_at",
  "updated_at",
].join(",");

Deno.serve(apiHandler(async (req) => {
  requireMethod(req, ["GET", "POST", "DELETE"]);
  const { user, supabase } = await requireUser(req);
  const admin = createAdminClient();
  const url = new URL(req.url);

  if (req.method === "GET") {
    const projectId = url.searchParams.get("project_id");
    if (!projectId) throw new ApiError(400, "VALIDATION_ERROR", "project_id is required.");
    await requireProject(supabase, projectId);
    const { data, error } = await supabase.from("knowledge_sources").select(SOURCE_LIST_FIELDS)
      .eq("project_id", projectId).order("created_at", { ascending: false });
    if (error) {
      throw new ApiError(500, "DATABASE_ERROR", "Could not list knowledge sources.", error.message);
    }
    return jsonResponse({ sources: data ?? [] });
  }

  if (req.method === "DELETE") {
    const sourceId = url.searchParams.get("source_id");
    if (!sourceId) throw new ApiError(400, "VALIDATION_ERROR", "source_id is required.");
    const { data: source, error: sourceError } = await supabase.from("knowledge_sources")
      .select("id,project_id,storage_path").eq("id", sourceId).maybeSingle();
    if (sourceError) throw new ApiError(500, "DATABASE_ERROR", "Could not read the source.");
    if (!source) {
      throw new ApiError(404, "SOURCE_NOT_FOUND", "Knowledge source not found or access denied.");
    }
    await requireProjectRole(supabase, source.project_id, ["owner", "admin"]);
    if (source.storage_path) {
      const { error } = await supabase.storage.from("project-files").remove([source.storage_path]);
      if (error) {
        throw new ApiError(
          502,
          "STORAGE_ERROR",
          "The source file could not be deleted.",
          error.message,
        );
      }
    }
    const { error } = await supabase.from("knowledge_sources").delete().eq("id", sourceId);
    if (error) {
      throw new ApiError(500, "DATABASE_ERROR", "Could not delete the source.", error.message);
    }
    return jsonResponse({ deleted: true });
  }

  const input = await readJson(req);
  const projectId = uuidField(input, "project_id")!;
  const title = stringField(input, "title", { max: 300 });
  const text = stringField(input, "text", { required: true, min: 1, trim: false })!;
  const project = await requireProject(supabase, projectId);
  const normalized = normalizeText(text);
  if (!normalized) throw new ApiError(400, "EMPTY_CONTEXT", "Context must contain text.");
  if (normalized.length > project.max_context_chars_per_source) {
    throw new ApiError(
      413,
      "CONTEXT_LIMIT_EXCEEDED",
      "Context exceeds this project's character limit.",
    );
  }
  const contentHash = await hashText(normalized);
  const duplicate = await findDuplicateSource(admin, projectId, contentHash);
  if (duplicate) return jsonResponse({ source: duplicate, deduplicated: true });

  const { data: source, error } = await supabase.from("knowledge_sources").insert({
    project_id: projectId,
    created_by: user.id,
    source_type: "text",
    title: title ?? "Text context",
    status: "pending",
  }).select("*").single();
  if (error) {
    throw new ApiError(
      500,
      "DATABASE_ERROR",
      "Could not create the knowledge source.",
      error.message,
    );
  }

  try {
    const result = await ingestSource({
      admin,
      sourceId: source.id,
      project,
      userId: user.id,
      text: normalized,
      storeRawText: true,
      contentHash,
    });
    return jsonResponse({
      source: result.source,
      chunk_count: result.chunkCount,
      usage: { estimated_cost: result.embeddingCost },
      deduplicated: false,
    }, 201);
  } catch (error) {
    await admin.from("knowledge_sources").update({
      status: "failed",
      error_message: error instanceof Error ? error.message.slice(0, 2000) : "Ingestion failed",
    }).eq("id", source.id);
    throw error;
  }
}));
