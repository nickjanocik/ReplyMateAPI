alter table public.contacts
  add constraint contacts_consent_status_check
  check (consent_status in ('unknown', 'opted_in', 'opted_out'));

create unique index contacts_project_phone_uidx
  on public.contacts (project_id, phone)
  where phone is not null;

alter table public.outbound_messages
  add column conversation_id uuid,
  add column initiated_by uuid references auth.users(id) on delete set null,
  add constraint outbound_messages_conversation_project_fkey
    foreign key (conversation_id, project_id)
    references public.conversations(id, project_id) on delete set null (conversation_id);

create index outbound_messages_conversation_created_idx
  on public.outbound_messages (conversation_id, created_at);

comment on column public.contacts.metadata is
  'Intake provenance and consent evidence. The v1-outreach simulation records trigger_source, consent evidence, and submission time here.';

comment on column public.outbound_messages.conversation_id is
  'Links an outreach attempt to the auditable project conversation shown in the dashboard.';
