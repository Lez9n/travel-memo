-- Travel Memo v2.0 Supabase schema
-- Run this in Supabase SQL Editor before deploying the app.
-- The app uses the public anon key only; never expose the service role key to the browser.

begin;

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  avatar_url text,
  role text not null default 'user' check (role in ('user', 'support', 'moderator', 'admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = (select auth.uid())
      and role = 'admin'
  );
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1), 'Traveler')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

create or replace function public.prevent_role_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.role is distinct from new.role and not public.is_admin() then
    raise exception 'Only admins can change profile roles';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles
  for each row execute procedure public.set_updated_at();

drop trigger if exists profiles_prevent_role_escalation on public.profiles;
create trigger profiles_prevent_role_escalation before update on public.profiles
  for each row execute procedure public.prevent_role_escalation();

create table if not exists public.trips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  description text default '',
  start_date date,
  end_date date,
  country text default '',
  city text default '',
  status text not null default 'done' check (status in ('planned', 'active', 'done')),
  theme text default '',
  is_public boolean not null default false,
  cover_photo_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.memos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  trip_id uuid references public.trips(id) on delete set null,
  title text not null,
  place_name text default '',
  note text default '',
  diary text default '',
  mood text default '',
  rating int default 0 check (rating >= 0 and rating <= 5),
  visited_at timestamptz not null default now(),
  latitude double precision,
  longitude double precision,
  country text default '',
  region text default '',
  city text default '',
  tags text[] not null default '{}',
  is_public boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.photos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  memo_id uuid references public.memos(id) on delete cascade,
  trip_id uuid references public.trips(id) on delete set null,
  storage_path text,
  thumbnail_path text,
  original_name text default 'photo.jpg',
  mime_type text default 'image/jpeg',
  width int,
  height int,
  size_bytes bigint,
  taken_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.sync_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  entity_type text not null,
  entity_id uuid,
  action text not null,
  status text not null default 'pending',
  error_message text,
  created_at timestamptz not null default now(),
  synced_at timestamptz
);

create index if not exists profiles_role_idx on public.profiles(role);
create index if not exists trips_user_updated_idx on public.trips(user_id, updated_at desc);
create index if not exists trips_user_deleted_idx on public.trips(user_id, deleted_at);
create index if not exists memos_user_visited_idx on public.memos(user_id, visited_at desc);
create index if not exists memos_trip_idx on public.memos(trip_id);
create index if not exists memos_user_deleted_idx on public.memos(user_id, deleted_at);
create index if not exists memos_tags_idx on public.memos using gin(tags);
create index if not exists photos_user_memo_idx on public.photos(user_id, memo_id);
create index if not exists photos_trip_idx on public.photos(trip_id);
create index if not exists sync_events_user_idx on public.sync_events(user_id, created_at desc);

drop trigger if exists trips_set_updated_at on public.trips;
create trigger trips_set_updated_at before update on public.trips
  for each row execute procedure public.set_updated_at();

drop trigger if exists memos_set_updated_at on public.memos;
create trigger memos_set_updated_at before update on public.memos
  for each row execute procedure public.set_updated_at();

drop trigger if exists photos_set_updated_at on public.photos;
create trigger photos_set_updated_at before update on public.photos
  for each row execute procedure public.set_updated_at();

alter table public.profiles enable row level security;
alter table public.trips enable row level security;
alter table public.memos enable row level security;
alter table public.photos enable row level security;
alter table public.sync_events enable row level security;

-- Profiles policies
DROP POLICY IF EXISTS "profiles_select_own_or_admin" ON public.profiles;
create policy "profiles_select_own_or_admin" on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or public.is_admin());

DROP POLICY IF EXISTS "profiles_insert_own" ON public.profiles;
create policy "profiles_insert_own" on public.profiles
  for insert to authenticated
  with check (id = (select auth.uid()) and role = 'user');

DROP POLICY IF EXISTS "profiles_update_own_or_admin" ON public.profiles;
create policy "profiles_update_own_or_admin" on public.profiles
  for update to authenticated
  using (id = (select auth.uid()) or public.is_admin())
  with check (id = (select auth.uid()) or public.is_admin());

-- Trips policies
DROP POLICY IF EXISTS "trips_select_own_or_admin" ON public.trips;
create policy "trips_select_own_or_admin" on public.trips
  for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());

