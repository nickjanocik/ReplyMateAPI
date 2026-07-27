begin;

select plan(21);

insert into auth.users (id, email, aud, role, encrypted_password, raw_app_meta_data, raw_user_meta_data)
values
  ('00000000-0000-4000-8000-000000000001', 'owner@example.test', 'authenticated', 'authenticated', '', '{}', '{}'),
  ('00000000-0000-4000-8000-000000000002', 'member@example.test', 'authenticated', 'authenticated', '', '{}', '{}'),
  ('00000000-0000-4000-8000-000000000003', 'outsider@example.test', 'authenticated', 'authenticated', '', '{}', '{}'),
  ('00000000-0000-4000-8000-000000000004', 'admin@example.test', 'authenticated', 'authenticated', '', '{}', '{}');

insert into public.projects (id, owner_id, name)
values
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'Owner project'),
  ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003', 'Other project');

insert into public.project_members (project_id, user_id, role)
values
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 'member'),
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000004', 'admin');

insert into public.knowledge_sources (id, project_id, created_by, source_type, title, status)
values
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'text', 'A', 'ready'),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003', 'text', 'B', 'ready');

insert into public.knowledge_chunks (project_id, source_id, chunk_index, content, embedding)
values
  ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 0, 'allowed', array_prepend(1.0, array_fill(0.0, array[1535]))::extensions.vector),
  ('10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 0, 'forbidden', array_prepend(1.0, array_fill(0.0, array[1535]))::extensions.vector);

insert into public.conversations (id, project_id, user_id, title)
values
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'Owner private'),
  ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 'Member private');
insert into public.messages (conversation_id, project_id, role, content)
values
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'user', 'owner secret chat'),
  ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'user', 'member secret chat');

insert into public.subscriptions (user_id, stripe_subscription_id, plan, status)
values
  ('00000000-0000-4000-8000-000000000001', 'sub_owner', 'pro', 'active'),
  ('00000000-0000-4000-8000-000000000002', 'sub_member', 'starter', 'active');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000002', true);
select results_eq('select count(*) from public.projects', array[1::bigint], 'member sees only their project');
select results_eq('select count(*) from public.knowledge_sources', array[1::bigint], 'member sees project context');
select results_eq('select count(*) from public.conversations', array[1::bigint], 'member sees only their own conversation');
select results_eq('select count(*) from public.messages', array[1::bigint], 'member sees only their own messages');
select results_eq(
  $$select count(*) from public.messages where content = 'owner secret chat'$$,
  array[0::bigint],
  'member cannot read owner conversation messages'
);
select results_eq(
  $$with changed as (update public.projects set name = 'nope' where id = '10000000-0000-4000-8000-000000000001' returning 1) select count(*) from changed$$,
  array[0::bigint],
  'member cannot edit project settings'
);
select throws_ok(
  $$insert into public.messages (conversation_id, project_id, role, content) values ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'user', 'forged member message')$$,
  '42501',
  null,
  'member cannot write to another user conversation'
);
select throws_ok(
  $$insert into public.knowledge_chunks (project_id, source_id, chunk_index, content, embedding) values ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 1, 'forged', array_fill(0.0, array[1536])::extensions.vector)$$,
  '42501',
  null,
  'authenticated users cannot write chunks'
);
select results_eq('select count(*) from public.subscriptions', array[1::bigint], 'member sees only their subscription');

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000004', true);
select results_eq('select count(*) from public.conversations', array[2::bigint], 'admin can audit all project conversations');
select results_eq('select count(*) from public.messages', array[2::bigint], 'admin can audit all project messages');
select throws_ok(
  $$insert into public.messages (conversation_id, project_id, role, content) values ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'user', 'forged admin message')$$,
  '42501',
  null,
  'admin cannot write to another user conversation'
);

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000003', true);
select results_eq('select count(*) from public.projects where id = ''10000000-0000-4000-8000-000000000001''', array[0::bigint], 'cross-tenant project access is denied');
select results_eq('select count(*) from public.subscriptions', array[0::bigint], 'outsider cannot see another user subscription');

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
select results_eq('select count(*) from public.conversations', array[2::bigint], 'owner can audit all project conversations');
select results_eq('select count(*) from public.messages', array[2::bigint], 'owner can audit all project messages');
select results_eq('select count(*) from public.subscriptions', array[1::bigint], 'owner sees only their subscription');
select results_eq(
  $$select count(*) from public.match_project_chunks(array_prepend(1.0, array_fill(0.0, array[1535]))::extensions.vector, '10000000-0000-4000-8000-000000000001', 8, 0.2) where content = 'allowed'$$,
  array[1::bigint],
  'vector search returns the requested project chunk'
);
select results_eq(
  $$select count(*) from public.match_project_chunks(array_prepend(1.0, array_fill(0.0, array[1535]))::extensions.vector, '10000000-0000-4000-8000-000000000001', 8, 0.2) where content = 'forbidden'$$,
  array[0::bigint],
  'vector search cannot leak another project chunk'
);
reset role;

select throws_ok(
  $$update public.projects set owner_id = '00000000-0000-4000-8000-000000000002' where id = '10000000-0000-4000-8000-000000000001'$$,
  '42501',
  'project owner cannot be changed',
  'project owner is immutable'
);
select is(public.try_uuid('not-a-uuid'), null, 'invalid storage path UUIDs are rejected safely');

select * from finish();
rollback;
