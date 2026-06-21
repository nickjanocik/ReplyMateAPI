#!/usr/bin/env -S deno run --allow-env --allow-read --allow-net

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.49.8";

type JsonObject = Record<string, unknown>;

class CliError extends Error {
  constructor(message: string, public readonly details?: unknown) {
    super(message);
    this.name = "CliError";
  }
}

interface Config {
  supabaseUrl: string;
  anonKey: string;
  accessToken?: string;
  email?: string;
  password?: string;
}

interface UploadDescriptor {
  path: string;
  token: string;
  signedUrl: string;
}

function env(name: string): string | undefined {
  return Deno.env.get(name)?.trim() || undefined;
}

function config(): Config {
  const supabaseUrl = env("SUPABASE_URL");
  const anonKey = env("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !anonKey) {
    throw new CliError("Set SUPABASE_URL and SUPABASE_ANON_KEY before using the CLI.");
  }
  return {
    supabaseUrl: supabaseUrl.replace(/\/+$/, ""),
    anonKey,
    accessToken: env("REPLYMATE_ACCESS_TOKEN") ?? env("ACCESS_TOKEN"),
    email: env("REPLYMATE_EMAIL"),
    password: env("REPLYMATE_PASSWORD"),
  };
}

function requiredArg(args: string[], index: number, description: string): string {
  const value = args[index]?.trim();
  if (!value) throw new CliError(`Missing ${description}. Run 'deno task api -- help' for usage.`);
  return value;
}

function json(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function asObject(value: unknown, label = "response"): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CliError(`Invalid ${label}.`);
  }
  return value as JsonObject;
}

function nestedString(value: unknown, path: string[]): string {
  let current: unknown = value;
  for (const key of path) current = asObject(current)[key];
  if (typeof current !== "string") throw new CliError(`Response is missing ${path.join(".")}.`);
  return current;
}

class ReplyMateClient {
  private constructor(
    private readonly settings: Config,
    readonly token: string,
    readonly supabase: SupabaseClient,
  ) {}

