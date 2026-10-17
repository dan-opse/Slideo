-- Slideo schema version 2: TikTok inbox delivery.
--
-- Run it after 20261014013833_slideo_api.sql, the same way (SQL Editor → New
-- query → paste → Run, or `supabase db push`). Like that file, it is safe to
-- run again and never changes data. The local studio applies both files to
-- its embedded database, in filename order.
--
-- Connected TikTok accounts, their sealed tokens and deliveries are ordinary
-- entities rows (kinds tiktok_account, tiktok_token and delivery), so this
-- adds no tables: only the worker's query, an index for it, and the new lists
-- in the studio snapshot.

-- The version of these files the app expects (src/lib/db.ts SCHEMA_VERSION).
create or replace function public.slideo_schema_version() returns integer
language sql immutable set search_path = '' as $$ select 2 $$;

-- Deliveries the worker should look at by p_now, oldest first, across every
-- account: the one function not scoped to a single account. The app writes
-- nextAt with toISOString(), so comparing the text compares the times.
create or replace function public.slideo_due_deliveries(p_now text, p_limit integer)
returns json language sql stable set search_path = '' as $$
  select coalesce(
    json_agg(json_build_object('user_id', d.user_id, 'id', d.id) order by d.next_at),
    '[]'::json)
  from (
    select e.user_id, e.id, e.json::jsonb ->> 'nextAt' as next_at
    from public.entities e
    where e.kind = 'delivery'
      and (e.json::jsonb ->> 'nextAt') is not null
      and (e.json::jsonb ->> 'nextAt') <= p_now
    order by e.json::jsonb ->> 'nextAt'
    limit greatest(1, least(p_limit, 200))
  ) d
$$;

create index if not exists entities_delivery_next_at
  on public.entities ((json::jsonb ->> 'nextAt'))
  where kind = 'delivery';

-- Everything the studio shows, read in one snapshot. Sealed TikTok tokens
-- (kind tiktok_token) are never part of it.
create or replace function public.slideo_state(p_user text, p_since text) returns json
language sql stable set search_path = '' as $$
  select json_build_object(
    'brands', public.slideo_list(p_user, 'brand'),
    'formats', public.slideo_list(p_user, 'format'),
    'posts', public.slideo_list(p_user, 'post'),
    'assets', public.slideo_list(p_user, 'asset'),
    'deliveries', public.slideo_list(p_user, 'delivery'),
    'tiktokAccounts', public.slideo_list(p_user, 'tiktok_account'),
    'usedToday', public.slideo_ai_usage(p_user, p_since))
$$;

-- Privileges, as in the first file: only the server's secret key may call
-- these. Replacing a function keeps its grants; they are restated here so
-- this file stands on its own.
revoke all on function public.slideo_schema_version() from public;
revoke all on function public.slideo_due_deliveries(text, integer) from public;
revoke all on function public.slideo_state(text, text) from public;

do $$
begin
  -- Supabase's API roles. The embedded local database has none of them.
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    return;
  end if;
  revoke all on function public.slideo_schema_version(),
    public.slideo_due_deliveries(text, integer), public.slideo_state(text, text)
    from anon, authenticated;
  grant execute on function public.slideo_schema_version(),
    public.slideo_due_deliveries(text, integer), public.slideo_state(text, text)
    to service_role;
end $$;