DROP POLICY IF EXISTS "trips_insert_own_or_admin" ON public.trips;
create policy "trips_insert_own_or_admin" on public.trips
  for insert to authenticated
  with check (user_id = (select auth.uid()) or public.is_admin());

DROP POLICY IF EXISTS "trips_update_own_or_admin" ON public.trips;
create policy "trips_update_own_or_admin" on public.trips
  for update to authenticated
  using (user_id = (select auth.uid()) or public.is_admin())
  with check (user_id = (select auth.uid()) or public.is_admin());

DROP POLICY IF EXISTS "trips_delete_own_or_admin" ON public.trips;
create policy "trips_delete_own_or_admin" on public.trips
  for delete to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());

-- Memos policies
DROP POLICY IF EXISTS "memos_select_own_or_admin" ON public.memos;
create policy "memos_select_own_or_admin" on public.memos
  for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());

DROP POLICY IF EXISTS "memos_insert_own_or_admin" ON public.memos;
create policy "memos_insert_own_or_admin" on public.memos
  for insert to authenticated
  with check (user_id = (select auth.uid()) or public.is_admin());

DROP POLICY IF EXISTS "memos_update_own_or_admin" ON public.memos;
create policy "memos_update_own_or_admin" on public.memos
  for update to authenticated
  using (user_id = (select auth.uid()) or public.is_admin())
  with check (user_id = (select auth.uid()) or public.is_admin());

DROP POLICY IF EXISTS "memos_delete_own_or_admin" ON public.memos;
create policy "memos_delete_own_or_admin" on public.memos
  for delete to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());

-- Photos policies
DROP POLICY IF EXISTS "photos_select_own_or_admin" ON public.photos;
create policy "photos_select_own_or_admin" on public.photos
  for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());

DROP POLICY IF EXISTS "photos_insert_own_or_admin" ON public.photos;
create policy "photos_insert_own_or_admin" on public.photos
  for insert to authenticated
  with check (user_id = (select auth.uid()) or public.is_admin());

DROP POLICY IF EXISTS "photos_update_own_or_admin" ON public.photos;
create policy "photos_update_own_or_admin" on public.photos
  for update to authenticated
  using (user_id = (select auth.uid()) or public.is_admin())
  with check (user_id = (select auth.uid()) or public.is_admin());

DROP POLICY IF EXISTS "photos_delete_own_or_admin" ON public.photos;
create policy "photos_delete_own_or_admin" on public.photos
  for delete to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());

-- Sync event policies
DROP POLICY IF EXISTS "sync_events_select_own_or_admin" ON public.sync_events;
create policy "sync_events_select_own_or_admin" on public.sync_events
  for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());

DROP POLICY IF EXISTS "sync_events_insert_own_or_admin" ON public.sync_events;
create policy "sync_events_insert_own_or_admin" on public.sync_events
  for insert to authenticated
  with check (user_id = (select auth.uid()) or public.is_admin());

-- Private Storage bucket for photos
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'travel-memo-photos',
  'travel-memo-photos',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

DROP POLICY IF EXISTS "storage_select_own_travel_memo_photos" ON storage.objects;
create policy "storage_select_own_travel_memo_photos" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'travel-memo-photos'
    and ((storage.foldername(name))[1] = (select auth.uid())::text or public.is_admin())
  );

DROP POLICY IF EXISTS "storage_insert_own_travel_memo_photos" ON storage.objects;
create policy "storage_insert_own_travel_memo_photos" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'travel-memo-photos'
    and ((storage.foldername(name))[1] = (select auth.uid())::text or public.is_admin())
  );

DROP POLICY IF EXISTS "storage_update_own_travel_memo_photos" ON storage.objects;
create policy "storage_update_own_travel_memo_photos" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'travel-memo-photos'
    and ((storage.foldername(name))[1] = (select auth.uid())::text or public.is_admin())
  )
  with check (
    bucket_id = 'travel-memo-photos'
    and ((storage.foldername(name))[1] = (select auth.uid())::text or public.is_admin())
  );

DROP POLICY IF EXISTS "storage_delete_own_travel_memo_photos" ON storage.objects;
create policy "storage_delete_own_travel_memo_photos" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'travel-memo-photos'
    and ((storage.foldername(name))[1] = (select auth.uid())::text or public.is_admin())
  );

commit;

-- After your first user signs up, make yourself admin by running:
-- update public.profiles set role = 'admin' where email = 'YOUR_EMAIL@example.com';
