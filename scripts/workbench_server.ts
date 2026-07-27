#!/usr/bin/env -S deno run --allow-read --allow-net

const HOST = "127.0.0.1";
const PORT = 4173;

const PUBLIC_FILES = new Map<string, string>([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/app.js", "app.js"],
  ["/styles.css", "styles.css"],
]);

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function contentType(path: string): string {
  const extension = path.match(/\.[^.]+$/)?.[0] ?? "";
  return MIME_TYPES[extension] ?? "application/octet-stream";
}

async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

function parseDotEnv(raw: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

async function workbenchConfig(): Promise<Response> {
  const envRaw = await readTextIfExists(".env.local") ??
    await readTextIfExists(".env.example") ??
    "";
  const env = parseDotEnv(envRaw);
  const projectRef = (await readTextIfExists("supabase/.temp/project-ref"))?.trim() ?? "";
  const supabaseUrl = env.SUPABASE_URL?.replace(/\/+$/, "") ?? "";

  return json({
    supabaseUrl,
    supabaseAnonKey: env.SUPABASE_ANON_KEY ?? "",
    functionsBase: supabaseUrl ? `${supabaseUrl}/functions/v1` : "",
    projectRef,
    hostedFunctionsBase: projectRef ? `https://${projectRef}.supabase.co/functions/v1` : "",
    workbenchOrigin: `http://${HOST}:${PORT}`,
  });
}

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value, null, 2), {
    ...init,
    headers: {
      "content-type": MIME_TYPES[".json"],
      "cache-control": "no-store",
      ...init.headers,
    },
  });
}

async function serveStatic(pathname: string): Promise<Response> {
  const file = PUBLIC_FILES.get(pathname);
  if (!file) return new Response("Not found", { status: 404 });

  const fileUrl = new URL(`../tools/api-workbench/${file}`, import.meta.url);
  const body = await Deno.readFile(fileUrl);
  return new Response(body, {
    headers: {
      "content-type": contentType(file),
      "cache-control": file.endsWith(".html") ? "no-store" : "max-age=60",
    },
  });
}

Deno.serve({ hostname: HOST, port: PORT }, async (req) => {
  const url = new URL(req.url);
  if (url.pathname === "/config.json") return await workbenchConfig();
  return await serveStatic(url.pathname);
});

console.log(`ReplyMate API Workbench running at http://${HOST}:${PORT}`);
