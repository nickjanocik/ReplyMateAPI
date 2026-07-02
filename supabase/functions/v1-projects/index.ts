import { ApiError, apiHandler, jsonResponse, requireMethod } from "../_shared/errors.ts";
import {
  createAdminClient,
  requireProject,
  requireProjectRole,
  requireUser,
} from "../_shared/auth.ts";
import {
  enumField,
  integerField,
  readJson,
  stringField,
  uuidField,
} from "../_shared/validation.ts";
import type { JsonRecord } from "../_shared/types.ts";

const PROJECT_FIELDS = [
  "id",
  "owner_id",
  "name",
  "description",
  "agent_name",
  "agent_instructions",
  "default_model",
  "status",
  "max_context_chars_per_source",
  "max_chunks_per_project",
  "max_chat_messages_per_day",
  "max_file_size_mb",
  "created_at",
  "updated_at",
].join(",");

function nullableString(input: JsonRecord, key: string, max: number): string | null | undefined {
  if (!(key in input)) return undefined;
  if (input[key] === null) return null;
  return stringField(input, key, { max });
}

function projectValues(input: JsonRecord, creating: boolean): JsonRecord {
  const values: JsonRecord = {};
  const name = stringField(input, "name", { required: creating, min: 1, max: 120 });
  const description = nullableString(input, "description", 2000);
  const agentName = stringField(input, "agent_name", { min: 1, max: 120 });
  const instructions = nullableString(input, "agent_instructions", 12000);
  const model = enumField(input, "default_model", ["gpt-5.4-nano", "gpt-5.4-mini"] as const);
  const status = enumField(input, "status", ["active", "archived"] as const);
  const maxChars = integerField(input, "max_context_chars_per_source", { min: 1000, max: 500000 });
  const maxChunks = integerField(input, "max_chunks_per_project", { min: 1, max: 5000 });
  const maxChats = integerField(input, "max_chat_messages_per_day", { min: 1, max: 1000 });
  const maxFile = integerField(input, "max_file_size_mb", { min: 1, max: 10 });
  if (name !== undefined) values.name = name;
  if (description !== undefined) values.description = description;
  if (agentName !== undefined) values.agent_name = agentName;
  if (instructions !== undefined) values.agent_instructions = instructions;
  if (model !== undefined) values.default_model = model;
  if (status !== undefined) values.status = status;
  if (maxChars !== undefined) values.max_context_chars_per_source = maxChars;
  if (maxChunks !== undefined) values.max_chunks_per_project = maxChunks;
  if (maxChats !== undefined) values.max_chat_messages_per_day = maxChats;
  if (maxFile !== undefined) values.max_file_size_mb = maxFile;
  return values;
}

async function listMembers(
  projectId: string,
  supabase: Awaited<ReturnType<typeof requireUser>>["supabase"],
) {
  await requireProject(supabase, projectId);
  const { data: members, error } = await supabase.from("project_members")
    .select("id,user_id,role,created_at").eq("project_id", projectId).order("created_at");
  if (error) {
    throw new ApiError(500, "DATABASE_ERROR", "Could not list project members.", error.message);
  }
  const ids = (members ?? []).map((member) => member.user_id as string);
  const admin = createAdminClient();
  const { data: profiles, error: profileError } = ids.length
    ? await admin.from("profiles").select("id,email,full_name").in("id", ids)
    : { data: [], error: null };
  if (profileError) throw new ApiError(500, "DATABASE_ERROR", "Could not load member profiles.");
  const byId = new Map((profiles ?? []).map((profile) => [profile.id, profile]));
  return (members ?? []).map((member) => ({
    ...member,
    profile: byId.get(member.user_id) ?? null,
  }));
}

