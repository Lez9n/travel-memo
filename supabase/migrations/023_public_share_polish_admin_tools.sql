-- Travel Memo v2.8.7 Public Share Polish / Admin Tools
-- Safe alignment for public trip sharing, old-link revoke/regenerate workflows, and public read-only policies.

alter table public.trips
  add column if not exists is_public boolean default false,
  add column if not exists visibility text default 'private',
  add column if not exists public_slug text,
  add column if not exists public_enabled_at timestamptz,
  add column if not exists public_disabled_at timestamptz;

create unique index if not exists idx_trips_public_slug_unique
  on public.trips (public_slug)
  where public_slug is not null;

create index if not exists idx_trips_public_share_lookup
  on public.trips (public_slug, is_public)
  where public_slug is not null;

-- Keep public reads limited to explicitly public trips and visible children.
drop policy if exists "public_read_public_trips" on public.trips;
create policy "public_read_public_trips"
  on public.trips for select
  using (is_public = true and public_slug is not null and deleted_at is null);

drop policy if exists "public_read_visible_memos_in_public_trips" on public.memos;
create policy "public_read_visible_memos_in_public_trips"
  on public.memos for select
  using (
    deleted_at is null
    and coalesce(is_visible, true) = true
    and exists (
      select 1 from public.trips t
      where t.id = memos.trip_id
        and t.is_public = true
        and t.public_slug is not null
        and t.deleted_at is null
    )
  );

drop policy if exists "public_read_photos_in_public_trips" on public.photos;
create policy "public_read_photos_in_public_trips"
  on public.photos for select
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
        and t.public_slug is not null
        and t.deleted_at is null
    )
  );
