import {
  createAdminClient,
  requireProject,
  requireProjectRole,
  requireUser,
} from "../_shared/auth.ts";
import { ApiError, apiHandler, jsonResponse, requireMethod } from "../_shared/errors.ts";
import { createChatResponse, estimateChatCost } from "../_shared/openai.ts";
import { generateFormToken, hashFormToken, tokenPreview } from "../_shared/formIntake.ts";
import {
  assertOutreachConsent,
  normalizeE164Phone,
  OUTREACH_CONSENT_STATUSES,
} from "../_shared/outreach.ts";
import { assertReplyAllowance, loadEntitlement } from "../_shared/entitlements.ts";
import { messagingProvider } from "../_shared/providers/index.ts";
import { completeAgentRun, recordUsage, startAgentRun } from "../_shared/usage.ts";
import { enumField, readJson, stringField, uuidField } from "../_shared/validation.ts";
import type { JsonRecord, Project } from "../_shared/types.ts";

const TRIGGER_SOURCES = [
  "manual",
  "google_form",
  "google_forms_simulation",
  "api_simulation",
] as const;

/** Shape returned to the dashboard; never includes the stored token hash. */
function presentFormSource(row: JsonRecord, plaintextToken?: string): JsonRecord {
  return {
    id: row.id,
    project_id: row.project_id,
    label: row.label ?? null,
    token_preview: row.token_preview,
    status: row.status,
    response_count: row.response_count ?? 0,
    last_response_at: row.last_response_at ?? null,
    created_at: row.created_at,
    ...(plaintextToken ? { token: plaintextToken } : {}),
  };
}

async function contactForProject(
  admin: ReturnType<typeof createAdminClient>,
  projectId: string,
  contactId: string,
): Promise<JsonRecord> {
  const { data, error } = await admin.from("contacts").select("*")
    .eq("id", contactId).eq("project_id", projectId).maybeSingle();
  if (error) throw new ApiError(500, "DATABASE_ERROR", "Could not load the contact.");
  if (!data) throw new ApiError(404, "CONTACT_NOT_FOUND", "Contact not found in this project.");
  return data as JsonRecord;
}

