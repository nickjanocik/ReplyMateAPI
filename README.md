# ReplyMateAPI

Serverless Supabase backend for multi-tenant project agents: Auth, projects, text/Markdown knowledge ingestion, pgvector retrieval, RAG chat, usage accounting, and safe billing/messaging scaffolds.

## Architecture

- Supabase Auth supplies frontend sessions; there is no backend signup/password endpoint.
- Postgres and strict RLS isolate projects, sources, files, private conversations, messages, usage, and future outreach data.
- `text-embedding-3-small` embeddings live in a 1,536-dimension pgvector column.
- Edge Functions call OpenAI directly with `fetch`; no LangChain or always-on service is used.
- Text and Markdown ingestion is synchronous under project caps. `job_queue` records execution and is the later Cloudflare Queue/worker seam.
- Stripe and Twilio webhooks verify provider signatures. Billing is not enforced and live messaging fails closed in v1.

## Repository layout

```text
supabase/
  migrations/                 SQL schema, RLS, vector search, Storage policies
  functions/
    _shared/                  auth, validation, RAG, OpenAI, usage, providers
    v1-projects/
    v1-context/
    v1-upload/
    v1-chat/
    v1-billing-webhook/
    v1-twilio-webhook/
  tests/database/             pgTAP RLS and vector-isolation tests
scripts/smoke.sh              authenticated end-to-end curl smoke test
```

## Prerequisites

- [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started)
- Docker Desktop for the local Supabase stack
- Deno 2.x for unit checks
- `curl` and `jq` for the smoke script
- A Supabase project and OpenAI API key for deployment

## Local setup

```bash
cp .env.example .env.local
supabase start
supabase db reset
supabase status
```

Copy the local URL, anon key, and service-role key printed by `supabase status` into `.env.local`. Add `OPENAI_API_KEY` and set `ALLOWED_ORIGINS` to exact comma-separated frontend origins.

Serve all functions with the local environment:

```bash
supabase functions serve --env-file .env.local
```

The browser should use its normal Supabase client. `supabase.functions.invoke("v1-projects", ...)` automatically sends the active session token; raw requests must include both `Authorization: Bearer <user-jwt>` and `apikey: <anon-key>`.

## API test CLI

The repository includes `scripts/replymate.ts`, a small Deno client for authentication, project/member management, text ingestion, signed file upload, source listing/deletion, chat, and a cleanup-by-default end-to-end smoke test.

Point it at the local stack and provide a test account:

```bash
export SUPABASE_URL="http://127.0.0.1:54321"
export SUPABASE_ANON_KEY="$(supabase status -o env | sed -n 's/^ANON_KEY=//p' | tr -d '"')"
export REPLYMATE_EMAIL="tester@example.com"
export REPLYMATE_PASSWORD="replace-with-a-test-password"

# Create the account once. If confirmation is enabled, confirm it before continuing.
deno task api -- auth signup

# Verify credentials, then exercise the complete API including OpenAI and Storage.
deno task api -- auth whoami
deno task api -- smoke
```

Use `REPLYMATE_ACCESS_TOKEN` instead of email/password when testing an existing session. The CLI never writes credentials or tokens to disk.

```bash
deno task api -- help
deno task api -- projects list
deno task api -- projects create "Launch Agent"
deno task api -- context add PROJECT_UUID "Facts" "The launch color is cobalt blue."
deno task api -- upload PROJECT_UUID ./notes.md
deno task api -- chat PROJECT_UUID "What is the launch color?"
deno task api -- smoke --keep  # retain the generated project for inspection
```

The smoke command creates a project, embeds text, uploads and processes Markdown, performs grounded chat, checks returned sources/conversations, and deletes the temporary project unless `--keep` is supplied.

## Environment variables

| Variable | Required | Purpose |
|---|---:|---|
| `SUPABASE_URL` | yes | Project/local API URL; supplied automatically when hosted |
| `SUPABASE_ANON_KEY` | yes | Builds the caller-scoped RLS client |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Trusted writes after explicit authorization; never expose to Vercel/browser code |
| `OPENAI_API_KEY` | yes | Embeddings and Responses API |
| `OPENAI_CHAT_MODEL` | no | Default `gpt-5.4-nano`; only approved models are accepted |
| `OPENAI_EMBEDDING_MODEL` | no | Must remain `text-embedding-3-small` in v1 |
| `ALLOWED_ORIGINS` | yes | Exact comma-separated Vercel/local browser origins |
| `STRIPE_SECRET_KEY` | webhook | Stripe signature library configuration |
| `STRIPE_WEBHOOK_SECRET` | webhook | Stripe endpoint signing secret |
| `TWILIO_ACCOUNT_SID` | scaffold | Reserved for the fail-closed outbound provider |
| `TWILIO_AUTH_TOKEN` | webhook | Validates Twilio webhook signatures |
| `TWILIO_MESSAGING_SERVICE_SID` | scaffold | Reserved for future outbound messaging |
| `MESSAGING_MODE` | no | `mock` by default; `live` still returns `LIVE_MESSAGING_NOT_IMPLEMENTED` |

Do not commit `.env.local`. Hosted Supabase already injects its URL/keys; set application secrets with:

```bash
supabase secrets set --env-file .env.production
```

## Database and deployment

Local migrations and SQL tests:

```bash
supabase db reset
supabase test db
```

Push migrations and deploy functions:

```bash
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
supabase functions deploy v1-projects
supabase functions deploy v1-context
supabase functions deploy v1-upload
supabase functions deploy v1-chat
supabase functions deploy v1-billing-webhook
supabase functions deploy v1-twilio-webhook
```

