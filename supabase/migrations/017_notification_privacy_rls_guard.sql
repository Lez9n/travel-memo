-- Travel Memo v2.1.33
-- Notification Center + Privacy/RLS guard
-- Goal: users only see Memo/Photo from their own account or from Trips they own/joined.
-- This migration does not touch storage.objects.

begin;

alter table public.memos enable row level security;
alter table public.photos enable row level security;
alter table public.trips enable row level security;
alter table public.trip_members enable row level security;
alter table public.trip_invites enable row level security;

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

create or replace function public.can_write_trip_content(p_trip_id uuid)
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
            and lower(coalesce(tm.role, 'viewer')) in ('viewer','editor','member','contributor')
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
            and lower(coalesce(ti.role, 'viewer')) in ('viewer','editor','member','contributor')
            and lower(coalesce(ti.invited_email, '')) = public.current_user_email()
            and (ti.expires_at is null or ti.expires_at > now())
        )
      )
  );
$$;

-- Restrictive policies are ANDed with existing permissive policies. This is safer than
-- trying to guess and remove every old policy name from previous dev builds.
drop policy if exists "tm_v2133_memos_privacy_select_guard" on public.memos;
drop policy if exists "tm_v2133_memos_privacy_insert_guard" on public.memos;
drop policy if exists "tm_v2133_memos_privacy_update_guard" on public.memos;
drop policy if exists "tm_v2133_photos_privacy_select_guard" on public.photos;
drop policy if exists "tm_v2133_photos_privacy_insert_guard" on public.photos;
drop policy if exists "tm_v2133_photos_privacy_update_guard" on public.photos;

create policy "tm_v2133_memos_privacy_select_guard" on public.memos
as restrictive
for select to authenticated
using (
  user_id = auth.uid()
  or (trip_id is not null and public.can_access_trip(trip_id))
);

create policy "tm_v2133_memos_privacy_insert_guard" on public.memos
as restrictive
for insert to authenticated
with check (
  user_id = auth.uid()
  and (
    trip_id is null
    or public.can_write_trip_content(trip_id)
  )
);

create policy "tm_v2133_memos_privacy_update_guard" on public.memos
as restrictive
for update to authenticated
using (user_id = auth.uid())
with check (
  user_id = auth.uid()
  and (
    trip_id is null
    or public.can_write_trip_content(trip_id)
  )
);

create policy "tm_v2133_photos_privacy_select_guard" on public.photos
as restrictive
for select to authenticated
using (
  user_id = auth.uid()
  or (trip_id is not null and public.can_access_trip(trip_id))
  or (
    memo_id is not null
    and exists (
      select 1
      from public.memos m
      where m.id = photos.memo_id
        and (
          m.user_id = auth.uid()
          or (m.trip_id is not null and public.can_access_trip(m.trip_id))
        )
    )
  )
);

create policy "tm_v2133_photos_privacy_insert_guard" on public.photos
as restrictive
for insert to authenticated
with check (
  user_id = auth.uid()
  and (
    (memo_id is not null and exists (select 1 from public.memos m where m.id = photos.memo_id and m.user_id = auth.uid()))
    or (trip_id is not null and public.can_write_trip_content(trip_id))
    or (memo_id is null and trip_id is null)
  )
);

create policy "tm_v2133_photos_privacy_update_guard" on public.photos
as restrictive
for update to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

grant execute on function public.current_user_email() to authenticated;
grant execute on function public.can_access_trip(uuid) to authenticated;
grant execute on function public.can_write_trip_content(uuid) to authenticated;

commit;