  static async connect(settings = config()): Promise<ReplyMateClient> {
    const base = createClient(settings.supabaseUrl, settings.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    let token = settings.accessToken;
    if (!token) {
      if (!settings.email || !settings.password) {
        throw new CliError(
          "Set REPLYMATE_ACCESS_TOKEN, or set REPLYMATE_EMAIL and REPLYMATE_PASSWORD for automatic login.",
        );
      }
      const { data, error } = await base.auth.signInWithPassword({
        email: settings.email,
        password: settings.password,
      });
      if (error || !data.session) throw new CliError("Supabase login failed.", error?.message);
      token = data.session.access_token;
    }

    const supabase = createClient(settings.supabaseUrl, settings.anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    return new ReplyMateClient(settings, token, supabase);
  }

  async request(
    functionName: string,
    options: { method?: string; query?: URLSearchParams; body?: JsonObject } = {},
  ): Promise<unknown> {
    const url = new URL(`${this.settings.supabaseUrl}/functions/v1/${functionName}`);
    if (options.query) url.search = options.query.toString();
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        apikey: this.settings.anonKey,
        Authorization: `Bearer ${this.token}`,
        ...(options.body ? { "content-type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const payload: unknown = await response.json().catch(() => ({ status: response.status }));
    if (!response.ok) {
      const error = asObject(asObject(payload).error ?? {});
      const message = typeof error.message === "string" ? error.message : `HTTP ${response.status}`;
      throw new CliError(`${functionName}: ${message}`, payload);
    }
    return payload;
  }

  async upload(projectId: string, file: File, title?: string): Promise<unknown> {
    const created = await this.request("v1-upload", {
      method: "POST",
      body: {
        action: "create_upload",
        project_id: projectId,
        filename: file.name,
        mime_type: file.type || "text/plain",
        size_bytes: file.size,
        ...(title ? { title } : {}),
      },
    });
    const sourceId = nestedString(created, ["source", "id"]);
    const upload = asObject(
      asObject(created).upload,
      "upload descriptor",
    ) as unknown as UploadDescriptor;
    if (!upload.path || !upload.token) {
      throw new CliError("Upload descriptor is incomplete.", created);
    }

    const { error } = await this.supabase.storage.from("project-files").uploadToSignedUrl(
      upload.path,
      upload.token,
      file,
      { contentType: file.type || "text/plain", upsert: false },
    );
    if (error) throw new CliError("Signed Storage upload failed.", error.message);
    return await this.request("v1-upload", {
      method: "POST",
      body: { action: "process", source_id: sourceId },
    });
  }
}

async function signup(args: string[]): Promise<void> {
  const settings = config();
  const email = args[0] ?? settings.email;
  const password = args[1] ?? settings.password;
  const fullName = args[2];
  if (!email || !password) {
    throw new CliError("Provide email/password arguments or REPLYMATE_EMAIL/REPLYMATE_PASSWORD.");
  }
  const supabase = createClient(settings.supabaseUrl, settings.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: fullName ? { full_name: fullName } : {} },
  });
  if (error) throw new CliError("Signup failed.", error.message);
  json({
    user_id: data.user?.id,
    session_created: Boolean(data.session),
    message: data.session
      ? "Account created and ready to use."
      : "Account created. Confirm the email before logging in.",
  });
}

async function whoami(client: ReplyMateClient): Promise<void> {
  const { data, error } = await client.supabase.auth.getUser(client.token);
  if (error || !data.user) throw new CliError("Could not verify the current user.", error?.message);
  json({ id: data.user.id, email: data.user.email, created_at: data.user.created_at });
}

async function projects(client: ReplyMateClient, args: string[]): Promise<void> {
  const action = requiredArg(args, 0, "projects action");
  if (action === "list") return json(await client.request("v1-projects"));
  if (action === "get") {
    const projectId = requiredArg(args, 1, "project ID");
    return json(
      await client.request("v1-projects", {
        query: new URLSearchParams({ project_id: projectId }),
      }),
    );
  }
  if (action === "create") {
    const name = requiredArg(args, 1, "project name");
    return json(await client.request("v1-projects", { method: "POST", body: { name } }));
  }
  if (action === "delete") {
    const projectId = requiredArg(args, 1, "project ID");
    return json(
      await client.request("v1-projects", {
        method: "DELETE",
        query: new URLSearchParams({ project_id: projectId }),
      }),
    );
  }
  throw new CliError(`Unknown projects action: ${action}`);
}

async function members(client: ReplyMateClient, args: string[]): Promise<void> {
  const action = requiredArg(args, 0, "members action");
  const projectId = requiredArg(args, 1, "project ID");
  if (action === "list") {
    return json(
      await client.request("v1-projects", {
        query: new URLSearchParams({ resource: "members", project_id: projectId }),
      }),
    );
  }
  if (action === "add") {
    const email = requiredArg(args, 2, "registered member email");
    const role = args[3] ?? "member";
    return json(
      await client.request("v1-projects", {
        method: "POST",
        body: { action: "add_member", project_id: projectId, email, role },
      }),
    );
  }
  if (action === "role") {
    const userId = requiredArg(args, 2, "member user ID");
    const role = requiredArg(args, 3, "new role");
    return json(
      await client.request("v1-projects", {
        method: "PATCH",
        body: { action: "update_member", project_id: projectId, user_id: userId, role },
      }),
    );
  }
  if (action === "remove") {
    const userId = requiredArg(args, 2, "member user ID");
    return json(
      await client.request("v1-projects", {
        method: "DELETE",
        query: new URLSearchParams({ resource: "members", project_id: projectId, user_id: userId }),
      }),
    );
  }
  throw new CliError(`Unknown members action: ${action}`);
}

async function context(client: ReplyMateClient, args: string[]): Promise<void> {
  const action = requiredArg(args, 0, "context action");
  if (action === "add") {
    const projectId = requiredArg(args, 1, "project ID");
    const title = requiredArg(args, 2, "context title");
    const text = requiredArg(args, 3, "context text");
    return json(
      await client.request("v1-context", {
        method: "POST",
        body: { project_id: projectId, title, text },
      }),
    );
  }
  if (action === "list") {
    const projectId = requiredArg(args, 1, "project ID");
    return json(
      await client.request("v1-context", {
        query: new URLSearchParams({ project_id: projectId }),
      }),
    );
  }
  if (action === "delete") {
    const sourceId = requiredArg(args, 1, "source ID");
    return json(
      await client.request("v1-context", {
        method: "DELETE",
        query: new URLSearchParams({ source_id: sourceId }),
      }),
    );
  }
  throw new CliError(`Unknown context action: ${action}`);
}

async function upload(client: ReplyMateClient, args: string[]): Promise<void> {
  const projectId = requiredArg(args, 0, "project ID");
  const path = requiredArg(args, 1, "file path");
  const bytes = await Deno.readFile(path).catch((error) => {
    throw new CliError(`Could not read ${path}.`, String(error));
  });
  const name = path.split(/[\\/]/).pop() ?? "context.txt";
  const mime = /\.(md|markdown)$/i.test(name) ? "text/markdown" : "text/plain";
  json(await client.upload(projectId, new File([bytes], name, { type: mime }), args[2]));
}

async function chat(client: ReplyMateClient, args: string[]): Promise<void> {
  const projectId = requiredArg(args, 0, "project ID");
  const message = requiredArg(args, 1, "message");
  const conversationId = args[2];
  json(
    await client.request("v1-chat", {
      method: "POST",
      body: {
        project_id: projectId,
        message,
        ...(conversationId ? { conversation_id: conversationId } : {}),
      },
    }),
  );
}

async function smoke(client: ReplyMateClient, keep: boolean): Promise<void> {
  let projectId: string | undefined;
  try {
    console.log("1/7 Creating project...");
    const project = await client.request("v1-projects", {
      method: "POST",
      body: { name: `CLI Smoke ${new Date().toISOString()}` },
    });
    projectId = nestedString(project, ["project", "id"]);

    console.log("2/7 Adding text context and embeddings...");
    await client.request("v1-context", {
      method: "POST",
      body: {
        project_id: projectId,
        title: "CLI smoke facts",
        text: "The ReplyMate CLI smoke-test launch color is cobalt blue.",
      },
    });

    console.log("3/7 Uploading and processing Markdown...");
    await client.upload(
      projectId,
      new File(["# Smoke document\n\nThe project mascot is an otter named Ada."], "smoke.md", {
        type: "text/markdown",
      }),
    );

    console.log("4/7 Listing ready knowledge sources...");
    const sources = await client.request("v1-context", {
      query: new URLSearchParams({ project_id: projectId }),
    });
    const sourceRows = asObject(sources).sources;
    if (!Array.isArray(sourceRows) || sourceRows.length !== 2) {
      throw new CliError("Expected two knowledge sources after ingestion.", sources);
    }

    console.log("5/7 Running grounded chat...");
    const answer = await client.request("v1-chat", {
      method: "POST",
      body: { project_id: projectId, message: "What is the launch color and who is the mascot?" },
    });
    const sourceRefs = asObject(answer).sources;
    if (!Array.isArray(sourceRefs) || sourceRefs.length === 0) {
      throw new CliError("Chat returned no source references.", answer);
    }
    json(answer);

    console.log("6/7 Listing private conversations...");
    await client.request("v1-chat", {
      query: new URLSearchParams({ project_id: projectId }),
    });

    console.log("7/7 Smoke flow passed.");
  } finally {
    if (projectId && !keep) {
      console.log("Cleaning up smoke project...");
      await client.request("v1-projects", {
        method: "DELETE",
        query: new URLSearchParams({ project_id: projectId }),
      }).catch((error) => console.error("Cleanup failed:", error));
    } else if (projectId) {
      console.log(`Keeping project ${projectId}`);
    }
  }
}

function help(): void {
  console.log(`ReplyMate API CLI

Environment:
  SUPABASE_URL                 Local or hosted Supabase URL
  SUPABASE_ANON_KEY            Supabase anon key
  REPLYMATE_ACCESS_TOKEN       Existing user JWT, or use email/password below
  REPLYMATE_EMAIL              Supabase user email
  REPLYMATE_PASSWORD           Supabase user password

Commands:
  auth signup [email] [password] [full-name]
  auth whoami
  projects list | get <id> | create <name> | delete <id>
  members list <project-id>
  members add <project-id> <email> [member|admin]
  members role <project-id> <user-id> <member|admin>
  members remove <project-id> <user-id>
  context add <project-id> <title> <text>
  context list <project-id>
  context delete <source-id>
  upload <project-id> <file-path> [title]
  chat <project-id> <message> [conversation-id]
  smoke [--keep]

Examples:
  deno task api -- auth signup
  deno task api -- projects create "Launch Agent"
  deno task api -- context add PROJECT_ID "Facts" "The launch color is blue."
  deno task api -- upload PROJECT_ID ./notes.md
  deno task api -- chat PROJECT_ID "What is the launch color?"
  deno task api -- smoke
`);
}

async function main(args: string[]): Promise<void> {
  if (args[0] === "--") args = args.slice(1);
  const command = args[0] ?? "help";
  if (command === "help" || command === "--help" || command === "-h") return help();
  if (command === "auth" && args[1] === "signup") return await signup(args.slice(2));

  const client = await ReplyMateClient.connect();
  if (command === "auth" && args[1] === "whoami") return await whoami(client);
  if (command === "projects") return await projects(client, args.slice(1));
  if (command === "members") return await members(client, args.slice(1));
  if (command === "context") return await context(client, args.slice(1));
  if (command === "upload") return await upload(client, args.slice(1));
  if (command === "chat") return await chat(client, args.slice(1));
  if (command === "smoke") return await smoke(client, args.includes("--keep"));
  throw new CliError(`Unknown command: ${args.join(" ")}`);
}

if (import.meta.main) {
  try {
    await main(Deno.args);
  } catch (error) {
    if (error instanceof CliError) {
      console.error(`Error: ${error.message}`);
      if (error.details !== undefined) console.error(JSON.stringify(error.details, null, 2));
    } else {
      console.error(error);
    }
    Deno.exit(1);
  }
}
