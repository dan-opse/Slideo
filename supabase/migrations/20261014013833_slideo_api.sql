-- Slideo: tables, rules and Data API functions for the hosted studio.
--
-- Run this once in the Supabase dashboard (SQL Editor → New query → paste →
-- Run), or with `supabase db push`. It is safe to run again: it creates what
-- is missing, replaces the functions and triggers, and never drops or
-- rewrites data. The local studio applies the same file to its embedded
-- database, minus the Supabase-only grants and buckets.
--
-- The app reaches these tables only through the slideo_* functions below,
-- and only with the server's secret key (the service_role). Signed-in
-- browsers (authenticated) and visitors (anon) get no table or function
-- privileges at all, and row level security with no policies backs that up.

create table if not exists public.entities(
  user_id text not null,
  kind text not null,
  id text not null,
  json text not null,
  seq bigserial,
  primary key(user_id, kind, id)
);
create table if not exists public.revisions(
  user_id text not null,
  post_id text not null,
  revision integer not null,
  json text not null,
  hash text not null,
  primary key(user_id, post_id, revision)
);
create table if not exists public.approvals(
  user_id text not null,
  post_id text not null,
  revision integer not null,
  hash text not null,
  render_hashes text not null,
  created_at text not null,
  primary key(user_id, post_id)
);
create table if not exists public.audit(
  id text primary key,
  user_id text not null,
  action text not null,
  entity text not null,
  at text not null
);
create table if not exists public.ai_attempts(
  id text primary key,
  user_id text not null,
  at text not null,
  status text not null,
  usage text
);
-- One row per account. Every committed change raises its version, so a
-- change prepared from older reads is refused and prepared again.
create table if not exists public.accounts(
  user_id text primary key,
  version bigint not null default 0
);
create index if not exists ai_attempts_user_at on public.ai_attempts(user_id, at);
create index if not exists audit_user on public.audit(user_id);

alter table public.entities enable row level security;
alter table public.revisions enable row level security;
alter table public.approvals enable row level security;
alter table public.audit enable row level security;
alter table public.ai_attempts enable row level security;
alter table public.accounts enable row level security;

-- Rules that hold for every writer, including the server.

-- Revisions and the audit trail are history: rows are added, never changed.
create or replace function public.slideo_append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'slideo: % rows cannot be changed or deleted', tg_table_name
    using errcode = 'SL409';
end $$;

-- A row never moves to another account.
create or replace function public.slideo_same_owner() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.user_id is distinct from old.user_id then
    raise exception 'slideo: rows cannot change account' using errcode = 'SL403';
  end if;
  return new;
end $$;

-- A published slideshow keeps its content and publication date; only its
-- link (a deliberate correction) and recorded results may change.
create or replace function public.slideo_published_post() returns trigger
language plpgsql set search_path = '' as $$
declare
  fixed text[] := array['publishedUrl', 'metrics', 'metricsHistory'];
begin
  if old.kind <> 'post' or (old.json::jsonb ->> 'status') is distinct from 'published' then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE'
    or new.kind <> old.kind or new.id <> old.id
    or (new.json::jsonb ->> 'status') is distinct from 'published'
    or (new.json::jsonb - fixed) <> (old.json::jsonb - fixed) then
    raise exception 'slideo: published slideshows cannot be changed'
      using errcode = 'SL409';
  end if;
  return new;
end $$;

-- A revision's hash is the SHA-256 of its stored content.
create or replace function public.slideo_revision_hash() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.revision < 1
    or new.hash <> encode(sha256(convert_to(new.json, 'UTF8')), 'hex') then
    raise exception 'slideo: revision % of % does not match its hash',
      new.revision, new.post_id using errcode = 'SL400';
  end if;
  return new;
end $$;

-- An approval names a revision that exists.
create or replace function public.slideo_approval_revision() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not exists (
    select 1 from public.revisions r
    where r.user_id = new.user_id and r.post_id = new.post_id
      and r.revision = new.revision
  ) then
    raise exception 'slideo: approval names a missing revision'
      using errcode = 'SL409';
  end if;
  return new;
