create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.projects (
  id uuid primary key default extensions.gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  description text check (description is null or char_length(description) <= 2000),
  agent_name text not null default 'Project Agent'
    check (char_length(btrim(agent_name)) between 1 and 120),
  agent_instructions text check (
    agent_instructions is null or char_length(agent_instructions) <= 12000
  ),
  default_model text not null default 'gpt-5.4-nano'
    check (default_model in ('gpt-5.4-nano', 'gpt-5.4-mini')),
  status text not null default 'active' check (status in ('active', 'archived')),
  max_context_chars_per_source integer not null default 100000
    check (max_context_chars_per_source between 1000 and 500000),
  max_chunks_per_project integer not null default 500
    check (max_chunks_per_project between 1 and 5000),
  max_chat_messages_per_day integer not null default 100
    check (max_chat_messages_per_day between 1 and 1000),
  max_file_size_mb integer not null default 5
    check (max_file_size_mb between 1 and 10),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_id)
);

create table public.project_members (
  id uuid primary key default extensions.gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  unique (project_id, user_id)
);

create table public.knowledge_sources (
  id uuid primary key default extensions.gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete restrict,
  source_type text not null check (source_type in ('text', 'file', 'url', 'manual')),
  title text check (title is null or char_length(title) <= 300),
  raw_text text check (raw_text is null or char_length(raw_text) <= 500000),
  storage_path text,
  original_filename text,
  mime_type text,
  file_size_bytes bigint check (file_size_bytes is null or file_size_bytes >= 0),
  content_hash text,
  embedding_model text,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'ready', 'failed')),
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, project_id)
);

create unique index knowledge_sources_project_hash_uidx
  on public.knowledge_sources (project_id, content_hash)
  where content_hash is not null and status in ('processing', 'ready');

create table public.knowledge_chunks (
  id uuid primary key default extensions.gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  source_id uuid not null,
  chunk_index integer not null check (chunk_index >= 0),
  content text not null check (char_length(content) > 0),
  token_count integer check (token_count is null or token_count >= 0),
  embedding extensions.vector(1536) not null,
  embedding_model text not null default 'text-embedding-3-small',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (source_id, project_id)
    references public.knowledge_sources(id, project_id) on delete cascade,
  unique (source_id, chunk_index)
);

create table public.conversations (
  id uuid primary key default extensions.gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text check (title is null or char_length(title) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, project_id)
);

