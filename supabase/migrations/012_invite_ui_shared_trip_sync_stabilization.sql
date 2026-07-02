-- Travel Memo v2.1.25
-- Invite notification cleanup, shared-trip access stabilization, and sync queue RLS hardening.
-- Safe for Supabase SQL Editor. Does not touch storage.objects.

begin;

alter table public.trip_invites add column if not exists updated_at timestamptz default now();
alter table public.trip_invites add column if not exists created_at timestamptz default now();
alter table public.trip_invites add column if not exists accepted_at timestamptz;
alter table public.trip_invites add column if not exists role text default 'viewer';
alter table public.trip_members add column if not exists email text;
alter table public.trip_members add column if not exists role text not null default 'viewer';
alter table public.trip_members add column if not exists status text not null default 'accepted';
alter table public.trip_members add column if not exists invited_by uuid;
alter table public.trip_members add column if not exists accepted_at timestamptz;
alter table public.trip_members add column if not exists updated_at timestamptz default now();

create or replace function public.current_user_email()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select lower(coalesce((select email from auth.users where id = auth.uid()), ''));
$$;

create or replace function public.is_trip_owner(p_trip_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.trips t
    where t.id = p_trip_id
      and t.user_id = auth.uid()
      and t.deleted_at is null
  );
$$;

create or replace function public.is_trip_member(p_trip_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.trip_members tm
    where tm.trip_id = p_trip_id
      and lower(coalesce(tm.status, 'accepted')) = 'accepted'
      and (
        tm.user_id = auth.uid()
        or lower(coalesce(tm.email, '')) = public.current_user_email()
      )
  ) or exists (
    select 1 from public.trip_invites ti
    where ti.trip_id = p_trip_id
      and lower(coalesce(ti.status, '')) = 'accepted'
      and lower(coalesce(ti.invited_email, '')) = public.current_user_email()
      and (ti.expires_at is null or ti.expires_at > now())
  );
$$;

create or replace function public.can_access_trip(p_trip_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.trips t
    where t.id = p_trip_id
      and t.deleted_at is null
      and (
        t.user_id = auth.uid()
        or public.is_admin()
        or public.is_trip_member(p_trip_id)
      )
  );
$$;

