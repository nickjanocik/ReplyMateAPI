insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'project-files',
  'project-files',
  false,
  10485760,
  array['text/plain', 'text/markdown', 'text/x-markdown']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.try_uuid(value text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
begin
  return value::uuid;
exception when invalid_text_representation then
  return null;
end;
$$;

revoke all on function public.try_uuid(text) from public;
grant execute on function public.try_uuid(text) to authenticated;

create policy project_files_select_member
on storage.objects for select to authenticated
using (
  bucket_id = 'project-files'
  and public.is_project_member(public.try_uuid((storage.foldername(name))[1]))
);

create policy project_files_insert_member
on storage.objects for insert to authenticated
with check (
  bucket_id = 'project-files'
  and public.is_project_member(public.try_uuid((storage.foldername(name))[1]))
  and exists (
    select 1
    from public.knowledge_sources ks
    where ks.id = public.try_uuid((storage.foldername(name))[2])
      and ks.project_id = public.try_uuid((storage.foldername(name))[1])
      and ks.created_by = (select auth.uid())
      and ks.source_type = 'file'
      and ks.status in ('pending', 'processing')
  )
);

create policy project_files_delete_admin
on storage.objects for delete to authenticated
using (
  bucket_id = 'project-files'
  and public.is_project_admin(public.try_uuid((storage.foldername(name))[1]))
);

