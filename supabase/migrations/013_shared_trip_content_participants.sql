-- Travel Memo v2.1.26
-- Shared trip content and participant display stabilization.
-- Safe for Supabase SQL Editor. Does not touch storage.objects.

begin;

alter table public.trip_invites add column if not exists updated_at timestamptz default now();
alter table public.trip_invites add column if not exists created_at timestamptz default now();
alter table public.trip_invites add column if not exists accepted_at timestamptz;
alter table public.trip_invites add column if not exists role text default 'viewer';
alter table public.trip_members add column if not exists email text;
alter table public.trip_members add column if not exists role text not null default 'viewer';
alter table public.trip_members add column if not exists status text not null default 'accepted';
alter table public.trip_members add column if not exists invited_by uuid;
alter table public.trip_members add column if not exists accepted_at timestamptz;
alter table public.trip_members add column if not exists updated_at timestamptz default now();

create or replace function public.current_user_email()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select lower(coalesce((select email from auth.users where id = auth.uid()), ''));
$$;

create or replace function public.is_trip_owner(p_trip_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.trips t
    where t.id = p_trip_id
      and t.user_id = auth.uid()
      and coalesce(t.deleted_at, null) is null
  );
$$;

create or replace function public.is_trip_member(p_trip_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.trip_members tm
    where tm.trip_id = p_trip_id
      and lower(coalesce(tm.status, 'accepted')) = 'accepted'
      and (
        tm.user_id = auth.uid()
        or lower(coalesce(tm.email, '')) = public.current_user_email()
      )
  ) or exists (
    select 1 from public.trip_invites ti
    where ti.trip_id = p_trip_id
      and lower(coalesce(ti.status, '')) = 'accepted'
      and lower(coalesce(ti.invited_email, '')) = public.current_user_email()
      and (ti.expires_at is null or ti.expires_at > now())
  );
$$;

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
        t.user_id = auth.uid()
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
        m.user_id = auth.uid()
        or public.is_admin()
        or (m.trip_id is not null and public.can_access_trip(m.trip_id))
      )
  );
$$;

create or replace function public.can_access_photo(p_photo_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.photos p
    where p.id = p_photo_id
      and p.deleted_at is null
      and (
        p.user_id = auth.uid()
        or public.is_admin()
        or (p.trip_id is not null and public.can_access_trip(p.trip_id))
        or (p.memo_id is not null and public.can_access_memo(p.memo_id))
      )
  );
$$;

-- Refresh read policies for joined/shared trips.
drop policy if exists "tm_v2126_trips_select_accessible" on public.trips;
create policy "tm_v2126_trips_select_accessible" on public.trips
for select to authenticated
using (public.can_access_trip(id));

drop policy if exists "tm_v2126_memos_select_accessible" on public.memos;
create policy "tm_v2126_memos_select_accessible" on public.memos
for select to authenticated
using (user_id = auth.uid() or public.is_admin() or (trip_id is not null and public.can_access_trip(trip_id)));

drop policy if exists "tm_v2126_photos_select_accessible" on public.photos;
create policy "tm_v2126_photos_select_accessible" on public.photos
for select to authenticated
using (user_id = auth.uid() or public.is_admin() or (trip_id is not null and public.can_access_trip(trip_id)) or (memo_id is not null and public.can_access_memo(memo_id)));

-- Keep owner write policies stable for offline queue.
drop policy if exists "tm_v2126_memos_insert_owner" on public.memos;
create policy "tm_v2126_memos_insert_owner" on public.memos
for insert to authenticated
with check (user_id = auth.uid() or public.is_admin());

drop policy if exists "tm_v2126_memos_update_owner" on public.memos;
create policy "tm_v2126_memos_update_owner" on public.memos
for update to authenticated
using (user_id = auth.uid() or public.is_admin())
with check (user_id = auth.uid() or public.is_admin());

drop policy if exists "tm_v2126_photos_insert_owner" on public.photos;
create policy "tm_v2126_photos_insert_owner" on public.photos
for insert to authenticated
with check (user_id = auth.uid() or public.is_admin());

drop policy if exists "tm_v2126_photos_update_owner" on public.photos;
create policy "tm_v2126_photos_update_owner" on public.photos
for update to authenticated
using (user_id = auth.uid() or public.is_admin())
with check (user_id = auth.uid() or public.is_admin());

-- Security definer bundle so joined members can pull the Trip, Memo, Photo and participant profiles in one call.
create or replace function public.get_trip_shared_bundle(p_trip_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trip jsonb;
  v_memos jsonb := '[]'::jsonb;
  v_photos jsonb := '[]'::jsonb;
  v_invites jsonb := '[]'::jsonb;
  v_profiles jsonb := '[]'::jsonb;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if not public.can_access_trip(p_trip_id) then
    raise exception 'trip not found or not allowed';
  end if;

  select to_jsonb(t) into v_trip
  from public.trips t
  where t.id = p_trip_id and t.deleted_at is null
  limit 1;

  select coalesce(jsonb_agg(to_jsonb(m) order by m.visited_at desc nulls last, m.created_at desc nulls last), '[]'::jsonb)
  into v_memos
  from public.memos m
  where m.trip_id = p_trip_id and m.deleted_at is null and coalesce(m.is_visible, true) = true;

  select coalesce(jsonb_agg(to_jsonb(p) order by p.created_at desc nulls last), '[]'::jsonb)
  into v_photos
  from public.photos p
  where p.deleted_at is null
    and (
      p.trip_id = p_trip_id
      or exists (select 1 from public.memos m where m.id = p.memo_id and m.trip_id = p_trip_id and m.deleted_at is null)
    );

  select coalesce(jsonb_agg(to_jsonb(ti) order by ti.updated_at desc nulls last, ti.created_at desc nulls last), '[]'::jsonb)
  into v_invites
  from public.trip_invites ti
  where ti.trip_id = p_trip_id
    and lower(coalesce(ti.status, '')) not in ('revoked','declined');

  with people as (
    select t.user_id as id, null::text as email from public.trips t where t.id = p_trip_id
    union
    select m.user_id, null::text from public.memos m where m.trip_id = p_trip_id and m.deleted_at is null
    union
    select p.user_id, null::text from public.photos p where p.trip_id = p_trip_id and p.deleted_at is null
    union
    select tm.user_id, lower(tm.email) from public.trip_members tm where tm.trip_id = p_trip_id and lower(coalesce(tm.status,'accepted')) = 'accepted'
    union
    select ti.owner_id, lower(ti.invited_email) from public.trip_invites ti where ti.trip_id = p_trip_id and lower(coalesce(ti.status,'')) not in ('revoked','declined')
  )
  select coalesce(jsonb_agg(distinct to_jsonb(pr)), '[]'::jsonb)
  into v_profiles
  from public.profiles pr
  where pr.id in (select id from people where id is not null)
     or lower(coalesce(pr.email, '')) in (select email from people where email is not null);

  return jsonb_build_object(
    'trip', v_trip,
    'memos', v_memos,
    'photos', v_photos,
    'invites', v_invites,
    'profiles', v_profiles
  );
end;
$$;

grant execute on function public.get_trip_shared_bundle(uuid) to authenticated;
grant execute on function public.can_access_trip(uuid) to authenticated;
grant execute on function public.can_access_memo(uuid) to authenticated;
grant execute on function public.can_access_photo(uuid) to authenticated;

commit;
