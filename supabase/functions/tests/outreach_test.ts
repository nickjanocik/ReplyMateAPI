import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import { ApiError } from "../_shared/errors.ts";
import { assertOutreachConsent, normalizeE164Phone } from "../_shared/outreach.ts";

Deno.test("outreach phone normalization accepts E.164-compatible formatting", () => {
  assertEquals(normalizeE164Phone("+1 (555) 555-0100"), "+15555550100");
  const error = assertThrows(() => normalizeE164Phone("555-0100"), ApiError);
  assertEquals(error.code, "INVALID_PHONE");
});

Deno.test("outreach sending requires explicit consent", () => {
  assertEquals(
    assertOutreachConsent({ phone: "+15555550100", consent_status: "opted_in" }),
    "+15555550100",
  );
  const error = assertThrows(
    () => assertOutreachConsent({ phone: "+15555550100", consent_status: "unknown" }),
    ApiError,
  );
  assertEquals(error.code, "CONSENT_REQUIRED");
});