Deno.serve(apiHandler(async (req) => {
  requireMethod(req, ["GET", "POST", "PATCH", "DELETE"]);
  const { user, supabase } = await requireUser(req);
  const url = new URL(req.url);

  if (req.method === "GET") {
    const projectId = url.searchParams.get("project_id");
    if (url.searchParams.get("resource") === "members") {
      if (!projectId) throw new ApiError(400, "VALIDATION_ERROR", "project_id is required.");
      return jsonResponse({ members: await listMembers(projectId, supabase) });
    }
    if (projectId) return jsonResponse({ project: await requireProject(supabase, projectId) });
    const { data, error } = await supabase.from("projects").select(PROJECT_FIELDS).order(
      "updated_at",
      { ascending: false },
    );
    if (error) throw new ApiError(500, "DATABASE_ERROR", "Could not list projects.", error.message);
    return jsonResponse({ projects: data ?? [] });
  }

  if (req.method === "DELETE") {
    const projectId = url.searchParams.get("project_id");
    if (!projectId) throw new ApiError(400, "VALIDATION_ERROR", "project_id is required.");
    const resource = url.searchParams.get("resource");
    const callerRole = await requireProjectRole(supabase, projectId, ["owner", "admin"]);
    if (resource === "members") {
      const targetUserId = url.searchParams.get("user_id");
      if (!targetUserId) throw new ApiError(400, "VALIDATION_ERROR", "user_id is required.");
      const { data: target } = await supabase.from("project_members").select("role")
        .eq("project_id", projectId).eq("user_id", targetUserId).maybeSingle();
      if (!target) throw new ApiError(404, "MEMBER_NOT_FOUND", "Project member not found.");
      if (target.role === "owner" || (callerRole === "admin" && target.role !== "member")) {
        throw new ApiError(403, "FORBIDDEN", "This membership cannot be removed by your role.");
      }
      const { error } = await supabase.from("project_members").delete()
        .eq("project_id", projectId).eq("user_id", targetUserId);
      if (error) {
        throw new ApiError(500, "DATABASE_ERROR", "Could not remove the member.", error.message);
      }
      return jsonResponse({ deleted: true });
    }

    const { data: sources, error: sourceError } = await supabase.from("knowledge_sources")
      .select("storage_path").eq("project_id", projectId).not("storage_path", "is", null);
    if (sourceError) {
      throw new ApiError(500, "DATABASE_ERROR", "Could not prepare project deletion.");
    }
    const paths = (sources ?? []).map((source) => source.storage_path as string).filter(Boolean);
    if (paths.length) {
      const { error } = await supabase.storage.from("project-files").remove(paths);
      if (error) {
        throw new ApiError(
          502,
          "STORAGE_ERROR",
          "Project files could not be deleted.",
          error.message,
        );
      }
    }
    const { error } = await supabase.from("projects").delete().eq("id", projectId);
    if (error) {
      throw new ApiError(500, "DATABASE_ERROR", "Could not delete the project.", error.message);
    }
    return jsonResponse({ deleted: true });
  }

  const input = await readJson(req);
  if (req.method === "POST" && input.action === "add_member") {
    const projectId = uuidField(input, "project_id")!;
    const email = stringField(input, "email", { required: true, min: 3, max: 320 })!.toLowerCase();
    const role = enumField(input, "role", ["admin", "member"] as const, true)!;
    const callerRole = await requireProjectRole(supabase, projectId, ["owner", "admin"]);
    if (callerRole === "admin" && role !== "member") {
      throw new ApiError(403, "FORBIDDEN", "Admins may only add members.");
    }
    const admin = createAdminClient();
    const { data: profile, error: profileError } = await admin.from("profiles")
      .select("id,email,full_name").ilike("email", email).maybeSingle();
    if (profileError) throw new ApiError(500, "DATABASE_ERROR", "Could not look up the user.");
    if (!profile) {
      throw new ApiError(404, "USER_NOT_FOUND", "No registered user has that email address.");
    }
    if (profile.id === user.id) {
      throw new ApiError(409, "ALREADY_MEMBER", "You already belong to this project.");
    }
    const { data, error } = await admin.from("project_members").insert({
      project_id: projectId,
      user_id: profile.id,
      role,
    }).select("id,user_id,role,created_at").single();
    if (error?.code === "23505") {
      throw new ApiError(409, "ALREADY_MEMBER", "That user is already a project member.");
    }
    if (error) {
      throw new ApiError(500, "DATABASE_ERROR", "Could not add the member.", error.message);
    }
    return jsonResponse({ member: { ...data, profile } }, 201);
  }

  if (req.method === "PATCH" && input.action === "update_member") {
    const projectId = uuidField(input, "project_id")!;
    const targetUserId = uuidField(input, "user_id")!;
    const role = enumField(input, "role", ["admin", "member"] as const, true)!;
    const callerRole = await requireProjectRole(supabase, projectId, ["owner", "admin"]);
    const { data: target } = await supabase.from("project_members").select("role")
      .eq("project_id", projectId).eq("user_id", targetUserId).maybeSingle();
    if (!target) throw new ApiError(404, "MEMBER_NOT_FOUND", "Project member not found.");
    if (target.role === "owner" || callerRole === "admin") {
      throw new ApiError(403, "FORBIDDEN", "Only the owner can change admin/member roles.");
    }
    const { data, error } = await supabase.from("project_members").update({ role })
      .eq("project_id", projectId).eq("user_id", targetUserId)
      .select("id,user_id,role,created_at").single();
    if (error) {
      throw new ApiError(500, "DATABASE_ERROR", "Could not update the member.", error.message);
    }
    return jsonResponse({ member: data });
  }

  if (req.method === "POST") {
    const values = projectValues(input, true);
    const admin = createAdminClient();
    const { data, error } = await admin.from("projects").insert({ ...values, owner_id: user.id })
      .select(PROJECT_FIELDS).single();
    if (error) {
      throw new ApiError(500, "DATABASE_ERROR", "Could not create the project.", error.message);
    }
    return jsonResponse({ project: data }, 201);
  }

  const projectId = uuidField(input, "project_id")!;
  await requireProjectRole(supabase, projectId, ["owner", "admin"]);
  const values = projectValues(input, false);
  if (!Object.keys(values).length) {
    throw new ApiError(400, "VALIDATION_ERROR", "No project fields were supplied.");
  }
  const { data, error } = await supabase.from("projects").update(values).eq("id", projectId)
    .select(PROJECT_FIELDS).single();
  if (error) {
    throw new ApiError(500, "DATABASE_ERROR", "Could not update the project.", error.message);
  }
  return jsonResponse({ project: data });
}));
