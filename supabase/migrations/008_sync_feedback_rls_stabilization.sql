-- Travel Memo v2.1.19
-- Sync feedback + RLS stabilization for queued offline records.
-- Safe to run in Supabase SQL Editor. Does not touch storage.objects.

alter table public.trips enable row level security;
alter table public.memos enable row level security;
alter table public.photos enable row level security;

-- Add simple owner policies so offline-created records can be inserted/upserted
-- by the logged-in user even if older invite/editor policies are too strict.
drop policy if exists "tm_v2119_trips_insert_owner" on public.trips;
create policy "tm_v2119_trips_insert_owner"
on public.trips
for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "tm_v2119_trips_update_owner" on public.trips;
create policy "tm_v2119_trips_update_owner"
on public.trips
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "tm_v2119_memos_insert_owner" on public.memos;
create policy "tm_v2119_memos_insert_owner"
on public.memos
for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "tm_v2119_memos_update_owner" on public.memos;
create policy "tm_v2119_memos_update_owner"
on public.memos
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "tm_v2119_photos_insert_owner" on public.photos;
create policy "tm_v2119_photos_insert_owner"
on public.photos
for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "tm_v2119_photos_update_owner" on public.photos;
create policy "tm_v2119_photos_update_owner"
on public.photos
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

-- Make sure photo path columns used by the current frontend exist.
alter table public.photos add column if not exists storage_path text;
alter table public.photos add column if not exists thumbnail_path text;

create index if not exists photos_storage_path_idx on public.photos(storage_path);
create index if not exists photos_thumbnail_path_idx on public.photos(thumbnail_path);
