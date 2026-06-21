create index knowledge_chunks_embedding_hnsw_idx
  on public.knowledge_chunks
  using hnsw (embedding extensions.vector_cosine_ops);

create or replace function public.match_project_chunks(
  query_embedding extensions.vector(1536),
  match_project_id uuid,
  match_count integer default 8,
  similarity_threshold double precision default 0.2
)
returns table (
  chunk_id uuid,
  source_id uuid,
  title text,
  content text,
  metadata jsonb,
  similarity double precision
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    kc.id as chunk_id,
    kc.source_id,
    ks.title,
    kc.content,
    kc.metadata,
    1 - (kc.embedding operator(extensions.<=>) query_embedding) as similarity
  from public.knowledge_chunks kc
  join public.knowledge_sources ks
    on ks.id = kc.source_id and ks.project_id = kc.project_id
  where kc.project_id = match_project_id
    and ks.status = 'ready'
    and public.is_project_member(match_project_id)
    and 1 - (kc.embedding operator(extensions.<=>) query_embedding) >= greatest(
      -1.0,
      least(1.0, similarity_threshold)
    )
  order by kc.embedding operator(extensions.<=>) query_embedding
  limit least(greatest(match_count, 1), 20);
$$;

revoke all on function public.match_project_chunks(
  extensions.vector, uuid, integer, double precision
) from public;
grant execute on function public.match_project_chunks(
  extensions.vector, uuid, integer, double precision
) to authenticated;

comment on table public.job_queue is
  'Synchronous v1 job ledger. TODO: add atomic claim/retry RPCs when moving ingestion to Cloudflare Queues or another worker.';
