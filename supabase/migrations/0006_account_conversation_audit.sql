drop policy if exists conversations_select_own on public.conversations;

create policy conversations_select_member_or_admin on public.conversations
for select to authenticated
using (
  public.is_project_admin(project_id)
  or (
    user_id = (select auth.uid())
    and public.is_project_member(project_id)
  )
);

drop policy if exists messages_select_own_conversation on public.messages;

create policy messages_select_own_conversation_or_project_admin on public.messages
for select to authenticated
using (
  exists (
    select 1
    from public.conversations c
    where c.id = messages.conversation_id
      and c.project_id = messages.project_id
      and (
        public.is_project_admin(messages.project_id)
        or (
          c.user_id = (select auth.uid())
          and public.is_project_member(messages.project_id)
        )
      )
  )
);
