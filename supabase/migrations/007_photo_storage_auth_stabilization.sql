-- Travel Memo v2.1.18
-- Photo Storage + Auth Stabilization
-- Run this after deploying v2.1.18 if old cloud photos show broken thumbnails.

-- 1) Ensure expected photo path columns exist. Existing projects already have these,
--    but this keeps older databases compatible with the current frontend.
alter table public.photos add column if not exists storage_path text;
alter table public.photos add column if not exists thumbnail_path text;
alter table public.photos add column if not exists original_name text;
alter table public.photos add column if not exists mime_type text default 'image/jpeg';
alter table public.photos add column if not exists width integer;
alter table public.photos add column if not exists height integer;
alter table public.photos add column if not exists size_bytes bigint;
alter table public.photos add column if not exists taken_at timestamptz;
alter table public.photos add column if not exists deleted_at timestamptz;
alter table public.photos add column if not exists updated_at timestamptz default now();

-- 2) Storage policies for private bucket travel-memo-photos.
--    This policy supports both path styles:
--    - user_id/photos/file.jpg
--    - any path referenced by public.photos.storage_path or public.photos.thumbnail_path for that user
alter table storage.objects enable row level security;

drop policy if exists "travel_memo_photos_select_v2117" on storage.objects;
drop policy if exists "travel_memo_photos_insert_v2117" on storage.objects;
drop policy if exists "travel_memo_photos_update_v2117" on storage.objects;
drop policy if exists "travel_memo_photos_delete_v2117" on storage.objects;

create policy "travel_memo_photos_select_v2117"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'travel-memo-photos'
  and (
    (storage.foldername(name))[1] = auth.uid()::text
    or exists (
      select 1
      from public.photos p
      where p.user_id = auth.uid()
        and p.deleted_at is null
        and (p.storage_path = storage.objects.name or p.thumbnail_path = storage.objects.name)
    )
  )
);

create policy "travel_memo_photos_insert_v2117"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'travel-memo-photos'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "travel_memo_photos_update_v2117"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'travel-memo-photos'
  and (storage.foldername(name))[1] = auth.uid()::text
)
with check (
  bucket_id = 'travel-memo-photos'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "travel_memo_photos_delete_v2117"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'travel-memo-photos'
  and (storage.foldername(name))[1] = auth.uid()::text
);

-- Optional helper check after running:
-- select id, user_id, storage_path, thumbnail_path from public.photos order by created_at desc limit 20;
