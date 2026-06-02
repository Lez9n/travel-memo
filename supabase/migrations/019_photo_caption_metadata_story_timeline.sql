-- v2.5.2 Photo caption and story timeline metadata
-- Run in Supabase SQL editor if the cloud photos table was created before v2.4.0.

begin;

alter table public.photos add column if not exists caption text default '';
alter table public.photos add column if not exists sort_order integer default 0;
alter table public.photos add column if not exists original_width integer;
alter table public.photos add column if not exists original_height integer;
alter table public.photos add column if not exists original_size_bytes bigint;
alter table public.photos add column if not exists compression_ratio numeric;
alter table public.photos add column if not exists processing_ms integer;
alter table public.photos add column if not exists has_exif_gps boolean default false;
alter table public.photos add column if not exists exif_taken_at timestamptz;
alter table public.photos add column if not exists latitude double precision;
alter table public.photos add column if not exists longitude double precision;

create index if not exists photos_memo_sort_order_idx on public.photos(memo_id, sort_order);
create index if not exists photos_trip_sort_order_idx on public.photos(trip_id, sort_order);

commit;
