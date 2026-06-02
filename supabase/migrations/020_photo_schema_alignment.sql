-- Travel Memo v2.6.10 — Supabase Photo Schema Alignment
-- Safe to run multiple times. After running, refresh schema cache in Supabase Project Settings > API.

alter table public.photos
  add column if not exists thumb_path text,
  add column if not exists thumbnail_path text,
  add column if not exists caption text,
  add column if not exists sort_order integer default 0,
  add column if not exists original_width integer,
  add column if not exists original_height integer,
  add column if not exists compressed_width integer,
  add column if not exists compressed_height integer,
  add column if not exists original_size_bytes bigint,
  add column if not exists compressed_size_bytes bigint,
  add column if not exists compression_saved_bytes bigint,
  add column if not exists exif_latitude double precision,
  add column if not exists exif_longitude double precision,
  add column if not exists exif_taken_at timestamptz,
  add column if not exists metadata jsonb default '{}'::jsonb;

create index if not exists idx_photos_memo_id_sort_order on public.photos (memo_id, sort_order);
create index if not exists idx_photos_trip_id_sort_order on public.photos (trip_id, sort_order);
create index if not exists idx_photos_user_id_updated_at on public.photos (user_id, updated_at desc);
