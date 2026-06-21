import {
  createAdminClient,
  requireProject,
  requireProjectRole,
  requireUser,
} from "../_shared/auth.ts";
import { hashText, normalizeText, sanitizeFilename } from "../_shared/chunking.ts";
import { ApiError, apiHandler, jsonResponse, requireMethod } from "../_shared/errors.ts";
import { findDuplicateSource, ingestSource } from "../_shared/ingestion.ts";
import {
  enumField,
  integerField,
  readJson,
  stringField,
  uuidField,
} from "../_shared/validation.ts";
import type { KnowledgeSource } from "../_shared/types.ts";

const ALLOWED_MIME_TYPES = ["text/plain", "text/markdown", "text/x-markdown"] as const;

function validateFile(filename: string, mimeType: string): void {
  if (
    !/\.(txt|md|markdown)$/i.test(filename) ||
    !ALLOWED_MIME_TYPES.includes(mimeType as typeof ALLOWED_MIME_TYPES[number])
  ) {
    throw new ApiError(
      415,
      "UNSUPPORTED_FILE_TYPE",
      "Only UTF-8 plain text and Markdown files (.txt, .md, .markdown) are supported in v1.",
    );
  }
}

Deno.serve(apiHandler(async (req) => {
  requireMethod(req, ["POST"]);
  const { user, supabase } = await requireUser(req);
  const admin = createAdminClient();
  const input = await readJson(req);
  const action = enumField(input, "action", ["create_upload", "process"] as const, true)!;

  if (action === "create_upload") {
    const projectId = uuidField(input, "project_id")!;
    const filename = stringField(input, "filename", { required: true, min: 1, max: 240 })!;
    const mimeType = stringField(input, "mime_type", { required: true, min: 3, max: 100 })!
      .toLowerCase();
    const sizeBytes = integerField(input, "size_bytes", {
      required: true,
      min: 1,
      max: 10 * 1024 * 1024,
    })!;
    const title = stringField(input, "title", { max: 300 });
    validateFile(filename, mimeType);
    const project = await requireProject(supabase, projectId);
    if (sizeBytes > project.max_file_size_mb * 1024 * 1024) {
      throw new ApiError(413, "FILE_LIMIT_EXCEEDED", "The file exceeds this project's size limit.");
    }

    const sourceId = crypto.randomUUID();
    const safeFilename = sanitizeFilename(filename);
    const storagePath = `${projectId}/${sourceId}/${safeFilename}`;
    const { data: source, error } = await supabase.from("knowledge_sources").insert({
      id: sourceId,
      project_id: projectId,
      created_by: user.id,
      source_type: "file",
      title: title ?? filename,
      storage_path: storagePath,
      original_filename: filename,
      mime_type: mimeType,
      file_size_bytes: sizeBytes,
      status: "pending",
    }).select("*").single();
    if (error) {
      throw new ApiError(
        500,
        "DATABASE_ERROR",
        "Could not create the upload source.",
        error.message,
      );
    }

    const { data: upload, error: uploadError } = await supabase.storage.from("project-files")
      .createSignedUploadUrl(storagePath, { upsert: false });
    if (uploadError) {
      await admin.from("knowledge_sources").delete().eq("id", sourceId);
      throw new ApiError(
        502,
        "STORAGE_ERROR",
        "Could not create a signed upload URL.",
        uploadError.message,
      );
    }
    return jsonResponse({ source, upload }, 201);
  }

  const sourceId = uuidField(input, "source_id")!;
  const { data: source, error: sourceError } = await supabase.from("knowledge_sources").select("*")
    .eq("id", sourceId).maybeSingle();
  if (sourceError) throw new ApiError(500, "DATABASE_ERROR", "Could not read the upload source.");
  if (!source) {
    throw new ApiError(404, "SOURCE_NOT_FOUND", "Upload source not found or access denied.");
  }
  const typedSource = source as KnowledgeSource;
  if (
    typedSource.source_type !== "file" || !typedSource.storage_path ||
    !typedSource.original_filename || !typedSource.mime_type
  ) {
    throw new ApiError(409, "INVALID_SOURCE", "This source is not a processable file upload.");
  }
  if (typedSource.status === "ready") {
    return jsonResponse({ source: typedSource, already_processed: true });
  }
  if (!(["pending", "failed"] as string[]).includes(typedSource.status)) {
    throw new ApiError(409, "SOURCE_BUSY", "This source is already being processed.");
  }
  const project = await requireProject(supabase, typedSource.project_id);
  const role = await requireProjectRole(supabase, typedSource.project_id, [
    "owner",
    "admin",
    "member",
  ]);
  if (typedSource.created_by !== user.id && role === "member") {
    throw new ApiError(
      403,
      "FORBIDDEN",
      "Only the uploader or a project admin can process this source.",
    );
  }
  validateFile(typedSource.original_filename, typedSource.mime_type);

  const { data: blob, error: downloadError } = await supabase.storage.from("project-files")
    .download(typedSource.storage_path);
  if (downloadError || !blob) {
    throw new ApiError(
      409,
      "UPLOAD_NOT_FOUND",
      "Upload the file before requesting processing.",
      downloadError?.message,
    );
  }
  if (blob.size > project.max_file_size_mb * 1024 * 1024) {
    await admin.storage.from("project-files").remove([typedSource.storage_path]);
    await admin.from("knowledge_sources").update({
      status: "failed",
      error_message: "File exceeds project size limit.",
    })
      .eq("id", sourceId);
    throw new ApiError(
      413,
      "FILE_LIMIT_EXCEEDED",
      "The uploaded file exceeds this project's size limit.",
    );
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(await blob.arrayBuffer());
  } catch {
    throw new ApiError(415, "INVALID_TEXT_ENCODING", "The file must contain valid UTF-8 text.");
  }
  const normalized = normalizeText(text);
  if (!normalized) throw new ApiError(400, "EMPTY_CONTEXT", "The uploaded file contains no text.");
  const contentHash = await hashText(normalized);
  const duplicate = await findDuplicateSource(admin, project.id, contentHash, sourceId);
  if (duplicate) {
    await admin.storage.from("project-files").remove([typedSource.storage_path]);
    await admin.from("knowledge_sources").delete().eq("id", sourceId);
    return jsonResponse({ source: duplicate, deduplicated: true });
  }

  await admin.from("knowledge_sources").update({
    file_size_bytes: blob.size,
    status: "pending",
    error_message: null,
  })
    .eq("id", sourceId);
  try {
    const result = await ingestSource({
      admin,
      sourceId,
      project,
      userId: user.id,
      text: normalized,
      storeRawText: false,
      contentHash,
    });
    return jsonResponse({
      source: result.source,
      chunk_count: result.chunkCount,
      usage: { estimated_cost: result.embeddingCost },
      deduplicated: false,
    });
  } catch (error) {
    await admin.from("knowledge_sources").update({
      status: "failed",
      error_message: error instanceof Error ? error.message.slice(0, 2000) : "Ingestion failed",
    }).eq("id", sourceId);
    throw error;
  }
}));
