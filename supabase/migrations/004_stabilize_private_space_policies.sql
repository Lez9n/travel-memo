-- Travel Memo v2.1.2 stabilize private space policies
-- Safe to run multiple times after 001, 002, 003.

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
alter table public.trips enable row level security;
alter table public.memos enable row level security;
alter table public.photos enable row level security;

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
    where p.id = (select auth.uid()) and p.role = 'admin'
  );
$$;

create or replace function public.owns_trip(target_trip_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.trips t
    where t.id = target_trip_id and t.user_id = (select auth.uid())
  );
$$;

-- Remove old policies that caused recursion or overly broad access.
drop policy if exists "trips_select_own_or_admin" on public.trips;
drop policy if exists "trips_select_private_or_invited" on public.trips;
drop policy if exists "trips_select_private_or_member" on public.trips;
drop policy if exists "trips_insert_own_or_admin" on public.trips;
drop policy if exists "trips_insert_own" on public.trips;
drop policy if exists "trips_update_own_or_admin" on public.trips;
drop policy if exists "trips_update_own" on public.trips;
drop policy if exists "trips_delete_own_or_admin" on public.trips;
drop policy if exists "trips_delete_own" on public.trips;

create policy "trips_select_private_or_invited" on public.trips
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or public.is_admin()
    or exists (
      select 1 from public.trip_invites i
      where i.trip_id = trips.id
        and i.status = 'accepted'
        and lower(i.invited_email) = public.current_user_email()
    )
  );

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

-- Invite policies use security definer helper instead of joining trips through an RLS policy.
drop policy if exists "trip_invites_select_related" on public.trip_invites;
drop policy if exists "trip_invites_insert_owner" on public.trip_invites;
drop policy if exists "trip_invites_update_owner" on public.trip_invites;
drop policy if exists "trip_invites_delete_owner" on public.trip_invites;

create policy "trip_invites_select_related" on public.trip_invites
  for select to authenticated
  using (
    owner_id = (select auth.uid())
    or lower(invited_email) = public.current_user_email()
    or public.is_admin()
  );

create policy "trip_invites_insert_owner" on public.trip_invites
  for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and (public.owns_trip(trip_id) or public.is_admin())
  );

create policy "trip_invites_update_owner" on public.trip_invites
  for update to authenticated
  using (owner_id = (select auth.uid()) or public.is_admin())
  with check (owner_id = (select auth.uid()) or public.is_admin());

create policy "trip_invites_delete_owner" on public.trip_invites
  for delete to authenticated
  using (owner_id = (select auth.uid()) or public.is_admin());

-- Memo visibility: owner/admin or invited by trip_id. This avoids referencing trips from memos policy.
drop policy if exists "memos_select_own_or_admin" on public.memos;
drop policy if exists "memos_select_private_or_invited" on public.memos;
create policy "memos_select_private_or_invited" on public.memos
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or public.is_admin()
    or exists (
      select 1 from public.trip_invites i
      where i.trip_id = memos.trip_id
        and i.status = 'accepted'
        and lower(i.invited_email) = public.current_user_email()
    )
  );

-- Photo visibility: owner/admin, invited directly by photo.trip_id, or invited by the memo's trip.
drop policy if exists "photos_select_own_or_admin" on public.photos;
drop policy if exists "photos_select_private_or_invited" on public.photos;
create policy "photos_select_private_or_invited" on public.photos
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or public.is_admin()
    or exists (
      select 1 from public.trip_invites i
      where i.trip_id = photos.trip_id
        and i.status = 'accepted'
        and lower(i.invited_email) = public.current_user_email()
    )
    or exists (
      select 1
      from public.memos m
      join public.trip_invites i on i.trip_id = m.trip_id
      where m.id = photos.memo_id
        and i.status = 'accepted'
        and lower(i.invited_email) = public.current_user_email()
    )
  );

commit;
