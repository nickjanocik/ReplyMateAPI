import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { ApiError } from "./errors.ts";
import type { Project, ProjectRole } from "./types.ts";

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new ApiError(500, "SERVER_MISCONFIGURED", `${name} is not configured.`);
  return value;
}

export function bearerToken(req: Request): string {
  const authorization = req.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new ApiError(401, "AUTH_REQUIRED", "A Supabase user access token is required.");
  return match[1];
}

export function createUserClient(req: Request): SupabaseClient {
  const token = bearerToken(req);
  return createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_ANON_KEY"), {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export function createAdminClient(): SupabaseClient {
  return createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export async function requireUser(req: Request): Promise<{
  user: User;
  token: string;
  supabase: SupabaseClient;
}> {
  const token = bearerToken(req);
  const supabase = createUserClient(req);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    throw new ApiError(401, "INVALID_TOKEN", "The access token is invalid or expired.");
  }
  return { user: data.user, token, supabase };
}

export async function requireProject(
  supabase: SupabaseClient,
  projectId: string,
): Promise<Project> {
  const { data, error } = await supabase.from("projects").select("*").eq("id", projectId)
    .maybeSingle();
  if (error) {
    throw new ApiError(500, "DATABASE_ERROR", "Could not read the project.", error.message);
  }
  if (!data) throw new ApiError(404, "PROJECT_NOT_FOUND", "Project not found or access denied.");
  return data as Project;
}

export async function requireProjectRole(
  supabase: SupabaseClient,
  projectId: string,
  allowed: ProjectRole[],
): Promise<ProjectRole> {
  const { data, error } = await supabase.from("project_members").select("role")
    .eq("project_id", projectId).maybeSingle();
  if (error) {
    throw new ApiError(500, "DATABASE_ERROR", "Could not verify project access.", error.message);
  }
  const role = data?.role as ProjectRole | undefined;
  if (!role) throw new ApiError(404, "PROJECT_NOT_FOUND", "Project not found or access denied.");
  if (!allowed.includes(role)) {
    throw new ApiError(403, "FORBIDDEN", "Your project role cannot perform this action.");
  }
  return role;
}
