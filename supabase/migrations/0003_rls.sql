create or replace function public.is_project_member(check_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.project_members pm
    where pm.project_id = check_project_id
      and pm.user_id = auth.uid()
  );
$$;

create or replace function public.project_role(check_project_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select pm.role
  from public.project_members pm
  where pm.project_id = check_project_id
    and pm.user_id = auth.uid()
  limit 1;
$$;

create or replace function public.is_project_admin(check_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.project_role(check_project_id) in ('owner', 'admin'), false);
$$;

revoke all on function public.is_project_member(uuid) from public;
revoke all on function public.project_role(uuid) from public;
revoke all on function public.is_project_admin(uuid) from public;
grant execute on function public.is_project_member(uuid) to authenticated;
grant execute on function public.project_role(uuid) to authenticated;
grant execute on function public.is_project_admin(uuid) to authenticated;

alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.project_members enable row level security;
alter table public.knowledge_sources enable row level security;
alter table public.knowledge_chunks enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.agent_runs enable row level security;
alter table public.usage_ledger enable row level security;
alter table public.job_queue enable row level security;
alter table public.contacts enable row level security;
alter table public.outbound_messages enable row level security;
alter table public.subscriptions enable row level security;
alter table public.provider_webhook_events enable row level security;

create policy profiles_select_own on public.profiles
for select to authenticated
using (id = (select auth.uid()));

create policy profiles_update_own on public.profiles
for update to authenticated
using (id = (select auth.uid()))
with check (id = (select auth.uid()));

create policy projects_select_member on public.projects
for select to authenticated
using (public.is_project_member(id));

create policy projects_insert_owner on public.projects
for insert to authenticated
with check (owner_id = (select auth.uid()));

create policy projects_update_admin on public.projects
for update to authenticated
using (public.is_project_admin(id))
with check (public.is_project_admin(id));

create policy projects_delete_admin on public.projects
for delete to authenticated
using (public.is_project_admin(id));

create policy project_members_select_member on public.project_members
for select to authenticated
using (public.is_project_member(project_id));

create policy project_members_insert_by_role on public.project_members
for insert to authenticated
with check (
  user_id <> (select auth.uid())
  and (
    (public.project_role(project_id) = 'owner' and role in ('admin', 'member'))
    or (public.project_role(project_id) = 'admin' and role = 'member')
  )
);

create policy project_members_update_by_role on public.project_members
for update to authenticated
using (
  (public.project_role(project_id) = 'owner' and role in ('admin', 'member'))
  or (public.project_role(project_id) = 'admin' and role = 'member')
)
with check (
  (public.project_role(project_id) = 'owner' and role in ('admin', 'member'))
  or (public.project_role(project_id) = 'admin' and role = 'member')
);

create policy project_members_delete_by_role on public.project_members
for delete to authenticated
using (
  (public.project_role(project_id) = 'owner' and role in ('admin', 'member'))
  or (public.project_role(project_id) = 'admin' and role = 'member')
);

create policy knowledge_sources_select_member on public.knowledge_sources
for select to authenticated
using (public.is_project_member(project_id));

create policy knowledge_sources_insert_member on public.knowledge_sources
for insert to authenticated
with check (
  public.is_project_member(project_id)
  and created_by = (select auth.uid())
  and status = 'pending'
);

create policy knowledge_sources_delete_admin on public.knowledge_sources
for delete to authenticated
using (public.is_project_admin(project_id));

create policy knowledge_chunks_select_member on public.knowledge_chunks
for select to authenticated
using (public.is_project_member(project_id));

create policy conversations_select_own on public.conversations
for select to authenticated
using (
  user_id = (select auth.uid())
  and public.is_project_member(project_id)
);

create policy conversations_insert_own on public.conversations
for insert to authenticated
with check (
  user_id = (select auth.uid())
  and public.is_project_member(project_id)
);

create policy conversations_update_own on public.conversations
for update to authenticated
using (
  user_id = (select auth.uid())
  and public.is_project_member(project_id)
)
with check (
  user_id = (select auth.uid())
  and public.is_project_member(project_id)
);

create policy conversations_delete_own on public.conversations
for delete to authenticated
using (
  user_id = (select auth.uid())
  and public.is_project_member(project_id)
);

create policy messages_select_own_conversation on public.messages
for select to authenticated
using (
  exists (
    select 1
    from public.conversations c
    where c.id = messages.conversation_id
      and c.project_id = messages.project_id
      and c.user_id = (select auth.uid())
  )
);

create policy messages_insert_user_own_conversation on public.messages
for insert to authenticated
with check (
  role = 'user'
  and public.is_project_member(project_id)
  and exists (
    select 1
    from public.conversations c
    where c.id = messages.conversation_id
      and c.project_id = messages.project_id
      and c.user_id = (select auth.uid())
  )
);

create policy agent_runs_select_member on public.agent_runs
for select to authenticated
using (public.is_project_member(project_id));

create policy usage_ledger_select_member on public.usage_ledger
for select to authenticated
using (public.is_project_member(project_id));

create policy job_queue_select_member on public.job_queue
for select to authenticated
using (public.is_project_member(project_id));

create policy contacts_select_member on public.contacts
for select to authenticated
using (public.is_project_member(project_id));

create policy outbound_messages_select_member on public.outbound_messages
for select to authenticated
using (public.is_project_member(project_id));

create policy subscriptions_select_own on public.subscriptions
for select to authenticated
using (user_id = (select auth.uid()));

revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;

grant select on public.profiles to authenticated;
grant update (full_name) on public.profiles to authenticated;
grant select, insert, update, delete on public.projects to authenticated;
grant select, insert, update, delete on public.project_members to authenticated;
grant select, insert, delete on public.knowledge_sources to authenticated;
grant select on public.knowledge_chunks to authenticated;
grant select, insert, delete on public.conversations to authenticated;
grant select, insert on public.messages to authenticated;
grant select on public.agent_runs, public.usage_ledger, public.job_queue to authenticated;
grant select on public.contacts, public.outbound_messages, public.subscriptions to authenticated;

grant usage on schema public to authenticated;
