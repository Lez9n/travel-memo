-- Travel Memo v2.1.3 PRIORITY 1: Auth Guard + RLS rewrite
-- Safe to run multiple times after 001_initial_schema.sql.
-- This migration removes older recursive policies and replaces them with security-definer helpers.

begin;

create extension if not exists pgcrypto;

alter table public.trips add column if not exists visibility text not null default 'private';
alter table public.memos add column if not exists visibility text not null default 'private';

update public.trips set visibility = case when is_public then 'public' else visibility end where visibility is null or visibility = '';
update public.memos set visibility = case when is_public then 'public' else visibility end where visibility is null or visibility = '';

alter table public.trips drop constraint if exists trips_visibility_check;
alter table public.trips add constraint trips_visibility_check check (visibility in ('private', 'shared', 'public'));
alter table public.memos drop constraint if exists memos_visibility_check;
alter table public.memos add constraint memos_visibility_check check (visibility in ('private', 'shared', 'public'));

create table if not exists public.trip_members (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  email text not null,
  role text not null default 'viewer',
  status text not null default 'accepted',
  invited_by uuid references auth.users(id) on delete set null,
  invited_at timestamptz not null default now(),
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (trip_id, email)
);

create table if not exists public.trip_invites (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  invited_email text not null,
  role text not null default 'viewer',
  status text not null default 'accepted',
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (trip_id, invited_email)
);

alter table public.trip_members add column if not exists email text;
alter table public.trip_members add column if not exists role text not null default 'viewer';
alter table public.trip_members add column if not exists status text not null default 'accepted';
alter table public.trip_members add column if not exists invited_by uuid references auth.users(id) on delete set null;
alter table public.trip_members add column if not exists accepted_at timestamptz;
alter table public.trip_invites add column if not exists expires_at timestamptz;

create index if not exists trips_visibility_idx on public.trips(visibility);
create index if not exists memos_visibility_idx on public.memos(visibility);
create index if not exists trip_members_trip_idx on public.trip_members(trip_id);
create index if not exists trip_members_user_idx on public.trip_members(user_id);
create index if not exists trip_members_email_idx on public.trip_members(lower(email));
create index if not exists trip_invites_trip_idx on public.trip_invites(trip_id);
create index if not exists trip_invites_email_idx on public.trip_invites(lower(invited_email));
create index if not exists trip_invites_owner_idx on public.trip_invites(owner_id);

alter table public.profiles enable row level security;
alter table public.trips enable row level security;
alter table public.memos enable row level security;
alter table public.photos enable row level security;
alter table public.sync_events enable row level security;
alter table public.trip_members enable row level security;
alter table public.trip_invites enable row level security;

create or replace function public.current_user_email()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select lower(email) from auth.users where id = (select auth.uid());
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid())
      and p.role = 'admin'
  );
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
      and t.user_id = (select auth.uid())
      and t.deleted_at is null
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
      and tm.status = 'accepted'
      and (
        tm.user_id = (select auth.uid())
        or lower(tm.email) = public.current_user_email()
      )
  )
  or exists (
    select 1 from public.trip_invites ti
    where ti.trip_id = p_trip_id
      and ti.status = 'accepted'
      and lower(ti.invited_email) = public.current_user_email()
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
        t.user_id = (select auth.uid())
        or public.is_admin()
        or public.is_trip_member(p_trip_id)
      )
  );
$$;

create or replace function public.can_edit_trip(p_trip_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin()
    or exists (
      select 1 from public.trips t
      where t.id = p_trip_id
        and t.user_id = (select auth.uid())
        and t.deleted_at is null
    )
    or exists (
      select 1 from public.trip_members tm
      where tm.trip_id = p_trip_id
        and tm.status = 'accepted'
        and tm.role = 'editor'
        and (tm.user_id = (select auth.uid()) or lower(tm.email) = public.current_user_email())
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
        m.user_id = (select auth.uid())
        or public.is_admin()
        or (m.trip_id is not null and public.can_access_trip(m.trip_id))
      )
  );
$$;

create or replace function public.can_edit_memo(p_memo_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin()
    or exists (
      select 1 from public.memos m
      where m.id = p_memo_id
        and m.user_id = (select auth.uid())
        and m.deleted_at is null
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
        p.user_id = (select auth.uid())
        or public.is_admin()
        or (p.trip_id is not null and public.can_access_trip(p.trip_id))
        or (p.memo_id is not null and public.can_access_memo(p.memo_id))
      )
  );
$$;

-- Drop all existing policies on the app tables to remove recursive/old versions.
do $$
declare
  r record;
begin
  for r in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in ('profiles','trips','memos','photos','sync_events','trip_members','trip_invites')
  loop
    execute format('drop policy if exists %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

-- Profiles
create policy "profiles_select_own_or_admin" on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or public.is_admin());

create policy "profiles_insert_own" on public.profiles
  for insert to authenticated
  with check (id = (select auth.uid()) and role = 'user');