create or replace function public.can_edit_trip(p_trip_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin()
    or public.is_trip_owner(p_trip_id)
    or exists (
      select 1 from public.trip_members tm
      where tm.trip_id = p_trip_id
        and lower(coalesce(tm.status, '')) = 'accepted'
        and lower(coalesce(tm.role, 'viewer')) = 'editor'
        and (tm.user_id = auth.uid() or lower(coalesce(tm.email, '')) = public.current_user_email())
    );
$$;

create or replace function public.can_access_memo(p_memo_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.memos m
    where m.id = p_memo_id
      and m.deleted_at is null
      and (
        m.user_id = auth.uid()
        or public.is_admin()
        or (m.trip_id is not null and public.can_access_trip(m.trip_id))
      )
  );
$$;

create or replace function public.can_access_photo(p_photo_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.photos p
    where p.id = p_photo_id
      and p.deleted_at is null
      and (
        p.user_id = auth.uid()
        or public.is_admin()
        or (p.trip_id is not null and public.can_access_trip(p.trip_id))
        or (p.memo_id is not null and public.can_access_memo(p.memo_id))
      )
  );
$$;

-- Keep select access stable for joined/shared trips.
drop policy if exists "tm_v2125_trips_select_accessible" on public.trips;
create policy "tm_v2125_trips_select_accessible" on public.trips
for select to authenticated
using (public.can_access_trip(id));

drop policy if exists "tm_v2125_memos_select_accessible" on public.memos;
create policy "tm_v2125_memos_select_accessible" on public.memos
for select to authenticated
using (user_id = auth.uid() or public.is_admin() or (trip_id is not null and public.can_access_trip(trip_id)));

drop policy if exists "tm_v2125_photos_select_accessible" on public.photos;
create policy "tm_v2125_photos_select_accessible" on public.photos
for select to authenticated
using (user_id = auth.uid() or public.is_admin() or (trip_id is not null and public.can_access_trip(trip_id)) or (memo_id is not null and public.can_access_memo(memo_id)));

-- Extra owner upsert policies for offline queue records created by the current account.
drop policy if exists "tm_v2125_memos_insert_owner" on public.memos;
create policy "tm_v2125_memos_insert_owner" on public.memos
for insert to authenticated
with check (user_id = auth.uid() or public.is_admin());

drop policy if exists "tm_v2125_memos_update_owner" on public.memos;
create policy "tm_v2125_memos_update_owner" on public.memos
for update to authenticated
using (user_id = auth.uid() or public.is_admin())
with check (user_id = auth.uid() or public.is_admin());

drop policy if exists "tm_v2125_photos_insert_owner" on public.photos;
create policy "tm_v2125_photos_insert_owner" on public.photos
for insert to authenticated
with check (user_id = auth.uid() or public.is_admin());

drop policy if exists "tm_v2125_photos_update_owner" on public.photos;
create policy "tm_v2125_photos_update_owner" on public.photos
for update to authenticated
using (user_id = auth.uid() or public.is_admin())
with check (user_id = auth.uid() or public.is_admin());

-- RPC: accepting an invite always creates/updates trip_members without ON CONFLICT.
create or replace function public.accept_trip_invite(p_invite_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite public.trip_invites%rowtype;
  v_email text := public.current_user_email();
  v_member_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select * into v_invite
  from public.trip_invites
  where id = p_invite_id
    and lower(invited_email) = v_email
    and lower(coalesce(status, 'pending')) in ('pending','accepted')
    and (expires_at is null or expires_at > now())
  limit 1;

  if not found then
    raise exception 'invite not found or not allowed';
  end if;

  update public.trip_invites
  set status = 'accepted', accepted_at = coalesce(accepted_at, now()), updated_at = now()
  where id = p_invite_id;

  select id into v_member_id
  from public.trip_members
  where trip_id = v_invite.trip_id
    and (user_id = auth.uid() or lower(coalesce(email, '')) = v_email)
  limit 1;

  if v_member_id is null then
    insert into public.trip_members (trip_id, user_id, email, role, status, invited_by, accepted_at, created_at, updated_at)
    values (v_invite.trip_id, auth.uid(), v_email, coalesce(v_invite.role, 'viewer'), 'accepted', v_invite.owner_id, now(), now(), now());
  else
    update public.trip_members
    set user_id = auth.uid(),
        email = v_email,
        role = coalesce(v_invite.role, 'viewer'),
        status = 'accepted',
        invited_by = v_invite.owner_id,
        accepted_at = coalesce(accepted_at, now()),
        updated_at = now()
    where id = v_member_id;
  end if;

  return v_invite.trip_id;
end;
$$;

create or replace function public.revoke_trip_invite(p_invite_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite public.trip_invites%rowtype;
  v_user_id uuid;
begin
  select * into v_invite
  from public.trip_invites
  where id = p_invite_id
    and (owner_id = auth.uid() or public.is_admin())
  limit 1;

  if not found then
    raise exception 'invite not found or not allowed';
  end if;

  select u.id into v_user_id from auth.users u where lower(u.email) = lower(v_invite.invited_email) limit 1;
  update public.trip_invites set status = 'revoked', updated_at = now() where id = p_invite_id;
  delete from public.trip_members tm
  where tm.trip_id = v_invite.trip_id
    and ((v_user_id is not null and tm.user_id = v_user_id) or lower(coalesce(tm.email, '')) = lower(v_invite.invited_email));
  return v_invite.trip_id;
end;
$$;

grant execute on function public.accept_trip_invite(uuid) to authenticated;
grant execute on function public.revoke_trip_invite(uuid) to authenticated;
grant execute on function public.can_access_trip(uuid) to authenticated;
grant execute on function public.can_access_memo(uuid) to authenticated;
grant execute on function public.can_access_photo(uuid) to authenticated;

commit;
