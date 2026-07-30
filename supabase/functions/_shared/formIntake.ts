import { ApiError } from "./errors.ts";
import { normalizeE164Phone } from "./outreach.ts";
import type { JsonRecord } from "./types.ts";

/** Prefix makes a leaked token searchable and obviously ours. */
const TOKEN_PREFIX = "rmf_";

export interface FieldMap {
  phone: string[];
  name: string[];
  email: string[];
  consent: string[];
}

export const DEFAULT_FIELD_MAP: FieldMap = {
  phone: ["phone", "phone number", "mobile", "mobile number", "cell"],
  name: ["name", "full name", "your name", "first name"],
  email: ["email", "email address", "your email"],
  consent: [
    "i agree to receive text messages about my enquiry",
    "i agree to receive text messages",
    "sms consent",
    "text consent",
  ],
};

/** Answers Google treats as ticked for a single-option checkbox. */
const AFFIRMATIVE = new Set(["yes", "true", "on", "1", "i agree", "agree", "checked", "y"]);

export function generateFormToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const body = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${TOKEN_PREFIX}${body}`;
}

export async function hashFormToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function tokenPreview(token: string): string {
  return `…${token.slice(-6)}`;
}

/**
 * Question titles are author-written, so match forgivingly: case, punctuation
 * and surrounding whitespace should never decide whether a form works.
 */
function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function parseFieldMap(value: unknown): FieldMap {
  const raw = (value ?? {}) as Record<string, unknown>;
  const list = (key: keyof FieldMap): string[] => {
    const candidate = raw[key];
    if (!Array.isArray(candidate)) return DEFAULT_FIELD_MAP[key];
    const entries = candidate.filter((item): item is string => typeof item === "string");
    return entries.length ? entries : DEFAULT_FIELD_MAP[key];
  };
  return {
    phone: list("phone"),
    name: list("name"),
    email: list("email"),
    consent: list("consent"),
  };
}

/** Google sends checkbox answers as arrays; flatten to a comparable string. */
function answerToString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value.map(answerToString).filter(Boolean).join(", ");
  }
  return "";
}

export function readAnswers(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "VALIDATION_ERROR", "answers must be an object of question titles.");
  }
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof key !== "string" || !key.trim()) continue;
    out[key] = answerToString(raw);
  }
  return out;
}

function findAnswer(
  answers: Record<string, string>,
  candidates: string[],
): { title: string; value: string } | null {
  const normalized = new Map<string, { title: string; value: string }>();
  for (const [title, value] of Object.entries(answers)) {
    normalized.set(normalizeKey(title), { title, value });
  }

  // Exact title match first, then a contains match so "Mobile number (US)" works.
  for (const candidate of candidates) {
    const hit = normalized.get(normalizeKey(candidate));
    if (hit) return hit;
  }
  for (const candidate of candidates) {
    const needle = normalizeKey(candidate);
    if (!needle) continue;
    for (const [key, hit] of normalized) {
      if (key.includes(needle)) return hit;
    }
  }
  return null;
}

/**
 * Coerce what a form respondent actually types into E.164.
 *
 * People fill in "(555) 555-0100" or "555-555-0100"; almost nobody types a
 * country code. A2P 10DLC is a US programme, so a bare 10-digit number is
 * assumed to be +1. Anything already carrying a "+" is left for
 * normalizeE164Phone to validate as-is.
 */
export function toE164(raw: string, defaultCountryCode = "1"): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("+")) return normalizeE164Phone(trimmed);

  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return normalizeE164Phone(`+${defaultCountryCode}${digits}`);
  if (digits.length === 11 && digits.startsWith(defaultCountryCode)) {
    return normalizeE164Phone(`+${digits}`);
  }
  // Long enough to carry its own country code, e.g. "441632960961".
  if (digits.length > 11) return normalizeE164Phone(`+${digits}`);

  throw new ApiError(
    400,
    "INVALID_PHONE",
    `"${raw}" is not a usable phone number. Ask for a 10-digit US number or a +country-code number.`,
  );
}

export interface ExtractedContact {
  phone: string;
  name: string | null;
  email: string | null;
  consentGranted: boolean;
  consentQuestion: string | null;
  consentAnswer: string | null;
}

/**
 * Pull a contact out of one form response.
 *
 * Consent is deliberately strict: it counts only when a question mapped to
 * consent exists AND its answer is affirmative. A missing consent question is
 * not treated as consent, so those contacts land as `unknown` and outreach
 * refuses to message them.
 */
export function extractContact(
  answers: Record<string, string>,
  fieldMap: FieldMap,
): ExtractedContact {
  const phoneHit = findAnswer(answers, fieldMap.phone);
  if (!phoneHit || !phoneHit.value) {
    throw new ApiError(
      422,
      "PHONE_QUESTION_MISSING",
      `No answer matched a phone question. Add a question titled one of: ${
        fieldMap.phone.join(", ")
      }.`,
    );
  }

  const nameHit = findAnswer(answers, fieldMap.name);
  const emailHit = findAnswer(answers, fieldMap.email);
  const consentHit = findAnswer(answers, fieldMap.consent);

  const consentAnswer = consentHit?.value ?? null;
  const consentGranted = Boolean(
    consentAnswer && AFFIRMATIVE.has(normalizeKey(consentAnswer).replace(/\s+/g, " ")),
  );

  const email = emailHit?.value?.toLowerCase() || null;

  return {
    phone: toE164(phoneHit.value),
    name: nameHit?.value || null,
    email: email && email.includes("@") ? email : null,
    consentGranted,
    consentQuestion: consentHit?.title ?? null,
    consentAnswer,
  };
}

/** Consent evidence stored on the contact, quoted back to carriers on request. */
export function buildConsentEvidence(input: {
  contact: ExtractedContact;
  formLabel: string | null;
  responseId: string;
  submittedAt: string;
}): string {
  if (!input.contact.consentGranted) {
    return `No consent question ticked on ${
      input.formLabel ?? "Google Form"
    } response ${input.responseId}.`;
  }
  return [
    `Google Form opt-in`,
    input.formLabel ? `(${input.formLabel})` : null,
    `— answered "${input.contact.consentAnswer}"`,
    input.contact.consentQuestion ? `to "${input.contact.consentQuestion}"` : null,
    `on ${input.submittedAt}, response ${input.responseId}.`,
  ].filter(Boolean).join(" ").slice(0, 500);
}

export function buildContactMetadata(input: {
  contact: ExtractedContact;
  formSourceId: string;
  formLabel: string | null;
  responseId: string;
  submittedAt: string;
  rawAnswers: JsonRecord;
}): JsonRecord {
  return {
    trigger_source: "google_form",
    simulated: false,
    form_source_id: input.formSourceId,
    form_label: input.formLabel,
    external_response_id: input.responseId,
    submitted_at: input.submittedAt,
    consent_question: input.contact.consentQuestion,
    consent_answer: input.contact.consentAnswer,
    consent_evidence: buildConsentEvidence({
      contact: input.contact,
      formLabel: input.formLabel,
      responseId: input.responseId,
      submittedAt: input.submittedAt,
    }),
    raw_answers: input.rawAnswers,
  };
}
