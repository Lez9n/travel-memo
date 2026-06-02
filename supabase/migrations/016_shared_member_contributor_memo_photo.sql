-- Travel Memo v2.1.32
-- Allow accepted/shared Trip members to add their own Memo and Photos into a shared Trip.
-- Keeps ownership safe: members can only write their own memos/photos, not owner records.

begin;

alter table public.memos enable row level security;
alter table public.photos enable row level security;
alter table public.trip_members enable row level security;
alter table public.trip_invites enable row level security;

-- Helper may already exist from v2.1.30. Re-create safely for projects that skipped prior migration.
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

-- Keep owner policies from previous migrations and add member-contributor policies.
drop policy if exists "tm_v2132_memos_member_insert" on public.memos;
drop policy if exists "tm_v2132_memos_member_update_own" on public.memos;
drop policy if exists "tm_v2132_memos_member_delete_own" on public.memos;
drop policy if exists "tm_v2132_photos_member_insert" on public.photos;
drop policy if exists "tm_v2132_photos_member_update_own" on public.photos;
drop policy if exists "tm_v2132_photos_member_delete_own" on public.photos;

create policy "tm_v2132_memos_member_insert" on public.memos
for insert to authenticated
with check (
  user_id = auth.uid()
  and (
    trip_id is null
    or public.can_write_trip_content(trip_id)
  )
);

create policy "tm_v2132_memos_member_update_own" on public.memos
for update to authenticated
using (user_id = auth.uid())
with check (
  user_id = auth.uid()
  and (
    trip_id is null
    or public.can_write_trip_content(trip_id)
  )
);

create policy "tm_v2132_memos_member_delete_own" on public.memos
for delete to authenticated
using (user_id = auth.uid());

create policy "tm_v2132_photos_member_insert" on public.photos
for insert to authenticated
with check (
  user_id = auth.uid()
  and (
    memo_id is null
    or exists (select 1 from public.memos m where m.id = photos.memo_id and m.user_id = auth.uid())
    or (trip_id is not null and public.can_write_trip_content(trip_id))
  )
);

create policy "tm_v2132_photos_member_update_own" on public.photos
for update to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

create policy "tm_v2132_photos_member_delete_own" on public.photos
for delete to authenticated
using (user_id = auth.uid());

grant execute on function public.current_user_email() to authenticated;
grant execute on function public.can_access_trip(uuid) to authenticated;
grant execute on function public.can_write_trip_content(uuid) to authenticated;

commit;