end $$;

drop trigger if exists slideo_append_only on public.revisions;
create trigger slideo_append_only before update or delete on public.revisions
  for each row execute function public.slideo_append_only();
drop trigger if exists slideo_append_only on public.audit;
create trigger slideo_append_only before update or delete on public.audit
  for each row execute function public.slideo_append_only();
drop trigger if exists slideo_revision_hash on public.revisions;
create trigger slideo_revision_hash before insert on public.revisions
  for each row execute function public.slideo_revision_hash();
drop trigger if exists slideo_same_owner on public.entities;
create trigger slideo_same_owner before update on public.entities
  for each row execute function public.slideo_same_owner();
drop trigger if exists slideo_same_owner on public.approvals;
create trigger slideo_same_owner before update on public.approvals
  for each row execute function public.slideo_same_owner();
drop trigger if exists slideo_same_owner on public.ai_attempts;
create trigger slideo_same_owner before update on public.ai_attempts
  for each row execute function public.slideo_same_owner();
drop trigger if exists slideo_same_owner on public.accounts;
create trigger slideo_same_owner before update on public.accounts
  for each row execute function public.slideo_same_owner();
drop trigger if exists slideo_published_post on public.entities;
create trigger slideo_published_post before update or delete on public.entities
  for each row execute function public.slideo_published_post();
drop trigger if exists slideo_approval_revision on public.approvals;
create trigger slideo_approval_revision before insert or update on public.approvals
  for each row execute function public.slideo_approval_revision();

-- The Data API surface. Every function takes the account explicitly: the
-- server passes the id of the session it verified.

-- The version of this file the app expects (src/lib/db.ts SCHEMA_VERSION).
create or replace function public.slideo_schema_version() returns integer
language sql immutable set search_path = '' as $$ select 1 $$;

create or replace function public.slideo_version(p_user text) returns bigint
language sql stable set search_path = '' as $$
  select coalesce(
    (select a.version from public.accounts a where a.user_id = p_user), 0)
$$;

-- Newest first, the order the studio lists them in.
create or replace function public.slideo_list(p_user text, p_kind text) returns json
language sql stable set search_path = '' as $$
  select coalesce(json_agg(e.json::json order by e.seq desc), '[]'::json)
  from public.entities e
  where e.user_id = p_user and e.kind = p_kind
$$;

create or replace function public.slideo_get(p_user text, p_kind text, p_id text) returns json
language sql stable set search_path = '' as $$
  select e.json::json from public.entities e
  where e.user_id = p_user and e.kind = p_kind and e.id = p_id
$$;

-- Several records at once, named as [[kind, id], …]. Missing ones are left out.
create or replace function public.slideo_find(p_user text, p_keys jsonb) returns json
language sql stable set search_path = '' as $$
  select coalesce(
    json_agg(json_build_object('kind', e.kind, 'id', e.id, 'json', e.json::json)),
    '[]'::json)
  from public.entities e
  join jsonb_array_elements(p_keys) k
    on e.kind = k ->> 0 and e.id = k ->> 1
  where e.user_id = p_user
$$;

create or replace function public.slideo_revision(p_user text, p_post text, p_revision integer)
returns json
language sql stable set search_path = '' as $$
  select r.json::json from public.revisions r
  where r.user_id = p_user and r.post_id = p_post and r.revision = p_revision
$$;

create or replace function public.slideo_approval(p_user text, p_post text) returns json
language sql stable set search_path = '' as $$
  select json_build_object(
    'revision', a.revision, 'hash', a.hash, 'render_hashes', a.render_hashes)
  from public.approvals a
  where a.user_id = p_user and a.post_id = p_post
$$;

-- Whether any revision uses an image; revisions keep the files they use.
create or replace function public.slideo_asset_in_use(p_user text, p_asset text) returns boolean
language sql stable set search_path = '' as $$
  select exists (
    select 1 from public.revisions r
    where r.user_id = p_user and strpos(r.json, to_json(p_asset)::text) > 0)
$$;

