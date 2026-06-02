-- Travel Memo v2.1.0 private space + trip invites
-- Run this after 001_initial_schema.sql.

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

drop trigger if exists trip_invites_set_updated_at on public.trip_invites;
create trigger trip_invites_set_updated_at before update on public.trip_invites
  for each row execute procedure public.set_updated_at();

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
      and t.deleted_at is null
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

-- Trip invite policies
DROP POLICY IF EXISTS "trip_invites_select_related" ON public.trip_invites;
create policy "trip_invites_select_related" on public.trip_invites
  for select to authenticated
  using (
    owner_id = (select auth.uid())
    or lower(invited_email) = public.current_user_email()
    or public.is_admin()
  );

DROP POLICY IF EXISTS "trip_invites_insert_owner" ON public.trip_invites;
create policy "trip_invites_insert_owner" on public.trip_invites
  for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and exists (select 1 from public.trips t where t.id = trip_id and t.user_id = (select auth.uid()))
  );

DROP POLICY IF EXISTS "trip_invites_update_owner" ON public.trip_invites;
create policy "trip_invites_update_owner" on public.trip_invites
  for update to authenticated
  using (owner_id = (select auth.uid()) or public.is_admin())
  with check (owner_id = (select auth.uid()) or public.is_admin());

DROP POLICY IF EXISTS "trip_invites_delete_owner" ON public.trip_invites;
create policy "trip_invites_delete_owner" on public.trip_invites
  for delete to authenticated
  using (owner_id = (select auth.uid()) or public.is_admin());

-- Replace select policies so invited members can read shared trips/memos/photos.
DROP POLICY IF EXISTS "trips_select_own_or_admin" ON public.trips;
DROP POLICY IF EXISTS "trips_select_private_or_invited" ON public.trips;
create policy "trips_select_private_or_invited" on public.trips
  for select to authenticated
  using (public.can_view_trip(id));

DROP POLICY IF EXISTS "memos_select_own_or_admin" ON public.memos;
DROP POLICY IF EXISTS "memos_select_private_or_invited" ON public.memos;
create policy "memos_select_private_or_invited" on public.memos
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or public.is_admin()
    or (trip_id is not null and public.can_view_trip(trip_id))
  );

DROP POLICY IF EXISTS "photos_select_own_or_admin" ON public.photos;
DROP POLICY IF EXISTS "photos_select_private_or_invited" ON public.photos;
create policy "photos_select_private_or_invited" on public.photos
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or public.is_admin()
    or (trip_id is not null and public.can_view_trip(trip_id))
    or exists (select 1 from public.memos m where m.id = memo_id and m.trip_id is not null and public.can_view_trip(m.trip_id))
  );

commit;