async function createDraft(input: {
  admin: ReturnType<typeof createAdminClient>;
  project: Project;
  userId: string;
  contact: JsonRecord;
  goal: string;
}): Promise<string> {
  const runId = await startAgentRun(input.admin, {
    projectId: input.project.id,
    userId: input.userId,
    runType: "outreach_draft",
    model: input.project.default_model,
  });
  try {
    const result = await createChatResponse({
      model: input.project.default_model,
      instructions: [
        `You are ${input.project.agent_name}, drafting a consented business SMS.`,
        "Return only the message body. Be truthful, helpful, and concise (at most 480 characters).",
        "Do not claim the message was sent. Do not invent offers or customer facts.",
        input.project.agent_instructions ?? "",
      ].filter(Boolean).join("\n"),
      messages: [{
        role: "user",
        content: `Contact name: ${
          String(input.contact.name ?? "unknown")
        }\nOutreach goal: ${input.goal}`,
      }],
      maxOutputTokens: 180,
    });
    const cost = estimateChatCost(result.model, result.usage);
    await completeAgentRun(input.admin, runId, {
      status: "success",
      inputTokens: result.usage.inputTokens,
      cachedInputTokens: result.usage.cachedInputTokens,
      outputTokens: result.usage.outputTokens,
      estimatedCost: cost,
      model: result.model,
    });
    await recordUsage(input.admin, {
      projectId: input.project.id,
      userId: input.userId,
      runId,
      eventType: "outreach_draft_tokens",
      quantity: result.usage.inputTokens + result.usage.outputTokens,
      unit: "tokens",
      estimatedCost: cost,
      provider: "openai",
      metadata: { model: result.model, contact_id: input.contact.id },
    });
    return result.content.slice(0, 1600);
  } catch (error) {
    await completeAgentRun(input.admin, runId, {
      status: "failed",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

Deno.serve(apiHandler(async (req) => {
  requireMethod(req, ["GET", "POST"]);
  const { user, supabase } = await requireUser(req);
  const admin = createAdminClient();
  const url = new URL(req.url);

  if (req.method === "GET") {
    const projectId = url.searchParams.get("project_id");
    if (!projectId) throw new ApiError(400, "VALIDATION_ERROR", "project_id is required.");
    await requireProject(supabase, projectId);
    const resource = url.searchParams.get("resource") ?? "contacts";
    const parsedLimit = Number(url.searchParams.get("limit") ?? 100);
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(Math.trunc(parsedLimit), 1), 500)
      : 100;
    if (resource === "contacts") {
      const { data, error } = await supabase.from("contacts").select("*")
        .eq("project_id", projectId).order("created_at", { ascending: false }).limit(limit);
      if (error) throw new ApiError(500, "DATABASE_ERROR", "Could not list contacts.");
      return jsonResponse({ contacts: data ?? [] });
    }
    if (resource === "messages") {
      const { data, error } = await supabase.from("outbound_messages").select("*")
        .eq("project_id", projectId).order("created_at", { ascending: false }).limit(limit);
      if (error) throw new ApiError(500, "DATABASE_ERROR", "Could not list outreach messages.");
      return jsonResponse({ messages: data ?? [] });
    }
    if (resource === "form_sources") {
      const { data, error } = await supabase.from("project_form_sources").select("*")
        .eq("project_id", projectId).order("created_at", { ascending: false }).limit(limit);
      if (error) throw new ApiError(500, "DATABASE_ERROR", "Could not list form connections.");
      return jsonResponse({
        form_sources: (data ?? []).map((row) => presentFormSource(row as JsonRecord)),
      });
    }
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "resource must be contacts, messages, or form_sources.",
    );
  }

  const input = await readJson(req);
  const action = enumField(
    input,
    "action",
    ["intake", "send", "simulate_reply", "create_form_source", "revoke_form_source"] as const,
    true,
  )!;
  const projectId = uuidField(input, "project_id")!;
  const project = await requireProject(supabase, projectId);
  await requireProjectRole(supabase, projectId, ["owner", "admin"]);

  if (action === "create_form_source") {
    const label = stringField(input, "label", { max: 120 }) ?? "Google Form";
    // The plaintext token exists only in this response; we persist its hash.
    const token = generateFormToken();
    const { data, error } = await admin.from("project_form_sources").insert({
      project_id: projectId,
      created_by: user.id,
      label,
      token_hash: await hashFormToken(token),
      token_preview: tokenPreview(token),
    }).select("*").single();
    if (error) {
      throw new ApiError(500, "DATABASE_ERROR", "Could not create the form connection.");
    }
    return jsonResponse({ form_source: presentFormSource(data as JsonRecord, token) }, 201);
  }

  if (action === "revoke_form_source") {
    const formSourceId = uuidField(input, "form_source_id")!;
    const { data, error } = await admin.from("project_form_sources")
      .update({ status: "revoked", updated_at: new Date().toISOString() })
      .eq("id", formSourceId).eq("project_id", projectId)
      .select("*").maybeSingle();
    if (error) throw new ApiError(500, "DATABASE_ERROR", "Could not revoke the form connection.");
    if (!data) {
      throw new ApiError(
        404,
        "FORM_SOURCE_NOT_FOUND",
        "Form connection not found in this project.",
      );
    }
    return jsonResponse({ form_source: presentFormSource(data as JsonRecord) });
  }

  if (action === "intake") {
    const phone = normalizeE164Phone(
      stringField(input, "phone", { required: true, min: 8, max: 30 })!,
    );
    const name = stringField(input, "name", { max: 160 });
    const email = stringField(input, "email", { max: 320 })?.toLowerCase();
    const consentStatus = enumField(input, "consent_status", OUTREACH_CONSENT_STATUSES, true)!;
    const consentEvidence = stringField(input, "consent_evidence", { max: 500 });
    const triggerSource = enumField(input, "trigger_source", TRIGGER_SOURCES) ?? "manual";
    if (consentStatus === "opted_in" && !consentEvidence) {
      throw new ApiError(
        400,
        "CONSENT_EVIDENCE_REQUIRED",
        "consent_evidence is required when a contact opts in.",
      );
    }
    const metadata = {
      trigger_source: triggerSource,
      consent_evidence: consentEvidence ?? null,
      submitted_at: new Date().toISOString(),
      simulated: triggerSource !== "manual",
    };
    const { data: existing, error: findError } = await admin.from("contacts").select("id")
      .eq("project_id", projectId).eq("phone", phone).maybeSingle();
    if (findError) throw new ApiError(500, "DATABASE_ERROR", "Could not check the contact.");
    const query = existing
      ? admin.from("contacts").update({ name, email, consent_status: consentStatus, metadata })
        .eq("id", existing.id)
      : admin.from("contacts").insert({
        project_id: projectId,
        name,
        phone,
        email,
        consent_status: consentStatus,
        metadata,
      });
    const { data, error } = await query.select("*").single();
    if (error) throw new ApiError(500, "DATABASE_ERROR", "Could not save the contact.");
    return jsonResponse(
      { contact: data, created: !existing, simulated: metadata.simulated },
      existing ? 200 : 201,
    );
  }

  if (project.status !== "active") {
    throw new ApiError(409, "PROJECT_INACTIVE", "This project is not active.");
  }

  if (action === "simulate_reply") {
    const conversationId = uuidField(input, "conversation_id")!;
    const content = stringField(input, "message", { required: true, min: 1, max: 8000 })!;
    const { data: conversation, error } = await admin.from("conversations").select("id")
      .eq("id", conversationId).eq("project_id", projectId).maybeSingle();
    if (error) throw new ApiError(500, "DATABASE_ERROR", "Could not load the conversation.");
    if (!conversation) {
      throw new ApiError(404, "CONVERSATION_NOT_FOUND", "Conversation not found.");
    }
    const { data: message, error: messageError } = await admin.from("messages").insert({
      conversation_id: conversationId,
      project_id: projectId,
      role: "user",
      content,
      metadata: { channel: "sms", simulated: true },
    }).select("*").single();
    if (messageError) throw new ApiError(500, "DATABASE_ERROR", "Could not store the reply.");
    await admin.from("conversations").update({ updated_at: new Date().toISOString() })
      .eq("id", conversationId);
    return jsonResponse({ message, simulated: true }, 201);
  }

  const contactId = uuidField(input, "contact_id")!;
  const contact = await contactForProject(admin, projectId, contactId);
  const to = assertOutreachConsent(contact);

  // The owner's plan pays for the send, not the caller's — a member on a shared
  // project has no subscription of their own. Checked before the draft so a
  // blocked send does not spend model tokens first.
  const ownerId = String(project.owner_id);
  const allowance = assertReplyAllowance(await loadEntitlement(admin, ownerId));

  const suppliedBody = stringField(input, "body", { min: 1, max: 1600 });
  const goal = stringField(input, "goal", { min: 1, max: 2000 });
  if (!suppliedBody && !goal) {
    throw new ApiError(400, "VALIDATION_ERROR", "Provide body or goal for an LLM-generated draft.");
  }
  const body = suppliedBody ?? await createDraft({
    admin,
    project,
    userId: user.id,
    contact,
    goal: goal!,
  });
  const { data: conversation, error: conversationError } = await admin.from("conversations").insert(
    {
      project_id: projectId,
      user_id: user.id,
      title: `Outreach to ${String(contact.name ?? to)}`.slice(0, 200),
    },
  ).select("id").single();
  if (conversationError) {
    throw new ApiError(500, "DATABASE_ERROR", "Could not create the outreach conversation.");
  }

  const { error: messageError } = await admin.from("messages").insert({
    conversation_id: conversation.id,
    project_id: projectId,
    role: "assistant",
    content: body,
    metadata: { channel: "sms", contact_id: contactId, outreach: true },
  });
  if (messageError) {
    throw new ApiError(500, "DATABASE_ERROR", "Could not store the outreach message.");
  }

  const { data: outbound, error: outboundError } = await admin.from("outbound_messages").insert({
    project_id: projectId,
    contact_id: contactId,
    conversation_id: conversation.id,
    initiated_by: user.id,
    requested_channel: "sms",
    to_address: to,
    body,
    status: "queued",
    rich_payload: { simulated: (Deno.env.get("MESSAGING_MODE") ?? "mock") === "mock" },
  }).select("*").single();
  if (outboundError) {
    throw new ApiError(500, "DATABASE_ERROR", "Could not queue the outreach message.");
  }

  const runId = await startAgentRun(admin, {
    projectId,
    conversationId: conversation.id,
    userId: user.id,
    runType: "outreach_send",
  });
  try {
    const result = await messagingProvider().sendMessage({
      projectId,
      contactId,
      to,
      body,
      requestedChannel: "sms",
    });
    const { data: sent, error: updateError } = await admin.from("outbound_messages").update({
      provider: result.provider,
      provider_message_id: result.providerMessageId,
      actual_channel: result.actualChannel,
      status: result.status,
      sent_at: new Date().toISOString(),
    }).eq("id", outbound.id).select("*").single();
    if (updateError) {
      throw new ApiError(500, "DATABASE_ERROR", "Could not record the send result.");
    }
    await completeAgentRun(admin, runId, { status: "success" });
    await recordUsage(admin, {
      projectId,
      userId: user.id,
      runId,
      eventType: allowance.overagePerReply > 0 ? "outreach_message_overage" : "outreach_message",
      quantity: 1,
      unit: "message",
      // `estimated_cost` is our provider spend, which the overage rate is not —
      // that is what we charge. Recording the billable amount in metadata keeps
      // the two from being summed together into a meaningless number.
      estimatedCost: 0,
      provider: result.provider,
      metadata: {
        contact_id: contactId,
        outbound_message_id: outbound.id,
        ...(allowance.overagePerReply > 0
          ? { billable_overage_usd: allowance.overagePerReply }
          : {}),
      },
    });
    return jsonResponse({
      message: sent,
      conversation_id: conversation.id,
      simulated: result.provider === "mock",
      billing: {
        replies_included: allowance.limit,
        replies_remaining: Math.max(0, allowance.remaining - 1),
        overage_charged_usd: allowance.overagePerReply,
      },
    }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await admin.from("outbound_messages").update({ status: "failed" }).eq("id", outbound.id);
    await completeAgentRun(admin, runId, { status: "failed", errorMessage: message });
    throw error;
  }
}));
