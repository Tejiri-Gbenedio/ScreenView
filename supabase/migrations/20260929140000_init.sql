-- ScreenView — initial schema
-- Phases 2–8 consolidated: all tables + documented refinements
--   (R1 status states + note_change event, R2 operational columns, R3 perception,
--    R4 action vocabulary, A1 collections.kind, A2 memories.pa_state,
--    A3 pa_reports, P6 learned_patterns).
-- Forward-only. Nothing destructive.

create extension if not exists vector;

-- ============================================================ captures
create table if not exists public.captures (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users (id) on delete cascade,
  storage_path      text not null unique,               -- {user_id}/{capture_id}.{ext} in the private 'captures' bucket
  original_note     text,                               -- user's note, VERBATIM — never overwritten by AI
  source            text,
  mime_type         text not null default 'image/png',
  file_hash         text,                               -- sha-256, set at upload completion
  processing_status text not null default 'upload_pending'
                    check (processing_status in ('upload_pending','uploaded','processing','retrying','completed','failed')),
  attempt_count     int not null default 0,
  last_error        text,
  last_attempt_at   timestamptz,
  created_at        timestamptz not null default now()
);
create index if not exists captures_user_created_idx  on public.captures (user_id, created_at desc);
create index if not exists captures_user_filehash_idx on public.captures (user_id, file_hash);
create index if not exists captures_status_idx        on public.captures (processing_status);

-- ============================================================ memories
create table if not exists public.memories (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users (id) on delete cascade,
  capture_id         uuid not null unique references public.captures (id) on delete cascade,
  title              text not null,
  summary            text not null,
  visual_description text,
  perception         jsonb,                              -- raw vision analysis + model/provider provenance
  topic              text,
  current_intent     text check (current_intent in
                       ('buy','research','try','build','read','watch','save_for_later','compare','contact','inspiration','unknown')),
  intent_source      text check (intent_source in
                       ('user_statement','strong_context','user_behavior','visual_inference','ai_inference','unknown')),
  intent_confidence  real check (intent_confidence between 0 and 1),
  suggested_action   text check (suggested_action in
                       ('buy','evaluate','test','build','read','watch','compare','contact','save_for_reference','none')),
  status             text not null default 'new'
                     check (status in ('new','active','completed','dismissed','archived')),
  pa_state           jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists memories_user_status_idx  on public.memories (user_id, status);
create index if not exists memories_user_created_idx on public.memories (user_id, created_at desc);

-- ============================================================ memory_events (append-only)
create table if not exists public.memory_events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  memory_id   uuid not null references public.memories (id) on delete cascade,
  event_type  text not null check (event_type in
                ('intent_change','status_change','action_change','topic_change','note_change')),
  old_value   text,
  new_value   text not null,
  source      text not null check (source in
                ('user_statement','strong_context','user_behavior','visual_inference','ai_inference','system','unknown')),
  actor       text not null check (actor in ('user','system')),
  confidence  real,
  reason      text,
  detail      jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists memory_events_memory_idx on public.memory_events (memory_id, event_type, created_at desc);

-- ============================================================ connections
create table if not exists public.connections (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users (id) on delete cascade,
  source_memory_id  uuid not null references public.memories (id) on delete cascade,
  target_memory_id  uuid not null references public.memories (id) on delete cascade,
  relationship_type text not null check (relationship_type in
                      ('same_subject','complementary','thematic','user_linked')),
  state             text not null default 'suggested'
                    check (state in ('suggested','confirmed','dismissed')),
  origin            text not null default 'ai' check (origin in ('ai','user')),
  confidence        real,
  basis             jsonb,
  created_at        timestamptz not null default now(),
  unique (source_memory_id, target_memory_id, relationship_type),
  check (source_memory_id < target_memory_id)           -- canonical ordering keeps the graph undirected
);
create index if not exists connections_user_state_idx on public.connections (user_id, state);
create index if not exists connections_target_idx     on public.connections (target_memory_id);

-- ============================================================ collections
create table if not exists public.collections (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  name        text not null,
  description text,
  origin      text not null default 'ai_suggested' check (origin in ('ai_suggested','user_created')),
  state       text not null default 'suggested'
              check (state in ('suggested','accepted','dismissed','archived')),
  kind        text not null default 'collection' check (kind in ('collection','project')),
  basis       jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, name)
);

