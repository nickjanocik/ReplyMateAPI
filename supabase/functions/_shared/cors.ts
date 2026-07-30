import { ApiError } from "./errors.ts";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function getAllowedOrigins(raw = Deno.env.get("ALLOWED_ORIGINS") ?? ""): Set<string> {
  return new Set(raw.split(",").map((origin) => origin.trim()).filter(Boolean));
}

/**
 * True when this function is running against a local Supabase stack.
 *
 * A deployed project's SUPABASE_URL is always a public hostname, so this can
 * never be true in production.
 */
export function isLocalDeployment(supabaseUrl = Deno.env.get("SUPABASE_URL") ?? ""): boolean {
  try {
    const { hostname } = new URL(supabaseUrl);
    // "kong" is the internal hostname the CLI gives the local gateway.
    return LOOPBACK_HOSTS.has(hostname) || hostname === "kong";
  } catch {
    return false;
  }
}

/**
 * Origins are matched exactly, with two additions:
 *
 *  - an entry ending in `:*` (e.g. `http://localhost:*`) matches any port on
 *    that scheme and host;
 *  - against a local stack, any loopback origin is accepted, so changing the
 *    dev server's port does not require editing `.env.local` and restarting
 *    `supabase functions serve`.
 */
export function isOriginAllowed(
  origin: string,
  allowed: Set<string>,
  local = isLocalDeployment(),
): boolean {
  if (allowed.has(origin)) return true;

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }

  const schemeHost = `${parsed.protocol}//${parsed.hostname}`;
  for (const entry of allowed) {
    if (entry.endsWith(":*") && entry.slice(0, -2) === schemeHost) return true;
  }

  return local && isDeveloperHost(parsed.hostname);
}

/**
 * Loopback plus the RFC1918 ranges. `next dev` prints a LAN URL next to the
 * localhost one, and phone testing uses it, so both have to work against a
 * local stack.
 */
function isDeveloperHost(hostname: string): boolean {
  if (LOOPBACK_HOSTS.has(hostname)) return true;
  const octets = hostname.split(".");
  if (octets.length !== 4 || !octets.every((o) => /^\d{1,3}$/.test(o))) return false;
  const [a, b] = octets.map(Number);
  if (a > 255 || b > 255) return false;
  return a === 10 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31);
}

export function corsHeaders(req: Request, rawOrigins?: string): Headers {
  const origin = req.headers.get("origin");
  const headers = new Headers({
    "access-control-allow-headers": "authorization, apikey, content-type, x-client-info",
    "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "access-control-max-age": "86400",
    "vary": "Origin",
  });

  // No Origin header means a server-to-server call, which CORS does not govern.
  if (!origin) return headers;
  if (!isOriginAllowed(origin, getAllowedOrigins(rawOrigins))) {
    throw new ApiError(403, "ORIGIN_NOT_ALLOWED", "This browser origin is not allowed.");
  }
  headers.set("access-control-allow-origin", origin);
  return headers;
}

export function withCors(req: Request, response: Response, rawOrigins?: string): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of corsHeaders(req, rawOrigins)) headers.set(key, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
