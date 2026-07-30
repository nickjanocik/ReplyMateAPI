-- Google Form intake.
--
-- A customer points an existing Google Form at a project by pasting an Apps
-- Script "on form submit" trigger that POSTs each response to v1-form-intake
-- with a per-project bearer token. The token is the only credential the script
-- holds, so it is stored hashed and shown to the user exactly once.

create table public.project_form_sources (
  id uuid primary key default extensions.gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete restrict,
  label text check (label is null or char_length(label) <= 120),

  -- sha256 of the plaintext token; the plaintext is never persisted.
  token_hash text not null unique,
  -- Trailing characters kept so the UI can identify a token it cannot show.
  token_preview text not null check (char_length(token_preview) <= 12),

  status text not null default 'active' check (status in ('active', 'revoked')),

  -- Question-title -> field mapping. Titles are matched case-insensitively and
  -- ignoring punctuation; these are the fallbacks when nothing else matches.
  field_map jsonb not null default jsonb_build_object(
    'phone', jsonb_build_array('phone', 'phone number', 'mobile', 'mobile number', 'cell'),
    'name', jsonb_build_array('name', 'full name', 'your name', 'first name'),
    'email', jsonb_build_array('email', 'email address', 'your email'),
    'consent', jsonb_build_array('i agree to receive text messages about my enquiry',
                                 'i agree to receive text messages',
                                 'sms consent', 'text consent')
  ),

  response_count integer not null default 0 check (response_count >= 0),
  last_response_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, project_id)
);

create index project_form_sources_project_idx
  on public.project_form_sources (project_id, created_at desc);

create index project_form_sources_active_idx
  on public.project_form_sources (token_hash) where status = 'active';

comment on table public.project_form_sources is
  'Per-project webhook credentials for Google Form intake. token_hash is sha256 of the plaintext token issued once at creation.';

-- Dedupe repeat deliveries of the same Google Form response. Apps Script
-- retries on failure, so without this a flaky network doubles up contacts.
create table public.form_intake_events (
  id uuid primary key default extensions.gen_random_uuid(),
  form_source_id uuid not null references public.project_form_sources(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  external_response_id text not null,
  payload jsonb not null default '{}'::jsonb,
  consent_status text not null default 'unknown'
    check (consent_status in ('unknown', 'opted_in', 'opted_out')),
  created_at timestamptz not null default now(),
  unique (form_source_id, external_response_id)
);

create index form_intake_events_project_created_idx
  on public.form_intake_events (project_id, created_at desc);

comment on table public.form_intake_events is
  'Raw Google Form submissions. Retained as consent evidence and to make intake idempotent per response id.';

alter table public.project_form_sources enable row level security;
alter table public.form_intake_events enable row level security;

-- Reads follow project membership; all writes go through the service role in
-- the edge functions, matching how the rest of the schema is governed.
create policy project_form_sources_select on public.project_form_sources
  for select using (
    exists (
      select 1 from public.project_members m
      where m.project_id = project_form_sources.project_id
        and m.user_id = auth.uid()
    )
  );

create policy form_intake_events_select on public.form_intake_events
  for select using (
    exists (
      select 1 from public.project_members m
      where m.project_id = form_intake_events.project_id
        and m.user_id = auth.uid()
    )
  );

grant select on public.project_form_sources to authenticated;
grant select on public.form_intake_events to authenticated;
grant all on public.project_form_sources to service_role;
grant all on public.form_intake_events to service_role;

-- Contacts may now arrive from a real Google Form, not just the simulation.
comment on column public.contacts.metadata is
  'Intake provenance and consent evidence. trigger_source is one of manual, google_form, google_forms_simulation, api_simulation. Google Form intake records the form source id, response id, the consent question answered, and submission time.';
