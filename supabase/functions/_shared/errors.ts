import { corsHeaders } from "./cors.ts";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export function errorResponse(error: unknown, requestId: string): Response {
  if (error instanceof ApiError) {
    return jsonResponse({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
        request_id: requestId,
      },
    }, error.status);
  }

  console.error(`[${requestId}]`, error);
  return jsonResponse({
    error: {
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred.",
      request_id: requestId,
    },
  }, 500);
}

export function requireMethod(req: Request, methods: string[]): void {
  if (!methods.includes(req.method)) {
    throw new ApiError(405, "METHOD_NOT_ALLOWED", `Use one of: ${methods.join(", ")}.`);
  }
}

export function apiHandler(
  handler: (req: Request, requestId: string) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req) => {
    const requestId = crypto.randomUUID();

    // Resolve CORS *before* running the handler. Validating it afterwards
    // meant a request from a disallowed origin still executed — creating rows
    // and spending tokens — and only then had its response rejected, which the
    // browser surfaces as an opaque network error.
    let cors: Headers;
    try {
      cors = corsHeaders(req);
    } catch (error) {
      return errorResponse(error, requestId);
    }

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    let response: Response;
    try {
      response = await handler(req, requestId);
    } catch (error) {
      response = errorResponse(error, requestId);
    }

    const headers = new Headers(response.headers);
    for (const [key, value] of cors) headers.set(key, value);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}
