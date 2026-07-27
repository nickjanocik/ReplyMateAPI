import { ApiError } from "./errors.ts";

export const OUTREACH_CONSENT_STATUSES = ["unknown", "opted_in", "opted_out"] as const;
export type OutreachConsentStatus = typeof OUTREACH_CONSENT_STATUSES[number];

export function normalizeE164Phone(value: string): string {
  const compact = value.trim().replace(/[\s().-]/g, "");
  if (!/^\+[1-9]\d{7,14}$/.test(compact)) {
    throw new ApiError(
      400,
      "INVALID_PHONE",
      "phone must use E.164 format, for example +15555550100.",
    );
  }
  return compact;
}

export function assertOutreachConsent(contact: {
  phone?: unknown;
  consent_status?: unknown;
}): string {
  if (contact.consent_status !== "opted_in") {
    throw new ApiError(
      409,
      "CONSENT_REQUIRED",
      "This contact has not explicitly opted in to outreach.",
    );
  }
  if (typeof contact.phone !== "string") {
    throw new ApiError(409, "PHONE_REQUIRED", "This contact does not have a phone number.");
  }
  return normalizeE164Phone(contact.phone);
}
