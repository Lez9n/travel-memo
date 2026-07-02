-- Travel Memo v2.1.7: detail ownership, view counters, invite avatars, admin visibility toggles
-- Safe to run after 005_priority1_auth_rls_rewrite.sql.

begin;

alter table public.trips add column if not exists is_visible boolean not null default true;
alter table public.trips add column if not exists view_count bigint not null default 0;
alter table public.trips add column if not exists last_viewed_at timestamptz;

alter table public.memos add column if not exists is_visible boolean not null default true;
alter table public.memos add column if not exists view_count bigint not null default 0;
alter table public.memos add column if not exists last_viewed_at timestamptz;

create index if not exists trips_is_visible_idx on public.trips(is_visible);
create index if not exists memos_is_visible_idx on public.memos(is_visible);
create index if not exists trips_view_count_idx on public.trips(view_count desc);
create index if not exists memos_view_count_idx on public.memos(view_count desc);

create or replace function public.can_access_trip(p_trip_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.trips t
    where t.id = p_trip_id
      and t.deleted_at is null
      and (
        coalesce(t.is_visible, true) = true
        or t.user_id = (select auth.uid())
        or public.is_admin()
      )
      and (
        t.user_id = (select auth.uid())
        or public.is_admin()
        or public.is_trip_member(p_trip_id)
      )
  );
$$;

create or replace function public.can_access_memo(p_memo_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.memos m
    where m.id = p_memo_id
      and m.deleted_at is null
      and (
        coalesce(m.is_visible, true) = true
        or m.user_id = (select auth.uid())
        or public.is_admin()
      )
      and (
        m.user_id = (select auth.uid())
        or public.is_admin()
        or (m.trip_id is not null and public.can_access_trip(m.trip_id))
      )
  );
$$;

create or replace function public.can_view_profile(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_profile_id = (select auth.uid())
    or public.is_admin()
    or exists (
      select 1 from public.trips t
      where t.user_id = p_profile_id
        and public.can_access_trip(t.id)
    )
    or exists (
      select 1 from public.memos m
      where m.user_id = p_profile_id
        and public.can_access_memo(m.id)
    );
$$;

create or replace function public.increment_trip_view(p_trip_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  new_count bigint;
begin
  if not public.can_access_trip(p_trip_id) then
    raise exception 'not allowed';
  end if;
  update public.trips
  set view_count = coalesce(view_count, 0) + 1,
      last_viewed_at = now()
  where id = p_trip_id
  returning view_count into new_count;
  return coalesce(new_count, 0);
end;
$$;

create or replace function public.increment_memo_view(p_memo_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  new_count bigint;
begin
  if not public.can_access_memo(p_memo_id) then
    raise exception 'not allowed';
  end if;
  update public.memos
  set view_count = coalesce(view_count, 0) + 1,
      last_viewed_at = now()
  where id = p_memo_id
  returning view_count into new_count;
  return coalesce(new_count, 0);
end;
$$;

-- Tighten memo select to use can_access_memo so admin visibility is respected for shared content.
drop policy if exists "memos_select_accessible" on public.memos;
create policy "memos_select_accessible" on public.memos
  for select to authenticated
  using (public.can_access_memo(id));

-- Let accessible creators' profile names/photos show in cards and detail panels.
drop policy if exists "profiles_select_own_or_admin" on public.profiles;
drop policy if exists "profiles_select_own_or_admin_or_shared" on public.profiles;
create policy "profiles_select_own_or_admin_or_shared" on public.profiles
  for select to authenticated
  using (public.can_view_profile(id));

commit;
