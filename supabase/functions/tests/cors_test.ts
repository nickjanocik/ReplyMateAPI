import { assertEquals } from "jsr:@std/assert@1.0.14";
import { getAllowedOrigins, isLocalDeployment, isOriginAllowed } from "../_shared/cors.ts";
import { apiHandler, jsonResponse } from "../_shared/errors.ts";

Deno.test("origin allowlist still requires an exact match in production", () => {
  const allowed = getAllowedOrigins("https://app.example.test");
  assertEquals(isOriginAllowed("https://app.example.test", allowed, false), true);
  assertEquals(isOriginAllowed("https://evil.example.test", allowed, false), false);
  // A loopback origin must NOT be waved through against a deployed project.
  assertEquals(isOriginAllowed("http://localhost:3000", allowed, false), false);
});

Deno.test("a :* entry matches any port on that scheme and host", () => {
  const allowed = getAllowedOrigins("http://localhost:*");
  assertEquals(isOriginAllowed("http://localhost:3000", allowed, false), true);
  assertEquals(isOriginAllowed("http://localhost:9999", allowed, false), true);
  assertEquals(isOriginAllowed("https://localhost:3000", allowed, false), false);
  assertEquals(isOriginAllowed("http://evil.test:3000", allowed, false), false);
});

Deno.test("any loopback port is allowed against a local stack", () => {
  const allowed = getAllowedOrigins("http://localhost:3000");
  assertEquals(isOriginAllowed("http://localhost:3737", allowed, true), true);
  assertEquals(isOriginAllowed("http://127.0.0.1:5555", allowed, true), true);
  assertEquals(isOriginAllowed("https://app.example.test", allowed, true), false);
});

Deno.test("local deployment is detected from SUPABASE_URL only", () => {
  assertEquals(isLocalDeployment("http://127.0.0.1:54321"), true);
  assertEquals(isLocalDeployment("http://kong:8000"), true);
  assertEquals(isLocalDeployment("https://abcdefg.supabase.co"), false);
  assertEquals(isLocalDeployment(""), false);
});

Deno.test("a blocked origin never reaches the handler", async () => {
  Deno.env.set("ALLOWED_ORIGINS", "https://app.example.test");
  Deno.env.set("SUPABASE_URL", "https://abcdefg.supabase.co");
  let ran = false;
  const handler = apiHandler(() => {
    ran = true;
    return Promise.resolve(jsonResponse({ ok: true }));
  });
  const response = await handler(
    new Request("https://api.example.test", {
      method: "POST",
      headers: { origin: "https://evil.example.test" },
    }),
  );
  assertEquals(response.status, 403);
  assertEquals((await response.json()).error.code, "ORIGIN_NOT_ALLOWED");
  // The regression that mattered: the handler used to run first.
  assertEquals(ran, false);
});

Deno.test("an allowed origin gets CORS headers on error responses too", async () => {
  Deno.env.set("ALLOWED_ORIGINS", "https://app.example.test");
  Deno.env.set("SUPABASE_URL", "https://abcdefg.supabase.co");
  const handler = apiHandler(() => Promise.reject(new Error("boom")));
  const response = await handler(
    new Request("https://api.example.test", {
      headers: { origin: "https://app.example.test" },
    }),
  );
  assertEquals(response.status, 500);
  assertEquals(
    response.headers.get("access-control-allow-origin"),
    "https://app.example.test",
  );
});

Deno.test("private LAN origins work against a local stack but never in production", () => {
  const allowed = getAllowedOrigins("http://localhost:3000");
  for (
    const origin of [
      "http://10.103.1.19:3000",
      "http://192.168.1.20:3000",
      "http://172.20.0.5:3000",
    ]
  ) {
    assertEquals(isOriginAllowed(origin, allowed, true), true, `local: ${origin}`);
    assertEquals(isOriginAllowed(origin, allowed, false), false, `prod: ${origin}`);
  }
  // Public IPs and lookalikes stay blocked even locally.
  for (const origin of ["http://8.8.8.8:3000", "http://172.32.0.1:3000", "http://11.0.0.1:3000"]) {
    assertEquals(isOriginAllowed(origin, allowed, true), false, `should block: ${origin}`);
  }
});