create or replace function public.slideo_ai_usage(p_user text, p_since text) returns integer
language sql stable set search_path = '' as $$
  select count(*)::integer from public.ai_attempts a
  where a.user_id = p_user and a.at >= p_since
$$;

-- Everything the studio shows, read in one snapshot.
create or replace function public.slideo_state(p_user text, p_since text) returns json
language sql stable set search_path = '' as $$
  select json_build_object(
    'brands', public.slideo_list(p_user, 'brand'),
    'formats', public.slideo_list(p_user, 'format'),
    'posts', public.slideo_list(p_user, 'post'),
    'assets', public.slideo_list(p_user, 'asset'),
    'usedToday', public.slideo_ai_usage(p_user, p_since))
$$;

-- Applies one account's changes together, or none of them. The server reads
-- what it needs, decides the changes, then commits them here naming the
-- account version it read at. If another change committed in between, this
-- returns ok=false and changes nothing; the server reads again and retries.
-- p_expected null writes without that check (independent appends, such as
-- an audit entry recorded after a download).
--
-- Each change is one of:
--   {op:"put", kind, id, json}           add or replace a record
--   {op:"delete", kind, id}              delete a record
--   {op:"revision", post, revision, json, hash}
--   {op:"approve", post, revision, hash, render_hashes, at}
--   {op:"unapprove", post}
--   {op:"audit", id, action, entity, at}
--   {op:"ai", id, at, status, usage?}    record an AI attempt (added once)
--   {op:"ai_update", id, status, usage}
create or replace function public.slideo_commit(p_user text, p_expected bigint, p_changes jsonb)
returns json
language plpgsql set search_path = '' as $$
declare
  v_version bigint;
  c jsonb;
begin
  if p_user is null or p_user !~ '^[A-Za-z0-9_-]{1,64}$' then
    raise exception 'slideo: invalid account' using errcode = 'SL400';
  end if;
  if jsonb_typeof(p_changes) is distinct from 'array' then
    raise exception 'slideo: changes must be a list' using errcode = 'SL400';
  end if;
  if jsonb_array_length(p_changes) > 20000 then
    raise exception 'slideo: too many changes at once' using errcode = 'SL413';
  end if;

  insert into public.accounts(user_id) values (p_user)
    on conflict (user_id) do nothing;
  -- Changes for one account wait here for each other, in commit order.
  select a.version into v_version from public.accounts a
    where a.user_id = p_user for update;
  if p_expected is not null and p_expected <> v_version then
    return json_build_object('ok', false, 'version', v_version);
  end if;

  for c in select value from jsonb_array_elements(p_changes) loop
    case c ->> 'op'
    when 'put' then
      if coalesce(c ->> 'kind', '') !~ '^[a-z_]{1,32}$'
        or ((c ->> 'json')::jsonb ->> 'id') is distinct from (c ->> 'id') then
        raise exception 'slideo: invalid record' using errcode = 'SL400';
      end if;
      insert into public.entities(user_id, kind, id, json)
      values (p_user, c ->> 'kind', c ->> 'id', c ->> 'json')
      on conflict (user_id, kind, id) do update set json = excluded.json;
    when 'delete' then
      delete from public.entities e
      where e.user_id = p_user and e.kind = c ->> 'kind' and e.id = c ->> 'id';
    when 'revision' then
      insert into public.revisions(user_id, post_id, revision, json, hash)
      values (p_user, c ->> 'post', (c ->> 'revision')::integer,
              c ->> 'json', c ->> 'hash');
    when 'approve' then
      insert into public.approvals(user_id, post_id, revision, hash, render_hashes, created_at)
      values (p_user, c ->> 'post', (c ->> 'revision')::integer, c ->> 'hash',
              c ->> 'render_hashes', c ->> 'at')
      on conflict (user_id, post_id) do update set
        revision = excluded.revision, hash = excluded.hash,
        render_hashes = excluded.render_hashes, created_at = excluded.created_at;
    when 'unapprove' then
      delete from public.approvals a
      where a.user_id = p_user and a.post_id = c ->> 'post';
    when 'audit' then
      insert into public.audit(id, user_id, action, entity, at)
      values (c ->> 'id', p_user, c ->> 'action', c ->> 'entity', c ->> 'at')
      on conflict (id) do nothing;
    when 'ai' then
      insert into public.ai_attempts(id, user_id, at, status, usage)
      values (c ->> 'id', p_user, c ->> 'at', c ->> 'status', c ->> 'usage')
      on conflict (id) do nothing;
    when 'ai_update' then
      update public.ai_attempts a set status = c ->> 'status', usage = c ->> 'usage'
      where a.id = c ->> 'id' and a.user_id = p_user;
    else
      raise exception 'slideo: unknown change %', c ->> 'op' using errcode = 'SL400';
    end case;
  end loop;

  update public.accounts a set version = v_version + 1 where a.user_id = p_user;
  return json_build_object('ok', true, 'version', v_version + 1);
