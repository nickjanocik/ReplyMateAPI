import { createAdminClient, requireUser } from "../_shared/auth.ts";
import {
  chooseCurrentSubscription,
  planSummary,
  securitySummaryFromFactors,
  tenureDays,
} from "../_shared/account.ts";
import { entitlementSummary, loadEntitlement } from "../_shared/entitlements.ts";
import { ApiError, apiHandler, jsonResponse, requireMethod } from "../_shared/errors.ts";
import { readJson, stringField } from "../_shared/validation.ts";
import type { JsonRecord, ProjectRole } from "../_shared/types.ts";

const SAFE_PROFILE_FIELDS = new Set(["full_name"]);

async function securitySummary(
  supabase: Awaited<ReturnType<typeof requireUser>>["supabase"],
  token: string,
): Promise<JsonRecord> {
  const { data, error } = await supabase.auth.mfa.listFactors();
  return securitySummaryFromFactors(token, data as unknown as JsonRecord, !error);
}

async function countProjectRows(
  admin: ReturnType<typeof createAdminClient>,
  table: string,
  projectId: string,
  userFilter?: { user_id: string },
): Promise<number> {
  let query = admin.from(table).select("id", { count: "exact", head: true }).eq(
    "project_id",
    projectId,
  );
  if (userFilter) query = query.eq("user_id", userFilter.user_id);
  const { count, error } = await query;
  if (error) throw new ApiError(500, "DATABASE_ERROR", `Could not count ${table}.`);
  return count ?? 0;
}

async function usageSummary(
  admin: ReturnType<typeof createAdminClient>,
  projectId: string,
): Promise<JsonRecord> {
  const { data, count, error } = await admin.from("usage_ledger")
    .select("estimated_cost", { count: "exact" })
    .eq("project_id", projectId)
    .limit(5000);
  if (error) throw new ApiError(500, "DATABASE_ERROR", "Could not summarize project usage.");
  const estimatedCost = (data ?? []).reduce(
    (sum, row) => sum + Number((row as JsonRecord).estimated_cost ?? 0),
    0,
  );
  return {
    events: count ?? 0,
    estimated_cost: Number(estimatedCost.toFixed(10)),
    cost_sample_limited: (count ?? 0) > (data?.length ?? 0),
  };
}

async function projectSummaries(
  userId: string,
  supabase: Awaited<ReturnType<typeof requireUser>>["supabase"],
): Promise<JsonRecord[]> {
  const { data: memberships, error: membershipError } = await supabase.from("project_members")
    .select("project_id,role,created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (membershipError) {
    throw new ApiError(500, "DATABASE_ERROR", "Could not list project memberships.");
  }
  const projectIds = (memberships ?? []).map((membership) => membership.project_id as string);
  if (!projectIds.length) return [];

  const admin = createAdminClient();
  const { data: projects, error: projectError } = await admin.from("projects")
    .select("id,name,status,agent_name,default_model,created_at,updated_at")
    .in("id", projectIds);
  if (projectError) throw new ApiError(500, "DATABASE_ERROR", "Could not load projects.");
  const projectById = new Map((projects ?? []).map((project) => [project.id as string, project]));

  return await Promise.all((memberships ?? []).map(async (membership) => {
    const projectId = membership.project_id as string;
    const role = membership.role as ProjectRole;
    const project = projectById.get(projectId);
    if (!project) return null;
    const conversationFilter = role === "member" ? { user_id: userId } : undefined;
    const [
      sourceCount,
      readySourceCount,
      failedSourceCount,
      conversationCount,
      agentRunCount,
      usage,
    ] = await Promise.all([
      countProjectRows(admin, "knowledge_sources", projectId),
      admin.from("knowledge_sources").select("id", { count: "exact", head: true })
        .eq("project_id", projectId).eq("status", "ready")
        .then(({ count, error }) => {
          if (error) throw new ApiError(500, "DATABASE_ERROR", "Could not count ready sources.");
          return count ?? 0;
        }),
      admin.from("knowledge_sources").select("id", { count: "exact", head: true })
        .eq("project_id", projectId).eq("status", "failed")
        .then(({ count, error }) => {
          if (error) throw new ApiError(500, "DATABASE_ERROR", "Could not count failed sources.");
          return count ?? 0;
        }),
      countProjectRows(admin, "conversations", projectId, conversationFilter),
      countProjectRows(admin, "agent_runs", projectId),
      usageSummary(admin, projectId),
    ]);
    return {
      ...project,
      role,
      membership_created_at: membership.created_at,
      summary: {
        sources: sourceCount,
        ready_sources: readySourceCount,
        failed_sources: failedSourceCount,
        conversations: conversationCount,
        agent_runs: agentRunCount,
        usage,
      },
    };
  })).then((rows) => rows.filter(Boolean) as JsonRecord[]);
}

Deno.serve(apiHandler(async (req) => {
  requireMethod(req, ["GET", "PATCH"]);
  const { user, token, supabase } = await requireUser(req);

  if (req.method === "PATCH") {
    const input = await readJson(req);
    const unknown = Object.keys(input).filter((key) => !SAFE_PROFILE_FIELDS.has(key));
    if (unknown.length) {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        `Unsupported profile field(s): ${unknown.join(", ")}.`,
      );
    }
    if (!("full_name" in input)) {
      throw new ApiError(400, "VALIDATION_ERROR", "full_name is required.");
    }
    const fullName = input.full_name === null
      ? null
      : stringField(input, "full_name", { min: 1, max: 120 });
    const { data, error } = await supabase.from("profiles").update({ full_name: fullName })
      .eq("id", user.id)
      .select("id,email,full_name,created_at,updated_at")
      .single();
    if (error) throw new ApiError(500, "DATABASE_ERROR", "Could not update the profile.");
    return jsonResponse({ user: { ...data, tenure_days: tenureDays(data.created_at) } });
  }

  const { data: profile, error: profileError } = await supabase.from("profiles")
    .select("id,email,full_name,created_at,updated_at")
    .eq("id", user.id)
    .maybeSingle();
  if (profileError) throw new ApiError(500, "DATABASE_ERROR", "Could not load your profile.");

  const { data: subscriptions, error: subscriptionError } = await supabase.from("subscriptions")
    .select(
      "id,project_id,stripe_customer_id,stripe_subscription_id,plan,status,current_period_start,current_period_end,created_at,updated_at",
    )
    .eq("user_id", user.id);
  if (subscriptionError) {
    throw new ApiError(500, "DATABASE_ERROR", "Could not load your subscription state.");
  }
  const subscription = chooseCurrentSubscription((subscriptions ?? []) as JsonRecord[]);
  const createdAt = profile?.created_at ?? user.created_at;

  // `plan` stays the flat legacy shape the dashboard already renders; `billing`
  // carries the entitlements and meter so the account page does not need a
  // second round trip to /v1-billing just to draw a usage bar.
  const entitlement = await loadEntitlement(createAdminClient(), user.id);

  return jsonResponse({
    billing: entitlementSummary(entitlement),
    user: {
      id: user.id,
      email: profile?.email ?? user.email ?? null,
      full_name: profile?.full_name ?? null,
      created_at: createdAt,
      updated_at: profile?.updated_at ?? null,
      tenure_days: tenureDays(createdAt),
    },
    plan: planSummary(subscription),
    security: await securitySummary(supabase, token),
    projects: await projectSummaries(user.id, supabase),
  });
}));