create policy "profiles_update_own_or_admin" on public.profiles
  for update to authenticated
  using (id = (select auth.uid()) or public.is_admin())
  with check (id = (select auth.uid()) or public.is_admin());

-- Trips
create policy "trips_select_accessible" on public.trips
  for select to authenticated
  using (public.can_access_trip(id));

create policy "trips_insert_owner" on public.trips
  for insert to authenticated
  with check (user_id = (select auth.uid()) or public.is_admin());

create policy "trips_update_owner" on public.trips
  for update to authenticated
  using (user_id = (select auth.uid()) or public.is_admin())
  with check (user_id = (select auth.uid()) or public.is_admin());

create policy "trips_delete_owner" on public.trips
  for delete to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());

-- Memos
create policy "memos_select_accessible" on public.memos
  for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin() or (trip_id is not null and public.can_access_trip(trip_id)));

create policy "memos_insert_owner_or_trip_editor" on public.memos
  for insert to authenticated
  with check (user_id = (select auth.uid()) and (trip_id is null or public.can_edit_trip(trip_id)));

create policy "memos_update_owner" on public.memos
  for update to authenticated
  using (user_id = (select auth.uid()) or public.is_admin())
  with check (user_id = (select auth.uid()) or public.is_admin());

create policy "memos_delete_owner" on public.memos
  for delete to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());

-- Photos
create policy "photos_select_accessible" on public.photos
  for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin() or (trip_id is not null and public.can_access_trip(trip_id)) or (memo_id is not null and public.can_access_memo(memo_id)));

create policy "photos_insert_owner" on public.photos
  for insert to authenticated
  with check (user_id = (select auth.uid()) and (trip_id is null or public.can_edit_trip(trip_id)) and (memo_id is null or public.can_edit_memo(memo_id)));

create policy "photos_update_owner" on public.photos
  for update to authenticated
  using (user_id = (select auth.uid()) or public.is_admin())
  with check (user_id = (select auth.uid()) or public.is_admin());

create policy "photos_delete_owner" on public.photos
  for delete to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());

-- Sync events
create policy "sync_events_select_own_or_admin" on public.sync_events
  for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());

create policy "sync_events_insert_own" on public.sync_events
  for insert to authenticated
  with check (user_id = (select auth.uid()) or public.is_admin());

-- Trip invites
create policy "trip_invites_select_related" on public.trip_invites
  for select to authenticated
  using (owner_id = (select auth.uid()) or lower(invited_email) = public.current_user_email() or public.is_admin());

create policy "trip_invites_insert_owner" on public.trip_invites
  for insert to authenticated
  with check (owner_id = (select auth.uid()) and public.is_trip_owner(trip_id));

create policy "trip_invites_update_owner" on public.trip_invites
  for update to authenticated
  using (owner_id = (select auth.uid()) or public.is_admin())
  with check (owner_id = (select auth.uid()) or public.is_admin());

create policy "trip_invites_delete_owner" on public.trip_invites
  for delete to authenticated
  using (owner_id = (select auth.uid()) or public.is_admin());

-- Trip members
create policy "trip_members_select_related" on public.trip_members
  for select to authenticated
  using (user_id = (select auth.uid()) or lower(email) = public.current_user_email() or public.is_trip_owner(trip_id) or public.is_admin());

create policy "trip_members_insert_owner" on public.trip_members
  for insert to authenticated
  with check (public.is_trip_owner(trip_id) or public.is_admin());

create policy "trip_members_update_owner" on public.trip_members
  for update to authenticated
  using (public.is_trip_owner(trip_id) or public.is_admin())
  with check (public.is_trip_owner(trip_id) or public.is_admin());

create policy "trip_members_delete_owner" on public.trip_members
  for delete to authenticated
  using (public.is_trip_owner(trip_id) or public.is_admin());

-- Storage bucket and policies. Select supports shared trips; insert/update/delete stay scoped to each user's folder.
insert into storage.buckets (id, name, public)
values ('travel-memo-photos', 'travel-memo-photos', false)
on conflict (id) do nothing;

drop policy if exists "travel_memo_photos_select_own" on storage.objects;
drop policy if exists "travel_memo_photos_insert_own" on storage.objects;
drop policy if exists "travel_memo_photos_update_own" on storage.objects;
drop policy if exists "travel_memo_photos_delete_own" on storage.objects;
drop policy if exists "travel_memo_photos_select_private_or_invited" on storage.objects;

create policy "travel_memo_photos_select_private_or_invited"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'travel-memo-photos'
  and (
    (storage.foldername(name))[1] = (select auth.uid())::text
    or exists (
      select 1 from public.photos p
      where (p.storage_path = name or p.thumbnail_path = name)
        and public.can_access_photo(p.id)
    )
  )
);

create policy "travel_memo_photos_insert_own"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'travel-memo-photos'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

create policy "travel_memo_photos_update_own"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'travel-memo-photos'
  and (storage.foldername(name))[1] = (select auth.uid())::text
)
with check (
  bucket_id = 'travel-memo-photos'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

create policy "travel_memo_photos_delete_own"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'travel-memo-photos'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

commit;