end $$;

-- Privileges. Functions are executable by everyone unless revoked.
revoke all on function public.slideo_schema_version() from public;
revoke all on function public.slideo_version(text) from public;
revoke all on function public.slideo_list(text, text) from public;
revoke all on function public.slideo_get(text, text, text) from public;
revoke all on function public.slideo_find(text, jsonb) from public;
revoke all on function public.slideo_revision(text, text, integer) from public;
revoke all on function public.slideo_approval(text, text) from public;
revoke all on function public.slideo_asset_in_use(text, text) from public;
revoke all on function public.slideo_ai_usage(text, text) from public;
revoke all on function public.slideo_state(text, text) from public;
revoke all on function public.slideo_commit(text, bigint, jsonb) from public;

do $$
begin
  -- Supabase's API roles. The embedded local database has none of them.
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    return;
  end if;
  revoke all on table public.entities, public.revisions, public.approvals,
    public.audit, public.ai_attempts, public.accounts from anon, authenticated;
  revoke all on sequence public.entities_seq_seq from anon, authenticated;
  revoke all on function public.slideo_schema_version(), public.slideo_version(text),
    public.slideo_list(text, text), public.slideo_get(text, text, text),
    public.slideo_find(text, jsonb), public.slideo_revision(text, text, integer),
    public.slideo_approval(text, text), public.slideo_asset_in_use(text, text),
    public.slideo_ai_usage(text, text), public.slideo_state(text, text),
    public.slideo_commit(text, bigint, jsonb)
    from anon, authenticated;
  revoke all on function public.slideo_append_only(), public.slideo_same_owner(),
    public.slideo_published_post(), public.slideo_revision_hash(),
    public.slideo_approval_revision()
    from public, anon, authenticated, service_role;

  -- The server (secret key) runs the functions as itself, so it needs the
  -- tables; the triggers above still apply to it.
  grant select, insert, update, delete on table public.entities, public.revisions,
    public.approvals, public.audit, public.ai_attempts, public.accounts to service_role;
  grant usage, select on sequence public.entities_seq_seq to service_role;
  grant execute on function public.slideo_schema_version(), public.slideo_version(text),
    public.slideo_list(text, text), public.slideo_get(text, text, text),
    public.slideo_find(text, jsonb), public.slideo_revision(text, text, integer),
    public.slideo_approval(text, text), public.slideo_asset_in_use(text, text),
    public.slideo_ai_usage(text, text), public.slideo_state(text, text),
    public.slideo_commit(text, bigint, jsonb)
    to service_role;
end $$;

-- Private storage: images (uploads, library, rendered slides) up to 20 MB,
-- and approved ZIP packages up to 50 MB (the free plan's largest file).
-- No storage policies are added, so browsers can neither list, read nor
-- write these buckets with their own session: they use short-lived signed
-- links the server issues for one file each.
do $$
begin
  if to_regclass('storage.buckets') is null then
    return;
  end if;
  insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
  values
    ('studio', 'studio', false, 20971520,
      array['image/jpeg', 'image/png', 'image/webp']),
    ('studio-exports', 'studio-exports', false, 52428800,
      array['application/zip'])
  on conflict (id) do update set
    public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;
end $$;