create table public.messages (
  id uuid primary key default extensions.gen_random_uuid(),
  conversation_id uuid not null,
  project_id uuid not null references public.projects(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system', 'tool')),
  content text not null check (char_length(content) > 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (conversation_id, project_id)
    references public.conversations(id, project_id) on delete cascade
);

create table public.agent_runs (
  id uuid primary key default extensions.gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  conversation_id uuid,
  user_id uuid not null references auth.users(id) on delete cascade,
  run_type text not null check (
    run_type in ('chat', 'embedding', 'ingestion', 'outreach_draft', 'outreach_send')
  ),
  model text,
  input_tokens integer not null default 0 check (input_tokens >= 0),
  cached_input_tokens integer not null default 0 check (cached_input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  estimated_cost numeric(18, 10) not null default 0 check (estimated_cost >= 0),
  status text not null default 'pending' check (status in ('success', 'failed', 'pending')),
  error_message text,
  created_at timestamptz not null default now(),
  foreign key (conversation_id, project_id)
    references public.conversations(id, project_id) on delete set null (conversation_id)
);

create table public.usage_ledger (
  id uuid primary key default extensions.gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_run_id uuid references public.agent_runs(id) on delete set null,
  event_type text not null,
  quantity numeric not null default 1 check (quantity >= 0),
  unit text,
  estimated_cost numeric(18, 10) not null default 0 check (estimated_cost >= 0),
  provider text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.job_queue (
  id uuid primary key default extensions.gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  job_type text not null,
  payload jsonb not null,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'completed', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 20),
  run_after timestamptz not null default now(),
  locked_at timestamptz,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.contacts (
  id uuid primary key default extensions.gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text,
  phone text,
  email text,
  consent_status text not null default 'unknown',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (id, project_id)
);

create table public.outbound_messages (
  id uuid primary key default extensions.gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  contact_id uuid,
  provider text,
  requested_channel text check (requested_channel is null or requested_channel in ('sms', 'mms', 'rcs')),
  actual_channel text check (actual_channel is null or actual_channel in ('sms', 'mms', 'rcs')),
  to_address text,
  from_address text,
  body text,
  rich_payload jsonb not null default '{}'::jsonb,
  status text,
  provider_message_id text,
  estimated_cost numeric(18, 10) not null default 0 check (estimated_cost >= 0),
  actual_cost numeric(18, 10) check (actual_cost is null or actual_cost >= 0),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  foreign key (contact_id, project_id)
    references public.contacts(id, project_id) on delete set null (contact_id)
);

create unique index outbound_messages_provider_id_uidx
  on public.outbound_messages (provider, provider_message_id)
  where provider_message_id is not null;

create table public.subscriptions (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  stripe_customer_id text,
  stripe_subscription_id text not null unique,
  plan text,
  status text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  stripe_event_created_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.provider_webhook_events (
  id uuid primary key default extensions.gen_random_uuid(),
  provider text not null check (provider in ('stripe', 'twilio')),
  event_id text not null,
  event_type text,
  status text not null default 'received' check (status in ('received', 'processed', 'ignored', 'failed')),
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (provider, event_id)
);

create index project_members_user_project_idx on public.project_members (user_id, project_id);
create unique index profiles_lower_email_uidx on public.profiles (lower(email)) where email is not null;
create index project_members_project_role_idx on public.project_members (project_id, role);
create index knowledge_sources_project_created_idx on public.knowledge_sources (project_id, created_at desc);
create index knowledge_chunks_project_source_idx on public.knowledge_chunks (project_id, source_id);
create index conversations_user_project_updated_idx on public.conversations (user_id, project_id, updated_at desc);
create index messages_conversation_created_idx on public.messages (conversation_id, created_at);
create index agent_runs_project_user_created_idx on public.agent_runs (project_id, user_id, created_at desc);
create index usage_ledger_project_created_idx on public.usage_ledger (project_id, created_at desc);
create index job_queue_claim_idx on public.job_queue (status, run_after, created_at)
  where status = 'queued';
create index contacts_project_idx on public.contacts (project_id);
create index outbound_messages_project_created_idx on public.outbound_messages (project_id, created_at desc);
create index subscriptions_user_idx on public.subscriptions (user_id);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger projects_touch_updated_at before update on public.projects
for each row execute function public.touch_updated_at();
create trigger profiles_touch_updated_at before update on public.profiles
for each row execute function public.touch_updated_at();
create trigger knowledge_sources_touch_updated_at before update on public.knowledge_sources
for each row execute function public.touch_updated_at();
create trigger conversations_touch_updated_at before update on public.conversations
for each row execute function public.touch_updated_at();
create trigger job_queue_touch_updated_at before update on public.job_queue
for each row execute function public.touch_updated_at();
create trigger subscriptions_touch_updated_at before update on public.subscriptions
for each row execute function public.touch_updated_at();

create or replace function public.handle_auth_user_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data ->> 'full_name')
  on conflict (id) do update
    set email = excluded.email,
        full_name = coalesce(excluded.full_name, public.profiles.full_name),
        updated_at = now();
  return new;
end;
$$;

create trigger auth_user_profile_created
after insert or update of email, raw_user_meta_data on auth.users
for each row execute function public.handle_auth_user_change();

insert into public.profiles (id, email, full_name)
select id, email, raw_user_meta_data ->> 'full_name'
from auth.users
on conflict (id) do update set
  email = excluded.email,
  full_name = coalesce(excluded.full_name, public.profiles.full_name),
  updated_at = now();

create or replace function public.create_owner_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.project_members (project_id, user_id, role)
  values (new.id, new.owner_id, 'owner');
  return new;
end;
$$;

create trigger project_owner_membership_created
after insert on public.projects
for each row execute function public.create_owner_membership();

create or replace function public.protect_project_owner()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.owner_id <> old.owner_id then
    raise exception 'project owner cannot be changed' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger project_owner_is_immutable
before update of owner_id on public.projects
for each row execute function public.protect_project_owner();

create or replace function public.protect_owner_membership()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (
    new.user_id <> old.user_id or new.project_id <> old.project_id
  ) then
    raise exception 'membership identity is immutable' using errcode = '42501';
  end if;

  if tg_op = 'UPDATE' and old.role = 'owner' and (
    new.role <> old.role or new.user_id <> old.user_id or new.project_id <> old.project_id
  ) then
    raise exception 'owner membership is immutable' using errcode = '42501';
  end if;

  if tg_op = 'DELETE' and old.role = 'owner'
     and exists (select 1 from public.projects p where p.id = old.project_id) then
    raise exception 'owner membership cannot be removed' using errcode = '42501';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger project_owner_membership_is_immutable
before update or delete on public.project_members
for each row execute function public.protect_owner_membership();