`supabase/config.toml` keeps JWT verification enabled for user APIs and disables it only for Stripe/Twilio, whose handlers verify their own signatures.

## Frontend authentication

Signup and login stay in the Vercel app:

```ts
const { data, error } = await supabase.auth.signUp({
  email,
  password,
  options: { data: { full_name: fullName } },
});

const { data: project } = await supabase.functions.invoke("v1-projects", {
  method: "POST",
  body: { name: "Customer support", agent_instructions: "Answer from project context." },
});
```

Never put `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, Stripe secrets, or Twilio secrets in Vercel variables exposed with a public prefix.

## API examples

Set these once:

```bash
export API_BASE="https://YOUR_PROJECT.supabase.co/functions/v1"
export ANON_KEY="YOUR_ANON_KEY"
export ACCESS_TOKEN="A_SIGNED_IN_USER_JWT"
```

### Projects

```bash
curl -sS "$API_BASE/v1-projects" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ACCESS_TOKEN"

curl -sS -X POST "$API_BASE/v1-projects" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Launch","agent_name":"Launch Agent"}'

curl -sS -X PATCH "$API_BASE/v1-projects" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"project_id":"PROJECT_UUID","default_model":"gpt-5.4-mini"}'
```

Member management uses registered email addresses:

```bash
curl -sS -X POST "$API_BASE/v1-projects" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"add_member","project_id":"PROJECT_UUID","email":"member@example.com","role":"member"}'

curl -sS "$API_BASE/v1-projects?resource=members&project_id=PROJECT_UUID" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ACCESS_TOKEN"
```

### Text context

```bash
curl -sS -X POST "$API_BASE/v1-context" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"project_id":"PROJECT_UUID","title":"Product facts","text":"The launch color is cobalt blue."}'

curl -sS "$API_BASE/v1-context?project_id=PROJECT_UUID" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ACCESS_TOKEN"

curl -sS -X DELETE "$API_BASE/v1-context?source_id=SOURCE_UUID" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ACCESS_TOKEN"
```

### Signed text/Markdown upload

First invoke `v1-upload` with `action: "create_upload"`. Upload with the Supabase browser SDK, then invoke `action: "process"`:

```ts
const { data } = await supabase.functions.invoke("v1-upload", {
  body: {
    action: "create_upload",
    project_id: projectId,
    filename: file.name,
    mime_type: file.type || "text/plain",
    size_bytes: file.size,
  },
});

await supabase.storage.from("project-files").uploadToSignedUrl(
  data.upload.path,
  data.upload.token,
  file,
  { contentType: file.type || "text/plain" },
);

await supabase.functions.invoke("v1-upload", {
  body: { action: "process", source_id: data.source.id },
});
```

PDF, DOCX, non-UTF-8, and files above the project limit are intentionally rejected in v1.

### RAG chat

```bash
curl -sS -X POST "$API_BASE/v1-chat" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"project_id":"PROJECT_UUID","message":"What is the launch color?"}'

curl -sS "$API_BASE/v1-chat?project_id=PROJECT_UUID" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ACCESS_TOKEN"

curl -sS "$API_BASE/v1-chat?conversation_id=CONVERSATION_UUID" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ACCESS_TOKEN"
```

Conversations are private to their creator even when the project is shared.

## Webhooks

Configure provider endpoints as:

- Stripe: `https://YOUR_PROJECT.supabase.co/functions/v1/v1-billing-webhook`
- Twilio: `https://YOUR_PROJECT.supabase.co/functions/v1/v1-twilio-webhook`

Stripe subscription events must carry `metadata.supabase_user_id`; optional `metadata.project_id` and `metadata.plan` are persisted. Unknown event types and subscriptions without identity metadata are acknowledged and marked ignored. Twilio signs the exact configured URL, so do not put an unaccounted proxy or redirect in front of it.

## Verification

```bash
deno task --config supabase/functions/deno.json lint
deno task --config supabase/functions/deno.json check
deno task --config supabase/functions/deno.json test
supabase db reset
supabase test db
```

For a deployed environment:

```bash
export API_BASE="https://YOUR_PROJECT.supabase.co/functions/v1"
export SUPABASE_ANON_KEY="YOUR_ANON_KEY"
export ACCESS_TOKEN="A_SIGNED_IN_USER_JWT"
./scripts/smoke.sh
```

The smoke test creates a project, ingests text, lists sources, chats, and deletes the source. It intentionally retains the project for inspection.

## GitHub remote

The repository is initialized and committed locally, but no remote is configured or pushed. To create a new private GitHub repository with GitHub CLI:

```bash
gh auth login
gh repo create ReplyMateAPI --private --source=. --remote=origin --push
```

To use an existing empty GitHub repository instead:

```bash
git remote add origin git@github.com:YOUR_ACCOUNT/ReplyMateAPI.git
git push -u origin main
```

## Limits and future queue migration

Default project caps are 100,000 normalized characters/source, 500 chunks/project, 100 chat attempts per rolling 24 hours, and 5 MB/file. Only owners/admins can change them, within database-wide ceilings.

Before moving to Cloudflare Queues or another worker:

1. Add an atomic Postgres job-claim function with `FOR UPDATE SKIP LOCKED`.
2. Add retry backoff, stale-lock recovery, idempotency keys, and abandoned-upload cleanup.
3. Publish only `source_id`; keep raw project content in Supabase.
4. Preserve the current source/job/run status transitions and usage records.
