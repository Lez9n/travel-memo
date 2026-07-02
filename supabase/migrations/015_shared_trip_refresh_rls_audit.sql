-- Travel Memo v2.1.30
-- Shared Trip Refresh + RLS audit.
-- Purpose:
-- 1) Let accepted trip members read shared trips, memos, photos, members and invites.
-- 2) Keep owner-only write access for trips/memos/photos.
-- 3) Ensure revoked members lose access and frontend can clean stale local shared cache on next Cloud pull.
-- Safe for Supabase SQL Editor. Does not touch storage.objects.

begin;

alter table public.trips enable row level security;
alter table public.memos enable row level security;
alter table public.photos enable row level security;
alter table public.trip_members enable row level security;
alter table public.trip_invites enable row level security;

alter table public.trip_members add column if not exists email text;
alter table public.trip_members add column if not exists role text not null default 'viewer';
alter table public.trip_members add column if not exists status text not null default 'accepted';
alter table public.trip_members add column if not exists updated_at timestamptz default now();
alter table public.trip_invites add column if not exists status text not null default 'pending';
alter table public.trip_invites add column if not exists updated_at timestamptz default now();
alter table public.trip_invites add column if not exists role text not null default 'viewer';

create or replace function public.current_user_email()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select lower(coalesce(auth.jwt() ->> 'email', (select email from auth.users where id = auth.uid()), ''));
$$;

create or replace function public.can_access_trip(p_trip_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.trips t
    where t.id = p_trip_id
      and t.deleted_at is null
      and (
        t.user_id = auth.uid()
        or exists (
          select 1
          from public.trip_members tm
          where tm.trip_id = t.id
            and lower(coalesce(tm.status, 'accepted')) = 'accepted'
            and (
              tm.user_id = auth.uid()
              or lower(coalesce(tm.email, '')) = public.current_user_email()
            )
        )
        or exists (
          select 1
          from public.trip_invites ti
          where ti.trip_id = t.id
            and lower(coalesce(ti.status, '')) = 'accepted'
            and lower(coalesce(ti.invited_email, '')) = public.current_user_email()
            and (ti.expires_at is null or ti.expires_at > now())
        )
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
    select 1
    from public.memos m
    where m.id = p_memo_id
      and m.deleted_at is null
      and (
        m.user_id = auth.uid()
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
    select 1
    from public.photos p
    where p.id = p_photo_id
      and p.deleted_at is null
      and (
        p.user_id = auth.uid()
        or (p.trip_id is not null and public.can_access_trip(p.trip_id))
        or (p.memo_id is not null and public.can_access_memo(p.memo_id))
      )
  );
$$;

-- Trips
DROP POLICY IF EXISTS "tm_v2130_trips_owner_select" ON public.trips;
DROP POLICY IF EXISTS "tm_v2130_trips_shared_select" ON public.trips;
DROP POLICY IF EXISTS "tm_v2130_trips_owner_insert" ON public.trips;
DROP POLICY IF EXISTS "tm_v2130_trips_owner_update" ON public.trips;
DROP POLICY IF EXISTS "tm_v2130_trips_owner_delete" ON public.trips;

CREATE POLICY "tm_v2130_trips_owner_select" ON public.trips
FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "tm_v2130_trips_shared_select" ON public.trips
FOR SELECT TO authenticated USING (public.can_access_trip(id));
CREATE POLICY "tm_v2130_trips_owner_insert" ON public.trips
FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "tm_v2130_trips_owner_update" ON public.trips
FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "tm_v2130_trips_owner_delete" ON public.trips
FOR DELETE TO authenticated USING (user_id = auth.uid());

-- Memos
DROP POLICY IF EXISTS "tm_v2130_memos_owner_select" ON public.memos;
DROP POLICY IF EXISTS "tm_v2130_memos_shared_select" ON public.memos;
DROP POLICY IF EXISTS "tm_v2130_memos_owner_insert" ON public.memos;
DROP POLICY IF EXISTS "tm_v2130_memos_owner_update" ON public.memos;
DROP POLICY IF EXISTS "tm_v2130_memos_owner_delete" ON public.memos;

CREATE POLICY "tm_v2130_memos_owner_select" ON public.memos
FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "tm_v2130_memos_shared_select" ON public.memos
FOR SELECT TO authenticated USING (public.can_access_memo(id));
CREATE POLICY "tm_v2130_memos_owner_insert" ON public.memos
FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "tm_v2130_memos_owner_update" ON public.memos
FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "tm_v2130_memos_owner_delete" ON public.memos
FOR DELETE TO authenticated USING (user_id = auth.uid());

-- Photos
DROP POLICY IF EXISTS "tm_v2130_photos_owner_select" ON public.photos;
DROP POLICY IF EXISTS "tm_v2130_photos_shared_select" ON public.photos;
DROP POLICY IF EXISTS "tm_v2130_photos_owner_insert" ON public.photos;
DROP POLICY IF EXISTS "tm_v2130_photos_owner_update" ON public.photos;
DROP POLICY IF EXISTS "tm_v2130_photos_owner_delete" ON public.photos;

CREATE POLICY "tm_v2130_photos_owner_select" ON public.photos
FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "tm_v2130_photos_shared_select" ON public.photos
FOR SELECT TO authenticated USING (public.can_access_photo(id));
CREATE POLICY "tm_v2130_photos_owner_insert" ON public.photos
FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "tm_v2130_photos_owner_update" ON public.photos
FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "tm_v2130_photos_owner_delete" ON public.photos
FOR DELETE TO authenticated USING (user_id = auth.uid());

-- Members and invites visibility
DROP POLICY IF EXISTS "tm_v2130_members_select_related" ON public.trip_members;
DROP POLICY IF EXISTS "tm_v2130_members_owner_write" ON public.trip_members;
DROP POLICY IF EXISTS "tm_v2130_invites_select_related" ON public.trip_invites;
DROP POLICY IF EXISTS "tm_v2130_invites_owner_write" ON public.trip_invites;

CREATE POLICY "tm_v2130_members_select_related" ON public.trip_members
FOR SELECT TO authenticated USING (
  public.can_access_trip(trip_id)
  or user_id = auth.uid()
  or lower(coalesce(email, '')) = public.current_user_email()
);

CREATE POLICY "tm_v2130_members_owner_write" ON public.trip_members
FOR ALL TO authenticated USING (
  exists (select 1 from public.trips t where t.id = trip_members.trip_id and t.user_id = auth.uid())
) WITH CHECK (
  exists (select 1 from public.trips t where t.id = trip_members.trip_id and t.user_id = auth.uid())
);

CREATE POLICY "tm_v2130_invites_select_related" ON public.trip_invites
FOR SELECT TO authenticated USING (
  owner_id = auth.uid()
  or lower(coalesce(invited_email, '')) = public.current_user_email()
  or public.can_access_trip(trip_id)
);

CREATE POLICY "tm_v2130_invites_owner_write" ON public.trip_invites
FOR ALL TO authenticated USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

grant execute on function public.current_user_email() to authenticated;
grant execute on function public.can_access_trip(uuid) to authenticated;
grant execute on function public.can_access_memo(uuid) to authenticated;
grant execute on function public.can_access_photo(uuid) to authenticated;

commit;
