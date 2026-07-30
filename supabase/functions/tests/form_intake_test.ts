import { assertEquals, assertNotEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import { ApiError } from "../_shared/errors.ts";
import {
  buildConsentEvidence,
  DEFAULT_FIELD_MAP,
  extractContact,
  generateFormToken,
  hashFormToken,
  parseFieldMap,
  readAnswers,
  toE164,
  tokenPreview,
} from "../_shared/formIntake.ts";

Deno.test("form intake matches question titles loosely", () => {
  const contact = extractContact({
    "Your Name": "Ada Lovelace",
    "Mobile Number (US)": "(555) 555-0100",
    "Email Address": "ADA@example.com",
    "I agree to receive text messages about my enquiry": "Yes",
  }, DEFAULT_FIELD_MAP);

  assertEquals(contact.phone, "+15555550100");
  assertEquals(contact.name, "Ada Lovelace");
  assertEquals(contact.email, "ada@example.com");
  assertEquals(contact.consentGranted, true);
});

Deno.test("form intake treats a missing consent question as no consent", () => {
  const contact = extractContact({
    Name: "Grace",
    Phone: "+15555550111",
  }, DEFAULT_FIELD_MAP);

  assertEquals(contact.consentGranted, false);
  assertEquals(contact.consentQuestion, null);
});

Deno.test("form intake does not accept a declined consent checkbox", () => {
  const contact = extractContact({
    Phone: "+15555550112",
    "SMS consent": "No",
  }, DEFAULT_FIELD_MAP);

  assertEquals(contact.consentGranted, false);
  assertEquals(contact.consentAnswer, "No");
});

Deno.test("form intake reads checkbox answers delivered as arrays", () => {
  const answers = readAnswers({
    Phone: "+15555550113",
    "I agree to receive text messages": ["Yes"],
  });
  assertEquals(answers["I agree to receive text messages"], "Yes");
  assertEquals(extractContact(answers, DEFAULT_FIELD_MAP).consentGranted, true);
});

Deno.test("form intake rejects a response with no phone question", () => {
  const error = assertThrows(
    () => extractContact({ Name: "Nobody" }, DEFAULT_FIELD_MAP),
    ApiError,
  );
  assertEquals(error.code, "PHONE_QUESTION_MISSING");
});

Deno.test("form intake accepts the national formats respondents actually type", () => {
  const cases: Array<[string, string]> = [
    ["(555) 555-0100", "+15555550100"],
    ["555-555-0100", "+15555550100"],
    ["5555550100", "+15555550100"],
    ["1 555 555 0100", "+15555550100"],
    ["+1 (555) 555-0100", "+15555550100"],
    ["+44 1632 960961", "+441632960961"],
  ];
  for (const [input, expected] of cases) {
    assertEquals(toE164(input), expected, `failed for ${input}`);
  }
});

Deno.test("form intake rejects a number that is too short to dial", () => {
  const error = assertThrows(() => toE164("555-0100"), ApiError);
  assertEquals(error.code, "INVALID_PHONE");
});

Deno.test("form intake rejects an unusable phone number", () => {
  const error = assertThrows(
    () => extractContact({ Phone: "not a number" }, DEFAULT_FIELD_MAP),
    ApiError,
  );
  assertEquals(error.code, "INVALID_PHONE");
});

Deno.test("form intake rejects a non-object answers payload", () => {
  const error = assertThrows(() => readAnswers([1, 2, 3]), ApiError);
  assertEquals(error.code, "VALIDATION_ERROR");
});

Deno.test("field map falls back to defaults for missing or empty overrides", () => {
  const map = parseFieldMap({ phone: ["Cell"], name: [], email: "nope" });
  assertEquals(map.phone, ["Cell"]);
  assertEquals(map.name, DEFAULT_FIELD_MAP.name);
  assertEquals(map.email, DEFAULT_FIELD_MAP.email);
  assertEquals(map.consent, DEFAULT_FIELD_MAP.consent);
});

Deno.test("form tokens are unique, prefixed, and hashed stably", async () => {
  const a = generateFormToken();
  const b = generateFormToken();
  assertNotEquals(a, b);
  assertEquals(a.startsWith("rmf_"), true);
  assertEquals(tokenPreview(a), `…${a.slice(-6)}`);

  const hash = await hashFormToken(a);
  assertEquals(hash.length, 64);
  assertEquals(await hashFormToken(a), hash);
  assertNotEquals(await hashFormToken(b), hash);
});

Deno.test("consent evidence quotes the question and answer for carriers", () => {
  const contact = extractContact({
    Phone: "+15555550114",
    "I agree to receive text messages about my enquiry": "Yes",
  }, DEFAULT_FIELD_MAP);

  const evidence = buildConsentEvidence({
    contact,
    formLabel: "Maple Street enquiries",
    responseId: "resp-123",
    submittedAt: "2026-07-27T10:00:00.000Z",
  });

  assertEquals(evidence.includes("Maple Street enquiries"), true);
  assertEquals(evidence.includes("resp-123"), true);
  assertEquals(evidence.includes("Yes"), true);
  assertEquals(evidence.length <= 500, true);
});
