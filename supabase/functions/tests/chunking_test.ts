import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1.0.14";
import { chunkText, hashText, normalizeText, sanitizeFilename } from "../_shared/chunking.ts";

Deno.test("normalizeText and hashText are deterministic", async () => {
  assertEquals(normalizeText(" Hello  \r\nworld\n\n\n\n"), "Hello\nworld");
  assertEquals(await hashText("hello\r\nworld"), await hashText("hello\nworld"));
  assertNotEquals(await hashText("hello"), await hashText("world"));
});

Deno.test("chunkText creates bounded, overlapping chunks", () => {
  const text = Array.from({ length: 300 }, (_, index) => `Paragraph ${index}: ${"x".repeat(30)}.`)
    .join("\n\n");
  const chunks = chunkText(text, 1000, 100);
  assert(chunks.length > 1);
  assert(chunks.every((chunk) => chunk.content.length <= 1050));
  for (let index = 1; index < chunks.length; index++) {
    assert(chunks[index].charStart < chunks[index - 1].charEnd);
    assertEquals(chunks[index].index, index);
  }
});

Deno.test("sanitizeFilename removes paths and unsafe characters", () => {
  assertEquals(sanitizeFilename("../../My notes (final).md"), "My-notes-final-.md");
});
