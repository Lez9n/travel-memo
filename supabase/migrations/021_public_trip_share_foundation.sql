-- Travel Memo v2.8.3 Public Trip Share Foundation
-- Run this in Supabase SQL Editor, then refresh API schema cache.

alter table public.trips
  add column if not exists is_public boolean default false,
  add column if not exists visibility text default 'private',
  add column if not exists public_slug text,
  add column if not exists public_enabled_at timestamptz,
  add column if not exists public_disabled_at timestamptz;

create unique index if not exists idx_trips_public_slug_unique
  on public.trips (public_slug)
  where public_slug is not null;

create index if not exists idx_trips_public_lookup
  on public.trips (public_slug, is_public, visibility)
  where deleted_at is null;

-- Public read-only access: only explicitly public, visible, non-deleted trips.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'trips'
      and policyname = 'Public read visible public trips'
  ) then
    create policy "Public read visible public trips"
      on public.trips
      for select
      using (
        is_public = true
        and coalesce(is_visible, true) = true
        and deleted_at is null
      );
  end if;
end $$;

-- Public read-only access to visible memos that belong to a public trip.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'memos'
      and policyname = 'Public read memos from public trips'
  ) then
    create policy "Public read memos from public trips"
      on public.memos
      for select
      using (
        deleted_at is null
        and coalesce(is_visible, true) = true
        and exists (
          select 1 from public.trips t
          where t.id = memos.trip_id
            and t.is_public = true
            and coalesce(t.is_visible, true) = true
            and t.deleted_at is null
        )
      );
  end if;
end $$;

-- Public read-only access to photos attached to visible memos inside public trips.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'photos'
      and policyname = 'Public read photos from public trips'
  ) then
    create policy "Public read photos from public trips"
      on public.photos
      for select
      using (
        deleted_at is null
        and exists (
          select 1
          from public.memos m
          join public.trips t on t.id = m.trip_id
          where m.id = photos.memo_id
            and m.deleted_at is null
            and coalesce(m.is_visible, true) = true
            and t.is_public = true
            and coalesce(t.is_visible, true) = true
            and t.deleted_at is null
        )
      );
  end if;
end $$;