-- ============================================================ collection_members
create table if not exists public.collection_members (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  collection_id uuid not null references public.collections (id) on delete cascade,
  memory_id     uuid not null references public.memories (id) on delete cascade,
  state         text not null default 'suggested'
                check (state in ('suggested','confirmed','dismissed')),
  confidence    real,
  created_at    timestamptz not null default now(),
  unique (collection_id, memory_id)
);
create index if not exists collection_members_memory_idx on public.collection_members (memory_id);

-- ============================================================ memory_embeddings
-- Note: no HNSW index yet — pgvector ANN indexes cap at 2000 dims for `vector`;
-- exact KNN is fine at personal scale. A halfvec expression index can be added
-- in a later migration once the hosted pgvector version is confirmed.
create table if not exists public.memory_embeddings (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  memory_id   uuid not null references public.memories (id) on delete cascade,
  model       text not null,
  embedding   vector(2048) not null,
  input_hash  text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (memory_id, model)
);

-- ============================================================ pa_reports
create table if not exists public.pa_reports (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  generated_at    timestamptz not null default now(),
  period_start    timestamptz not null,
  period_end      timestamptz not null,
  is_empty        boolean not null default false,
  content         jsonb not null default '{}'::jsonb,
  generation_meta jsonb not null default '{}'::jsonb,
  seen_at         timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists pa_reports_user_generated_idx on public.pa_reports (user_id, generated_at desc);

-- ============================================================ learned_patterns
create table if not exists public.learned_patterns (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users (id) on delete cascade,
  scope                text not null check (scope in
                         ('intent','topic','action','connection','collection','pa','language')),
  origin               text not null check (origin in ('inferred','explicit')),
  status               text not null default 'tentative' check (status in
                         ('tentative','active','suppressed','expired','retired','superseded')),
  condition            jsonb not null,
  conclusion           jsonb not null,
  confidence           real not null default 0,
  half_life_days       int,
  evidence_count       int not null default 0,
  positive_count       int not null default 0,
  negative_count       int not null default 0,
  evidence             jsonb not null default '[]'::jsonb,
  last_reinforced_at   timestamptz,
  last_contradicted_at timestamptz,
  suppressed_until     timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists learned_patterns_user_scope_idx on public.learned_patterns (user_id, scope, status);

-- ============================================================ RLS (owner-only)
alter table public.captures            enable row level security;
alter table public.memories            enable row level security;
alter table public.memory_events       enable row level security;
alter table public.connections         enable row level security;
alter table public.collections         enable row level security;
alter table public.collection_members  enable row level security;
alter table public.memory_embeddings   enable row level security;
alter table public.pa_reports          enable row level security;
alter table public.learned_patterns    enable row level security;

drop policy if exists "captures_owner_all"           on public.captures;
create policy "captures_owner_all"           on public.captures           for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "memories_owner_all"           on public.memories;
create policy "memories_owner_all"           on public.memories           for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "memory_events_owner_all"      on public.memory_events;
create policy "memory_events_owner_all"      on public.memory_events      for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "connections_owner_all"        on public.connections;
create policy "connections_owner_all"        on public.connections        for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "collections_owner_all"        on public.collections;
create policy "collections_owner_all"        on public.collections        for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "collection_members_owner_all" on public.collection_members;
create policy "collection_members_owner_all" on public.collection_members for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "memory_embeddings_owner_all"  on public.memory_embeddings;
create policy "memory_embeddings_owner_all"  on public.memory_embeddings   for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "pa_reports_owner_all"         on public.pa_reports;
create policy "pa_reports_owner_all"         on public.pa_reports          for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "learned_patterns_owner_all"   on public.learned_patterns;
create policy "learned_patterns_owner_all"   on public.learned_patterns   for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================ grants
grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on
  public.captures, public.memories, public.memory_events, public.connections,
  public.collections, public.collection_members, public.memory_embeddings,
  public.pa_reports, public.learned_patterns
  to authenticated, service_role;

-- ============================================================ storage: captures bucket (private)
insert into storage.buckets (id, name, public) values ('captures', 'captures', false)
on conflict (id) do nothing;

drop policy if exists "captures_objects_select_own" on storage.objects;
create policy "captures_objects_select_own" on storage.objects for select to authenticated
  using (bucket_id = 'captures' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "captures_objects_insert_own" on storage.objects;
create policy "captures_objects_insert_own" on storage.objects for insert to authenticated
  with check (bucket_id = 'captures' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "captures_objects_update_own" on storage.objects;
create policy "captures_objects_update_own" on storage.objects for update to authenticated
  using (bucket_id = 'captures' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "captures_objects_delete_own" on storage.objects;
create policy "captures_objects_delete_own" on storage.objects for delete to authenticated
  using (bucket_id = 'captures' and (storage.foldername(name))[1] = auth.uid()::text);

-- ============================================================ functions

-- Claim a capture for processing (single-flight; safe to retry).
create or replace function public.claim_capture(p_capture_id uuid)
returns public.captures
language plpgsql
security invoker
as $$
declare
  c public.captures;
begin
  update public.captures
     set processing_status = 'processing',
         attempt_count     = attempt_count + 1,
         last_attempt_at   = now(),
         last_error        = null
   where id = p_capture_id
     and processing_status in ('uploaded','retrying')
   returning * into c;
  return c;
end $$;

-- Persist an interpretation: memory + initial events + capture completion (atomic, idempotent).
create or replace function public.persist_memory(
  p_capture_id        uuid,
  p_title             text,
  p_summary           text,
  p_visual_description text,
  p_perception        jsonb,
  p_topic             text,
  p_intent            text,
  p_intent_source     text,
  p_intent_confidence real,
  p_action            text,
  p_reason            text
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_memory_id uuid;
  v_user_id   uuid;
begin
  select user_id into v_user_id from public.captures where id = p_capture_id;
  if v_user_id is null then
    raise exception 'capture not found: %', p_capture_id;
  end if;

  insert into public.memories
    (user_id, capture_id, title, summary, visual_description, perception, topic,
     current_intent, intent_source, intent_confidence, suggested_action, status)
  values
    (v_user_id, p_capture_id, p_title, p_summary, p_visual_description, p_perception, p_topic,
     p_intent, p_intent_source, p_intent_confidence, p_action, 'new')
  on conflict (capture_id) do nothing
  returning id into v_memory_id;

  if v_memory_id is not null then
    insert into public.memory_events
      (user_id, memory_id, event_type, old_value, new_value, source, actor, confidence, reason, detail)
    values
      (v_user_id, v_memory_id, 'intent_change', null, p_intent, p_intent_source, 'system',
       p_intent_confidence, p_reason, '{"phase":"initial_interpretation"}'::jsonb);

    insert into public.memory_events
      (user_id, memory_id, event_type, old_value, new_value, source, actor, reason)
    values
      (v_user_id, v_memory_id, 'status_change', null, 'new', 'system', 'system', 'memory created');
  else
    select id into v_memory_id from public.memories where capture_id = p_capture_id;
  end if;

  update public.captures
     set processing_status = 'completed',
         last_attempt_at   = now(),
         last_error        = null
   where id = p_capture_id;

  return v_memory_id;
end $$;

-- Semantic KNN over the user's memories (called by jobs with service role, or by users via RLS).
create or replace function public.match_memories(
  p_user_id       uuid,
  query_embedding vector(2048),
  match_count     int default 10
) returns table (
  memory_id        uuid,
  title            text,
  topic            text,
  current_intent   text,
  suggested_action text,
  status           text,
  created_at       timestamptz,
  similarity       float
)
language sql
stable
security invoker
as $$
  select m.id, m.title, m.topic, m.current_intent, m.suggested_action, m.status, m.created_at,
         1 - (e.embedding <=> query_embedding) as similarity
  from public.memory_embeddings e
  join public.memories m on m.id = e.memory_id
  where e.user_id = p_user_id
  order by e.embedding <=> query_embedding
  limit match_count;
$$;

-- Apply a user correction: update current value + append an event (provenance preserved).
create or replace function public.apply_correction(
  p_memory_id uuid,
  p_field     text,
  p_value     text,
  p_reason    text default null
) returns public.memories
language plpgsql
security invoker
as $$
declare
  m     public.memories;
  v_old text;
begin
  select * into m from public.memories where id = p_memory_id;
  if m.id is null then
    raise exception 'memory not found';
  end if;
  if p_value is null or length(p_value) = 0 or length(p_value) > 200 then
    raise exception 'invalid value length';
  end if;

  if p_field = 'intent' then
    if p_value not in ('buy','research','try','build','read','watch','save_for_later','compare','contact','inspiration','unknown') then
      raise exception 'invalid intent: %', p_value;
    end if;
    v_old := m.current_intent;
    update public.memories
       set current_intent = p_value, intent_source = 'user_statement', intent_confidence = 1.0, updated_at = now()
     where id = p_memory_id returning * into m;
    insert into public.memory_events (user_id, memory_id, event_type, old_value, new_value, source, actor, confidence, reason)
    values (m.user_id, p_memory_id, 'intent_change', v_old, p_value, 'user_statement', 'user', 1.0, p_reason);

  elsif p_field = 'topic' then
    v_old := m.topic;
    update public.memories set topic = p_value, updated_at = now() where id = p_memory_id returning * into m;
    insert into public.memory_events (user_id, memory_id, event_type, old_value, new_value, source, actor, reason)
    values (m.user_id, p_memory_id, 'topic_change', v_old, p_value, 'user_statement', 'user', p_reason);

  elsif p_field = 'action' then
    if p_value not in ('buy','evaluate','test','build','read','watch','compare','contact','save_for_reference','none') then
      raise exception 'invalid action: %', p_value;
    end if;
    v_old := m.suggested_action;
    update public.memories set suggested_action = p_value, updated_at = now() where id = p_memory_id returning * into m;
    insert into public.memory_events (user_id, memory_id, event_type, old_value, new_value, source, actor, reason)
    values (m.user_id, p_memory_id, 'action_change', v_old, p_value, 'user_statement', 'user', p_reason);

  elsif p_field = 'status' then
    if p_value not in ('new','active','completed','dismissed','archived') then
      raise exception 'invalid status: %', p_value;
    end if;
    v_old := m.status;
    update public.memories set status = p_value, updated_at = now() where id = p_memory_id returning * into m;
    insert into public.memory_events (user_id, memory_id, event_type, old_value, new_value, source, actor, reason)
    values (m.user_id, p_memory_id, 'status_change', v_old, p_value, 'user_statement', 'user', p_reason);

  else
    raise exception 'unsupported field: %', p_field;
  end if;

  return m;
end $$;

-- ============================================================ function permissions
-- Job-only functions: service role only.
revoke all on function public.claim_capture(uuid) from public, anon, authenticated;
grant execute on function public.claim_capture(uuid) to service_role;

revoke all on function public.persist_memory(uuid, text, text, text, jsonb, text, text, text, real, text, text) from public, anon, authenticated;
grant execute on function public.persist_memory(uuid, text, text, text, jsonb, text, text, text, real, text, text) to service_role;

-- User-facing functions: authenticated + service role.
revoke all on function public.match_memories(uuid, vector, integer) from public, anon;
grant execute on function public.match_memories(uuid, vector, integer) to authenticated, service_role;

revoke all on function public.apply_correction(uuid, text, text, text) from public, anon;
grant execute on function public.apply_correction(uuid, text, text, text) to authenticated, service_role;
