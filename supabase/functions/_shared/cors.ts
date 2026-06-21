import { ApiError } from "./errors.ts";

export function getAllowedOrigins(raw = Deno.env.get("ALLOWED_ORIGINS") ?? ""): Set<string> {
  return new Set(raw.split(",").map((origin) => origin.trim()).filter(Boolean));
}

export function corsHeaders(req: Request, rawOrigins?: string): Headers {
  const origin = req.headers.get("origin");
  const headers = new Headers({
    "access-control-allow-headers": "authorization, apikey, content-type, x-client-info",
    "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "access-control-max-age": "86400",
    "vary": "Origin",
  });

  if (!origin) return headers;
  if (!getAllowedOrigins(rawOrigins).has(origin)) {
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
