-- Travel Memo v2.1.1 stable sync + private policy repair
-- Run after 001_initial_schema.sql. Safe to run multiple times.

begin;

create table if not exists public.trip_invites (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  invited_email text not null,
  role text not null default 'viewer' check (role in ('viewer', 'editor')),
  status text not null default 'accepted' check (status in ('pending', 'accepted', 'revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (trip_id, invited_email)
);

create index if not exists trip_invites_trip_idx on public.trip_invites(trip_id);
create index if not exists trip_invites_email_idx on public.trip_invites(lower(invited_email));
create index if not exists trip_invites_owner_idx on public.trip_invites(owner_id);

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

create or replace function public.can_view_trip(target_trip_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.trips t
    where t.id = target_trip_id
      and coalesce(t.deleted_at, 'infinity'::timestamptz) is not null
      and (
        t.deleted_at is null
        or t.user_id = (select auth.uid())
      )
      and (
        t.user_id = (select auth.uid())
        or public.is_admin()
        or exists (
          select 1 from public.trip_invites i
          where i.trip_id = t.id
            and i.status = 'accepted'
            and lower(i.invited_email) = public.current_user_email()
        )
      )
  );
$$;

-- trip invite policies
drop policy if exists "trip_invites_select_related" on public.trip_invites;
create policy "trip_invites_select_related" on public.trip_invites
  for select to authenticated
  using (
    owner_id = (select auth.uid())
    or lower(invited_email) = public.current_user_email()
    or public.is_admin()
  );

drop policy if exists "trip_invites_insert_owner" on public.trip_invites;
create policy "trip_invites_insert_owner" on public.trip_invites
  for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and exists (select 1 from public.trips t where t.id = trip_id and t.user_id = (select auth.uid()))
  );

drop policy if exists "trip_invites_update_owner" on public.trip_invites;
create policy "trip_invites_update_owner" on public.trip_invites
  for update to authenticated
  using (owner_id = (select auth.uid()) or public.is_admin())
  with check (owner_id = (select auth.uid()) or public.is_admin());

drop policy if exists "trip_invites_delete_owner" on public.trip_invites;
create policy "trip_invites_delete_owner" on public.trip_invites
  for delete to authenticated
  using (owner_id = (select auth.uid()) or public.is_admin());

-- trips policies
drop policy if exists "trips_select_own_or_admin" on public.trips;
drop policy if exists "trips_select_private_or_invited" on public.trips;
drop policy if exists "trips_insert_own_or_admin" on public.trips;
drop policy if exists "trips_insert_own" on public.trips;
drop policy if exists "trips_update_own_or_admin" on public.trips;
drop policy if exists "trips_update_own" on public.trips;
drop policy if exists "trips_delete_own_or_admin" on public.trips;
drop policy if exists "trips_delete_own" on public.trips;

create policy "trips_select_private_or_invited" on public.trips
  for select to authenticated
  using (public.can_view_trip(id));

create policy "trips_insert_own" on public.trips
  for insert to authenticated
  with check (user_id = (select auth.uid()) or public.is_admin());

create policy "trips_update_own" on public.trips
  for update to authenticated
  using (user_id = (select auth.uid()) or public.is_admin())
  with check (user_id = (select auth.uid()) or public.is_admin());

create policy "trips_delete_own" on public.trips
  for delete to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());

-- memos select policy for private/invited trips. Keep insert/update/delete owner policies from 001.
drop policy if exists "memos_select_own_or_admin" on public.memos;
drop policy if exists "memos_select_private_or_invited" on public.memos;
create policy "memos_select_private_or_invited" on public.memos
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or public.is_admin()
    or (trip_id is not null and public.can_view_trip(trip_id))
  );

-- photos select policy for private/invited trips. Keep insert/update/delete owner policies from 001.
drop policy if exists "photos_select_own_or_admin" on public.photos;
drop policy if exists "photos_select_private_or_invited" on public.photos;
create policy "photos_select_private_or_invited" on public.photos
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or public.is_admin()
    or (trip_id is not null and public.can_view_trip(trip_id))
    or exists (
      select 1 from public.memos m
      where m.id = memo_id and m.trip_id is not null and public.can_view_trip(m.trip_id)
    )
  );

commit;
