import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";

const CONFIG_KEY = "replymate.apiWorkbench.config.v1";
const RESPONSE_LIMIT = 120_000;

const state = {
  config: {
    supabaseUrl: "",
    supabaseAnonKey: "",
    projectRef: "",
    hostedFunctionsBase: "",
    workbenchOrigin: "",
  },
  supabase: undefined,
  session: undefined,
  lastResponse: {},
};

const $ = (id) => document.getElementById(id);

function text(node, value) {
  node.textContent = value ?? "";
}

function value(id) {
  return $(id).value.trim();
}

function setValue(id, newValue) {
  $(id).value = newValue ?? "";
}

function pretty(value) {
  return JSON.stringify(value, null, 2);
}

function loadStoredConfig() {
  try {
    return JSON.parse(localStorage.getItem(CONFIG_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function saveStoredConfig() {
  localStorage.setItem(
    CONFIG_KEY,
    JSON.stringify({
      supabaseUrl: state.config.supabaseUrl,
      supabaseAnonKey: state.config.supabaseAnonKey,
      projectId: value("selected-project-id"),
      conversationId: value("selected-conversation-id"),
      email: value("email"),
    }),
  );
}

async function loadServerConfig() {
  const response = await fetch("./config.json", { cache: "no-store" });
  if (!response.ok) return {};
  return await response.json();
}

function normalizeUrl(url) {
  return url.trim().replace(/\/+$/, "");
}

function projectRefFromUrl(url) {
  const match = normalizeUrl(url).match(/^https:\/\/([a-z0-9-]+)\.supabase\.co$/i);
  return match?.[1] ?? "";
}

function refreshWebhookUrls() {
  const projectRef = state.config.projectRef || projectRefFromUrl(state.config.supabaseUrl);
  const hostedBase = projectRef ? `https://${projectRef}.supabase.co/functions/v1` : "";
  text(
    $("stripe-webhook-url"),
    hostedBase
      ? `${hostedBase}/v1-billing-webhook`
      : "Stripe URL unavailable until project ref is known.",
  );
  text(
    $("twilio-webhook-url"),
    hostedBase
      ? `${hostedBase}/v1-twilio-webhook`
      : "Twilio URL unavailable until project ref is known.",
  );
}

function createSupabaseClient() {
  if (!state.config.supabaseUrl || !state.config.supabaseAnonKey) {
    state.supabase = undefined;
    return;
  }
  state.supabase = createClient(state.config.supabaseUrl, state.config.supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storageKey: "replymate-api-workbench-auth",
    },
  });
}

function setConnectionStatus() {
  const originHint = state.config.workbenchOrigin
    ? ` Add ${state.config.workbenchOrigin} to ALLOWED_ORIGINS when serving functions locally.`
    : "";
  text(
    $("connection-status"),
    state.config.supabaseUrl
      ? `Using ${state.config.supabaseUrl}.${originHint}`
      : "Paste a Supabase URL and anon key.",
  );
}

function setAuthStatus() {
  if (!state.supabase) {
    text($("auth-status"), "Not configured.");
    return;
  }
  if (!state.session) {
    text($("auth-status"), "Signed out.");
    return;
  }
  text(
    $("auth-status"),
    `Signed in as ${state.session.user?.email ?? state.session.user?.id ?? "user"}.`,
  );
}

async function refreshSession() {
  if (!state.supabase) {
    state.session = undefined;
    setAuthStatus();
    return;
  }
  const { data, error } = await state.supabase.auth.getSession();
  if (error) throw error;
  state.session = data.session ?? undefined;
  setAuthStatus();
}

function setResponse(payload) {
  state.lastResponse = payload;
  const serialized = pretty(payload);
  $("response-output").textContent = serialized.length > RESPONSE_LIMIT
    ? `${serialized.slice(0, RESPONSE_LIMIT)}\n\n... truncated in workbench ...`
    : serialized;
}

function logEntry({ title, ok, status, durationMs, detail }) {
  const container = $("request-log");
  const entry = document.createElement("div");
  entry.className = `log-entry ${ok ? "ok" : "error"}`;

  const heading = document.createElement("div");
  heading.className = "log-title";
  const name = document.createElement("span");
  name.textContent = title;
  const meta = document.createElement("span");
  meta.textContent = `${ok ? "OK" : "ERR"} ${status ?? ""} ${durationMs ?? 0}ms`;
  heading.append(name, meta);

  const details = document.createElement("div");
  details.className = "log-details";
  details.textContent = detail;

  entry.append(heading, details);
  container.prepend(entry);
}

async function api(functionPath, options = {}) {
  if (!state.supabase) throw new Error("Configure Supabase first.");
  await refreshSession();
  if (!state.session?.access_token) throw new Error("Sign in before calling authenticated APIs.");

  const method = options.method ?? "GET";
  const cleanPath = functionPath.replace(/^\/+/, "");
  const url = new URL(`${state.config.supabaseUrl}/functions/v1/${cleanPath}`);
  if (options.query) {
    const query = options.query instanceof URLSearchParams
      ? options.query
      : new URLSearchParams(options.query);
    for (const [key, val] of query) url.searchParams.set(key, val);
  }

  const started = performance.now();
  const headers = {
    apikey: state.config.supabaseAnonKey,
    authorization: `Bearer ${state.session.access_token}`,
  };
  if (options.body !== undefined) headers["content-type"] = "application/json";

  const response = await fetch(url, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const textBody = await response.text();
  let payload;
  try {
    payload = textBody ? JSON.parse(textBody) : {};
  } catch {
    payload = { body: textBody };
  }

  const durationMs = Math.round(performance.now() - started);
  logEntry({
    title: `${method} ${url.pathname}${url.search}`,
    ok: response.ok,
    status: response.status,
    durationMs,
    detail: response.ok ? "Response loaded." : payload?.error?.message ?? `HTTP ${response.status}`,
  });
  setResponse(payload);

  if (!response.ok) {
    const error = new Error(payload?.error?.message ?? `HTTP ${response.status}`);
    error.payload = payload;
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function run(label, fn) {
  try {
    const result = await fn();
    if (result !== undefined) setResponse(result);
    return result;
  } catch (error) {
    const payload = error?.payload ?? {
      error: {
        message: error instanceof Error ? error.message : String(error),
      },
    };
    setResponse(payload);
    logEntry({
      title: label,
      ok: false,
      status: error?.status ?? "local",
      durationMs: 0,
      detail: payload?.error?.message ?? "Request failed.",
    });
    return undefined;
  }
}

function selectedProjectId() {
  const projectId = value("selected-project-id");
  if (!projectId) throw new Error("Select or paste a project ID first.");
  return projectId;
}

function selectedConversationId() {
  return value("selected-conversation-id");
}

function projectBody({ creating }) {
  const body = {};
  const name = value("project-name");
  if (creating || name) body.name = name;

  const optionalStrings = [
    ["project-description", "description"],
    ["project-agent-name", "agent_name"],
    ["project-instructions", "agent_instructions"],
    ["project-model", "default_model"],
  ];
  for (const [id, key] of optionalStrings) {
    const fieldValue = value(id);
    if (fieldValue) body[key] = fieldValue;
  }

  const optionalNumbers = [
    ["cap-context-chars", "max_context_chars_per_source"],
    ["cap-chunks", "max_chunks_per_project"],
    ["cap-chats", "max_chat_messages_per_day"],
  ];
  for (const [id, key] of optionalNumbers) {
    const fieldValue = value(id);
    if (fieldValue) body[key] = Number(fieldValue);
  }
  return body;
}

function fillProjectForm(project) {
  setValue("project-name", project.name);
  setValue("project-description", project.description);
  setValue("project-agent-name", project.agent_name);
  setValue("project-instructions", project.agent_instructions);
  setValue("project-model", project.default_model);
  setValue("cap-context-chars", project.max_context_chars_per_source);
  setValue("cap-chunks", project.max_chunks_per_project);
  setValue("cap-chats", project.max_chat_messages_per_day);
}

function renderList(containerId, items, renderer) {
  const container = $(containerId);
  container.replaceChildren();
  if (!items?.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Nothing here yet.";
    container.append(empty);
    return;
  }
  for (const item of items) container.append(renderer(item));
}

function itemShell(title, metaLines = []) {
  const item = document.createElement("div");
  item.className = "list-item";

  const strong = document.createElement("strong");
  strong.textContent = title;
  item.append(strong);

  for (const line of metaLines.filter(Boolean)) {
    const meta = document.createElement("div");
    meta.className = "item-meta";
    meta.textContent = line;
    item.append(meta);
  }
  return item;
}

function renderMini(containerId, rows) {
  const container = $(containerId);
  container.replaceChildren();
  if (!rows?.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Nothing loaded yet.";
    container.append(empty);
    return;
  }
  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "mini-item";
    item.textContent = row;
    container.append(item);
  }
}

function actions(...buttons) {
  const row = document.createElement("div");
  row.className = "item-actions";
  row.append(...buttons);
  return row;
}

function actionButton(label, handler, className = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  if (className) button.className = className;
  button.addEventListener("click", handler);
  return button;
}

async function listProjects() {
  const payload = await api("v1-projects");
  renderProjects(payload.projects ?? []);
  return payload;
}

function renderAccount(payload) {
  const user = payload.user ?? {};
  const plan = payload.plan ?? {};
  const security = payload.security ?? {};
  const projects = payload.projects ?? [];
  setValue("full-name", user.full_name ?? "");
  renderMini("account-summary", [
    `Email: ${user.email ?? "unknown"}`,
    `Full name: ${user.full_name ?? "not set"}`,
    `Tenure: ${user.tenure_days ?? 0} day(s)`,
    `Plan: ${plan.name ?? "Free"} (${plan.status ?? "free"})`,
    `MFA: ${security.totp_enabled ? "TOTP enabled" : "TOTP not enabled"} · AAL: ${
      security.aal ?? "aal1"
    } · verified factors: ${security.verified_factor_count ?? 0}`,
    `Projects: ${projects.length}`,
  ]);
}

async function loadAccount() {
  const payload = await api("v1-account");
  renderAccount(payload);
  renderProjects(payload.projects ?? []);
  return payload;
}

async function updateProfile() {
  const payload = await api("v1-account", {
    method: "PATCH",
    body: { full_name: value("full-name") || null },
  });
  await loadAccount();
  return payload;
}

async function sendPasswordReset() {
  if (!state.supabase) throw new Error("Configure Supabase first.");
  const email = value("email");
  if (!email) throw new Error("Enter the account email first.");
  const redirectTo = `${location.origin}/`;
  const { data, error } = await state.supabase.auth.resetPasswordForEmail(email, {
    redirectTo,
  });
  if (error) throw error;
  return { reset_email_sent: true, redirect_to: redirectTo, data };
}

async function updatePassword() {
  if (!state.supabase) throw new Error("Configure Supabase first.");
  const password = value("new-password");
  if (!password) throw new Error("Enter a new password first.");
  const { data, error } = await state.supabase.auth.updateUser({ password });
  if (error) throw error;
  setValue("new-password", "");
  return { password_updated: true, user: data.user };
}

function renderMfaFactors(payload) {
  const data = payload?.data ?? payload;
  const factors = [
    ...(Array.isArray(data?.totp) ? data.totp : []),
    ...(Array.isArray(data?.phone) ? data.phone : []),
  ];
  renderMini(
    "mfa-list",
    factors.map((factor) =>
      `${factor.factor_type ?? factor.type ?? "factor"} · ${factor.status ?? "unknown"} · ${
        factor.friendly_name ?? "unnamed"
      } · ${factor.id}`
    ),
  );
}

async function listMfa() {
  if (!state.supabase) throw new Error("Configure Supabase first.");
  const { data, error } = await state.supabase.auth.mfa.listFactors();
  if (error) throw error;
  renderMfaFactors({ data });
  return data;
}

async function enrollMfa() {
  if (!state.supabase) throw new Error("Configure Supabase first.");
  const { data, error } = await state.supabase.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: value("mfa-friendly-name") || "ReplyMate Workbench",
  });
  if (error) throw error;
  if (data?.id) setValue("mfa-factor-id", data.id);
  renderMini("mfa-list", [
    `Factor ID: ${data?.id ?? "unknown"}`,
    "Scan the QR code URI below with your authenticator app, then run Challenge and Verify.",
    data?.totp?.uri ?? data?.totp?.qr_code ?? "No TOTP URI returned.",
  ]);
  const qrCode = data?.totp?.qr_code;
  if (qrCode) {
    const image = document.createElement("img");
    image.className = "qr-code";
    image.alt = "TOTP enrollment QR code";
    image.src = String(qrCode).trim().startsWith("<svg")
      ? `data:image/svg+xml;utf8,${encodeURIComponent(qrCode)}`
      : qrCode;
    $("mfa-list").append(image);
  }
  return data;
}

async function challengeMfa() {
  if (!state.supabase) throw new Error("Configure Supabase first.");
  const factorId = value("mfa-factor-id");
  if (!factorId) throw new Error("Enter or select a factor ID first.");
  const { data, error } = await state.supabase.auth.mfa.challenge({ factorId });
  if (error) throw error;
  if (data?.id) setValue("mfa-challenge-id", data.id);
  return data;
}

async function verifyMfa() {
  if (!state.supabase) throw new Error("Configure Supabase first.");
  const factorId = value("mfa-factor-id");
  const challengeId = value("mfa-challenge-id");
  const code = value("mfa-code");
  if (!factorId || !challengeId || !code) {
    throw new Error("Enter factor ID, challenge ID, and authenticator code.");
  }
  const { data, error } = await state.supabase.auth.mfa.verify({
    factorId,
    challengeId,
    code,
  });
  if (error) throw error;
  await refreshSession();
  await listMfa();
  return data;
}

async function unenrollMfa() {
  if (!state.supabase) throw new Error("Configure Supabase first.");
  const factorId = value("mfa-factor-id");
  if (!factorId) throw new Error("Enter or select a factor ID first.");
  if (!confirm(`Unenroll MFA factor ${factorId}?`)) return undefined;
  const { data, error } = await state.supabase.auth.mfa.unenroll({ factorId });
  if (error) throw error;
  setValue("mfa-factor-id", "");
  setValue("mfa-challenge-id", "");
  setValue("mfa-code", "");
  await listMfa();
  return data;
}

function renderProjects(projects) {
  renderList("projects-list", projects, (project) => {
    const item = itemShell(project.name ?? "Untitled project", [
      `id: ${project.id}`,
      `status: ${project.status} · model: ${project.default_model ?? "default"} · updated: ${
        project.updated_at ?? "unknown"
      }`,
    ]);
    item.append(actions(
      actionButton("Select", () => {
        setValue("selected-project-id", project.id);
        fillProjectForm(project);
        saveStoredConfig();
      }),
      actionButton("Members", () => run("List members", listMembers)),
      actionButton("Sources", () => run("List sources", listSources)),
      actionButton("Chat list", () => run("List conversations", listConversations)),
    ));
    return item;
  });
}

async function createProject() {
  const payload = await api("v1-projects", {
    method: "POST",
    body: projectBody({ creating: true }),
  });
  if (payload.project?.id) {
    setValue("selected-project-id", payload.project.id);
    fillProjectForm(payload.project);
    saveStoredConfig();
  }
  await listProjects();
  return payload;
}

async function getProject() {
  const payload = await api("v1-projects", {
    query: { project_id: selectedProjectId() },
  });
  if (payload.project) fillProjectForm(payload.project);
  return payload;
}

async function updateProject() {
  const payload = await api("v1-projects", {
    method: "PATCH",
    body: { project_id: selectedProjectId(), ...projectBody({ creating: false }) },
  });
  if (payload.project) fillProjectForm(payload.project);
  await listProjects();
  return payload;
}

async function deleteProject() {
  const projectId = selectedProjectId();
  if (!confirm(`Delete project ${projectId}? This removes sources, chunks, files, and messages.`)) {
    return undefined;
  }
  const payload = await api("v1-projects", {
    method: "DELETE",
    query: { project_id: projectId },
  });
  setValue("selected-project-id", "");
  saveStoredConfig();
  await listProjects();
  return payload;
}

async function listMembers() {
  const payload = await api("v1-projects", {
    query: { resource: "members", project_id: selectedProjectId() },
  });
  renderList("members-list", payload.members ?? [], (member) => {
    const profile = member.profile ?? {};
    const item = itemShell(profile.email ?? member.user_id, [
      `user_id: ${member.user_id}`,
      `role: ${member.role} · member id: ${member.id}`,
    ]);
    item.append(actions(
      actionButton("Use user ID", () => setValue("member-user-id", member.user_id)),
    ));
    return item;
  });
  return payload;
}

async function addMember() {
  const payload = await api("v1-projects", {
    method: "POST",
    body: {
      action: "add_member",
      project_id: selectedProjectId(),
      email: value("member-email"),
      role: value("member-role") || "member",
    },
  });
  await listMembers();
  return payload;
}

async function updateMember() {
  const payload = await api("v1-projects", {
    method: "PATCH",
    body: {
      action: "update_member",
      project_id: selectedProjectId(),
      user_id: value("member-user-id"),
      role: value("member-role") || "member",
    },
  });
  await listMembers();
  return payload;
}

async function removeMember() {
  const userId = value("member-user-id");
  if (!userId) throw new Error("Paste or select a member user ID.");
  if (!confirm(`Remove member ${userId}?`)) return undefined;
  const payload = await api("v1-projects", {
    method: "DELETE",
    query: { resource: "members", project_id: selectedProjectId(), user_id: userId },
  });
  await listMembers();
  return payload;
}

async function addContext() {
  const payload = await api("v1-context", {
    method: "POST",
    body: {
      project_id: selectedProjectId(),
      title: value("context-title"),
      text: value("context-text"),
    },
  });
  await listSources();
  return payload;
}

async function listSources() {
  const payload = await api("v1-context", {
    query: { project_id: selectedProjectId() },
  });
  renderSources(payload.sources ?? []);
  return payload;
}

function renderSources(sources) {
  renderList("sources-list", sources, (source) => {
    const item = itemShell(source.title ?? source.id, [
      `id: ${source.id}`,
      `type: ${source.source_type} · status: ${source.status} · chunks: ${
        source.chunk_count ?? "?"
      }`,
      source.error_message ? `error: ${source.error_message}` : "",
    ]);
    item.append(actions(
      actionButton("Use source ID", () => setValue("source-id", source.id)),
      actionButton("Delete", () => {
        setValue("source-id", source.id);
        run("Delete source", deleteSource);
      }, "danger"),
    ));
    return item;
  });
}

async function deleteSource() {
  const sourceId = value("source-id");
  if (!sourceId) throw new Error("Paste or select a source ID.");
  if (!confirm(`Delete source ${sourceId}?`)) return undefined;
  const payload = await api("v1-context", {
    method: "DELETE",
    query: { source_id: sourceId },
  });
  await listSources();
  return payload;
}

function guessMime(file) {
  if (file.type) return file.type;
  if (/\.(md|markdown)$/i.test(file.name)) return "text/markdown";
  return "text/plain";
}

async function uploadFile(projectId, file, title) {
  const mimeType = guessMime(file);
  const created = await api("v1-upload", {
    method: "POST",
    body: {
      action: "create_upload",
      project_id: projectId,
      filename: file.name,
      mime_type: mimeType,
      size_bytes: file.size,
      ...(title ? { title } : {}),
    },
  });
  const upload = created.upload;
  if (!upload?.path || !upload?.token) throw new Error("Upload descriptor was incomplete.");

  const { error } = await state.supabase.storage
    .from("project-files")
    .uploadToSignedUrl(upload.path, upload.token, file, {
      contentType: mimeType,
      upsert: false,
    });
  if (error) throw error;

  logEntry({
    title: `STORAGE upload ${upload.path}`,
    ok: true,
    status: "signed",
    durationMs: 0,
    detail: "File uploaded to Supabase Storage signed URL.",
  });

  return await api("v1-upload", {
    method: "POST",
    body: { action: "process", source_id: created.source.id },
  });
}

async function uploadAndProcess() {
  const file = $("upload-file").files?.[0];
  if (!file) throw new Error("Choose a .txt or .md file first.");
  const payload = await uploadFile(selectedProjectId(), file, value("upload-title"));
  await listSources();
  return payload;
}

async function listConversations() {
  const payload = await api("v1-chat", {
    query: { project_id: selectedProjectId() },
  });
  renderList("conversations-list", payload.conversations ?? [], (conversation) => {
    const item = itemShell(conversation.title ?? "Untitled conversation", [
      `id: ${conversation.id}`,
      `updated: ${conversation.updated_at ?? conversation.created_at}`,
    ]);
    item.append(actions(
      actionButton("Select", () => {
        setValue("selected-conversation-id", conversation.id);
        saveStoredConfig();
      }),
      actionButton("Load messages", () => {
        setValue("selected-conversation-id", conversation.id);
        saveStoredConfig();
        run("Load conversation", loadConversation);
      }),
    ));
    return item;
  });
  return payload;
}

function renderChat(messages) {
  const container = $("chat-history");
  container.replaceChildren();
  for (const message of messages ?? []) {
    const bubble = document.createElement("div");
    bubble.className = `message ${message.role === "assistant" ? "assistant" : ""}`;
    const role = document.createElement("div");
    role.className = "message-role";
    role.textContent = message.role;
    const content = document.createElement("div");
    content.className = "message-content";
    content.textContent = message.content;
    bubble.append(role, content);
    container.append(bubble);
  }
}

async function loadConversation() {
  const conversationId = selectedConversationId();
  if (!conversationId) throw new Error("Select or paste a conversation ID first.");
  const payload = await api("v1-chat", {
    query: { conversation_id: conversationId },
  });
  renderChat(payload.messages ?? []);
  return payload;
}

async function sendChat() {
  const body = {
    project_id: selectedProjectId(),
    message: value("chat-message"),
  };
  const conversationId = selectedConversationId();
  if (conversationId) body.conversation_id = conversationId;

  const payload = await api("v1-chat", { method: "POST", body });
  if (payload.conversation_id) {
    setValue("selected-conversation-id", payload.conversation_id);
    saveStoredConfig();
  }
  setValue("chat-message", "");
  await loadConversation();
  await listConversations();
  return payload;
}

async function sendRaw() {
  const method = value("raw-method") || "GET";
  const bodyText = $("raw-body").value.trim();
  let body;
  if (bodyText) body = JSON.parse(bodyText);
  return await api(value("raw-path") || "v1-projects", { method, body });
}

async function refreshAll() {
  await refreshSession();
  if (!state.session) return { signed_in: false };
  const result = {};
  result.account = await loadAccount();
  result.projects = await listProjects();
  if (value("selected-project-id")) {
    result.sources = await listSources().catch((error) => ({ error: error.message }));
    result.members = await listMembers().catch((error) => ({ error: error.message }));
    result.conversations = await listConversations().catch((error) => ({ error: error.message }));
  }
  return result;
}

async function runSmokeFlow() {
  const project = await api("v1-projects", {
    method: "POST",
    body: {
      name: `Workbench Smoke ${new Date().toISOString()}`,
      agent_name: "Smoke Agent",
      agent_instructions: "Answer concisely using the supplied project context.",
    },
  });
  const projectId = project.project.id;
  setValue("selected-project-id", projectId);
  fillProjectForm(project.project);
  saveStoredConfig();

  const textSource = await api("v1-context", {
    method: "POST",
    body: {
      project_id: projectId,
      title: "Workbench smoke facts",
      text: "The ReplyMate workbench launch color is cobalt blue.",
    },
  });

  const markdownFile = new File(
    [
      "# Smoke document\n\nThe project mascot is an otter named Ada.",
    ],
    "workbench-smoke.md",
    { type: "text/markdown" },
  );
  const fileSource = await uploadFile(projectId, markdownFile, "Workbench smoke markdown");

  const chat = await api("v1-chat", {
    method: "POST",
    body: {
      project_id: projectId,
      message: "What is the launch color and who is the mascot?",
    },
  });
  if (chat.conversation_id) setValue("selected-conversation-id", chat.conversation_id);

  await listProjects();
  await listSources();
  await listConversations();
  await loadConversation();

  return { project, textSource, fileSource, chat };
}

async function signup() {
  if (!state.supabase) throw new Error("Configure Supabase first.");
  const { data, error } = await state.supabase.auth.signUp({
    email: value("email"),
    password: value("password"),
  });
  if (error) throw error;
  await refreshSession();
  saveStoredConfig();
  return data;
}

async function login() {
  if (!state.supabase) throw new Error("Configure Supabase first.");
  const { data, error } = await state.supabase.auth.signInWithPassword({
    email: value("email"),
    password: value("password"),
  });
  if (error) throw error;
  await refreshSession();
  saveStoredConfig();
  return data;
}

async function logout() {
  if (!state.supabase) return {};
  const { error } = await state.supabase.auth.signOut();
  if (error) throw error;
  await refreshSession();
  return { signed_out: true };
}

function wire(id, handler) {
  $(id).addEventListener("click", () => run(id, handler));
}

function wireEvents() {
  $("save-config").addEventListener("click", async () => {
    state.config.supabaseUrl = normalizeUrl(value("supabase-url"));
    state.config.supabaseAnonKey = value("anon-key");
    state.config.projectRef = projectRefFromUrl(state.config.supabaseUrl) ||
      state.config.projectRef;
    createSupabaseClient();
    saveStoredConfig();
    setConnectionStatus();
    refreshWebhookUrls();
    await run("Refresh session", refreshSession);
  });

  $("save-selection").addEventListener("click", () => {
    saveStoredConfig();
    setResponse({
      selected_project_id: value("selected-project-id"),
      selected_conversation_id: value("selected-conversation-id"),
    });
  });

  wire("signup", signup);
  wire("login", login);
  wire("logout", logout);
  wire("load-account", loadAccount);
  wire("update-profile", updateProfile);
  wire("send-password-reset", sendPasswordReset);
  wire("update-password", updatePassword);
  wire("list-mfa", listMfa);
  wire("enroll-mfa", enrollMfa);
  wire("challenge-mfa", challengeMfa);
  wire("verify-mfa", verifyMfa);
  wire("unenroll-mfa", unenrollMfa);
  wire("refresh-all", refreshAll);
  wire("smoke-test", runSmokeFlow);
  wire("list-projects", listProjects);
  wire("create-project", createProject);
  wire("get-project", getProject);
  wire("update-project", updateProject);
  wire("delete-project", deleteProject);
  wire("list-members", listMembers);
  wire("add-member", addMember);
  wire("update-member", updateMember);
  wire("remove-member", removeMember);
  wire("add-context", addContext);
  wire("list-sources", listSources);
  wire("delete-source", deleteSource);
  wire("upload-process", uploadAndProcess);
  wire("list-conversations", listConversations);
  wire("load-conversation", loadConversation);
  wire("send-chat", sendChat);
  wire("send-raw", sendRaw);

  $("copy-response").addEventListener("click", async () => {
    await navigator.clipboard.writeText(pretty(state.lastResponse));
  });
  $("clear-log").addEventListener("click", () => $("request-log").replaceChildren());
}

async function init() {
  const serverConfig = await loadServerConfig().catch(() => ({}));
  const stored = loadStoredConfig();
  state.config = {
    ...state.config,
    ...serverConfig,
    ...stored,
    projectRef: serverConfig.projectRef ?? stored.projectRef ?? "",
    hostedFunctionsBase: serverConfig.hostedFunctionsBase ?? "",
    workbenchOrigin: serverConfig.workbenchOrigin ?? "",
  };

  setValue("supabase-url", state.config.supabaseUrl);
  setValue("anon-key", state.config.supabaseAnonKey);
  setValue("email", stored.email ?? "");
  setValue("selected-project-id", stored.projectId ?? "");
  setValue("selected-conversation-id", stored.conversationId ?? "");
  setConnectionStatus();
  refreshWebhookUrls();
  createSupabaseClient();
  wireEvents();

  if (state.supabase) {
    state.supabase.auth.onAuthStateChange((_event, session) => {
      state.session = session ?? undefined;
      setAuthStatus();
    });
    await refreshSession();
  }
  setResponse({
    ready: true,
    next_steps: [
      "Run npm run db:start and npm run functions:serve if testing locally.",
      "Make sure ALLOWED_ORIGINS includes http://127.0.0.1:4173 and http://localhost:4173.",
      "Sign up or log in, create/select a project, add context, then chat.",
    ],
  });
}

init().catch((error) => {
  setResponse({ error: { message: error instanceof Error ? error.message : String(error) } });
});
