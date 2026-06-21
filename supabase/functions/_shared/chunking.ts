export interface TextChunk {
  index: number;
  content: string;
  charStart: number;
  charEnd: number;
  tokenCount: number;
}

export function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{4,}/g, "\n\n\n").trim();
}

export function approximateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function findBoundary(text: string, start: number, targetEnd: number): number {
  if (targetEnd >= text.length) return text.length;
  const minimum = start + Math.floor((targetEnd - start) * 0.6);
  for (const separator of ["\n\n", "\n", ". ", " "]) {
    const index = text.lastIndexOf(separator, targetEnd);
    if (index >= minimum) return index + separator.length;
  }
  return targetEnd;
}

export function chunkText(text: string, targetChars = 4000, overlapChars = 400): TextChunk[] {
  if (targetChars < 500) throw new Error("targetChars must be at least 500");
  if (overlapChars < 0 || overlapChars >= targetChars) throw new Error("invalid overlapChars");
  const normalized = normalizeText(text);
  if (!normalized) return [];

  const chunks: TextChunk[] = [];
  let start = 0;
  while (start < normalized.length) {
    const end = findBoundary(normalized, start, Math.min(start + targetChars, normalized.length));
    const content = normalized.slice(start, end).trim();
    if (content) {
      chunks.push({
        index: chunks.length,
        content,
        charStart: start,
        charEnd: end,
        tokenCount: approximateTokens(content),
      });
    }
    if (end >= normalized.length) break;
    const nextStart = Math.max(0, end - overlapChars);
    start = nextStart > start ? nextStart : end;
  }
  return chunks;
}

export async function hashText(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(normalizeText(text));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export function sanitizeFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "file.txt";
  const safe = base.normalize("NFKD").replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 180);
  return safe || "file.txt";
}
