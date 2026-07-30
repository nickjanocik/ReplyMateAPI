import { createAdminClient } from "../_shared/auth.ts";
import { ApiError, apiHandler, jsonResponse, requireMethod } from "../_shared/errors.ts";
import {
  buildContactMetadata,
  extractContact,
  hashFormToken,
  parseFieldMap,
  readAnswers,
} from "../_shared/formIntake.ts";
import { readJson, stringField } from "../_shared/validation.ts";
import type { JsonRecord } from "../_shared/types.ts";

/**
 * Public Google Form intake webhook.
 *
 * Called by a customer's Apps Script "on form submit" trigger, so there is no
 * Supabase user session — the per-project token in `X-ReplyMate-Token` is the
 * only credential. Everything here runs as the service role, which is why the
 * token lookup and project scoping have to be airtight.
 */

function requireToken(req: Request): string {
  const header = req.headers.get("x-replymate-token") ??
    req.headers.get("x-replymate-form-token") ?? "";
  const token = header.trim();
  if (!token) {
    throw new ApiError(
      401,
      "FORM_TOKEN_REQUIRED",
      "Send the project's intake token in the X-ReplyMate-Token header.",
    );
  }
  return token;
}

Deno.serve(apiHandler(async (req) => {
  requireMethod(req, ["POST"]);

  const token = requireToken(req);
  const admin = createAdminClient();

  // Look the source up by hash — the plaintext token is never stored.
  const tokenHash = await hashFormToken(token);
  const { data: source, error: sourceError } = await admin
    .from("project_form_sources")
    .select("id, project_id, label, field_map, status, response_count")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (sourceError) {
    throw new ApiError(500, "DATABASE_ERROR", "Could not verify the intake token.");
  }
  // Same response for unknown and revoked so the endpoint cannot be used to
  // probe which tokens once existed.
  if (!source || source.status !== "active") {
    throw new ApiError(401, "FORM_TOKEN_INVALID", "This intake token is not valid.");
  }

  const body = await readJson(req);
  const responseId = stringField(body, "response_id", { required: true, min: 1, max: 200 })!;
  const submittedAt = stringField(body, "submitted_at", { max: 60 }) ?? new Date().toISOString();
  const answers = readAnswers(body.answers);

  if (!Object.keys(answers).length) {
    throw new ApiError(422, "EMPTY_SUBMISSION", "The form response contained no answers.");
  }

  // Apps Script retries failed executions, so a repeat delivery of the same
  // response must not create a second contact.
  const { data: existingEvent, error: existingEventError } = await admin
    .from("form_intake_events")
    .select("id, contact_id")
    .eq("form_source_id", source.id)
    .eq("external_response_id", responseId)
    .maybeSingle();
  if (existingEventError) {
    throw new ApiError(500, "DATABASE_ERROR", "Could not check for a duplicate submission.");
  }
  if (existingEvent) {
    return jsonResponse({
      status: "duplicate",
      contact_id: existingEvent.contact_id,
      message: "This form response was already processed.",
    }, 200);
  }

  const fieldMap = parseFieldMap(source.field_map);
  const contact = extractContact(answers, fieldMap);
  const consentStatus = contact.consentGranted ? "opted_in" : "unknown";

  const metadata = buildContactMetadata({
    contact,
    formSourceId: source.id as string,
    formLabel: (source.label as string | null) ?? null,
    responseId,
    submittedAt,
    rawAnswers: answers as unknown as JsonRecord,
  });

  // Upsert on (project, phone): a repeat enquiry from the same number should
  // refresh the contact rather than duplicate it. Consent is only ever
  // upgraded here — an existing opt-in is not silently downgraded by a later
  // submission that omitted the consent box.
  const { data: existingContact, error: findError } = await admin
    .from("contacts")
    .select("id, consent_status")
    .eq("project_id", source.project_id)
    .eq("phone", contact.phone)
    .maybeSingle();
  if (findError) throw new ApiError(500, "DATABASE_ERROR", "Could not check the contact.");

  const resolvedConsent = existingContact?.consent_status === "opted_out"
    ? "opted_out"
    : existingContact?.consent_status === "opted_in"
    ? "opted_in"
    : consentStatus;

  const writeContact = existingContact
    ? admin.from("contacts")
      .update({
        ...(contact.name ? { name: contact.name } : {}),
        ...(contact.email ? { email: contact.email } : {}),
        consent_status: resolvedConsent,
        metadata,
      })
      .eq("id", existingContact.id)
    : admin.from("contacts")
      .insert({
        project_id: source.project_id,
        name: contact.name,
        phone: contact.phone,
        email: contact.email,
        consent_status: consentStatus,
        metadata,
      });

  const { data: savedContact, error: contactError } = await writeContact.select("*").single();
  if (contactError) throw new ApiError(500, "DATABASE_ERROR", "Could not save the contact.");

  const { error: eventError } = await admin.from("form_intake_events").insert({
    form_source_id: source.id,
    project_id: source.project_id,
    contact_id: savedContact.id,
    external_response_id: responseId,
    payload: answers,
    consent_status: consentStatus,
  });
  // A duplicate here means two deliveries raced; the contact is already correct.
  if (eventError && !`${eventError.message}`.includes("duplicate")) {
    throw new ApiError(500, "DATABASE_ERROR", "Could not record the form submission.");
  }

  await admin.from("project_form_sources").update({
    response_count: ((source as JsonRecord).response_count as number ?? 0) + 1,
    last_response_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", source.id);

  return jsonResponse({
    status: existingContact ? "updated" : "created",
    contact_id: savedContact.id,
    consent_status: resolvedConsent,
    // Surfaced so the form owner can spot a missing consent question from the
    // Apps Script execution log without opening the dashboard.
    warning: contact.consentGranted
      ? null
      : "Saved without consent. Add the consent checkbox question to this form before texting this contact.",
  }, existingContact ? 200 : 201);
}));
