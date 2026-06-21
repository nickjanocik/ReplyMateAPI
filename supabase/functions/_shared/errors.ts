import { withCors } from "./cors.ts";

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
    try {
      if (req.method === "OPTIONS") {
        return withCors(req, new Response(null, { status: 204 }));
      }
      return withCors(req, await handler(req, requestId));
    } catch (error) {
      const response = errorResponse(error, requestId);
      try {
        return withCors(req, response);
      } catch (corsError) {
        return errorResponse(corsError, requestId);
      }
    }
  };
}
