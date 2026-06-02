-- Travel Memo v2.8.4 Public Share Reopen Policy Alignment
-- Public access is controlled by is_public=true and public_slug.
-- This keeps the same public URL usable after an owner disables and re-enables public sharing.

alter table public.trips
  add column if not exists is_public boolean default false,
  add column if not exists public_slug text,
  add column if not exists public_enabled_at timestamptz,
  add column if not exists public_disabled_at timestamptz;

create unique index if not exists idx_trips_public_slug_unique
  on public.trips (public_slug)
  where public_slug is not null;

create index if not exists idx_trips_public_lookup
  on public.trips (public_slug, is_public)
  where deleted_at is null;

drop policy if exists "Public read visible public trips" on public.trips;
create policy "Public read visible public trips"
  on public.trips
  for select
  using (
    is_public = true
    and public_slug is not null
    and coalesce(is_visible, true) = true
    and deleted_at is null
  );

drop policy if exists "Public read memos from public trips" on public.memos;
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
        and t.public_slug is not null
        and coalesce(t.is_visible, true) = true
        and t.deleted_at is null
    )
  );

drop policy if exists "Public read photos from public trips" on public.photos;
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
        and t.public_slug is not null
        and coalesce(t.is_visible, true) = true
        and t.deleted_at is null
    )
  );
