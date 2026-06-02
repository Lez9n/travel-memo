-- Travel Memo v2.1.24
-- Invite conflict fix, pending reset, trip-title notifications, and member avatar stabilization.
-- Safe to run after v2.1.22. Does not touch storage.objects.

begin;

alter table public.trip_invites add column if not exists updated_at timestamptz default now();
alter table public.trip_invites add column if not exists created_at timestamptz default now();
alter table public.trip_invites add column if not exists accepted_at timestamptz;
alter table public.trip_invites add column if not exists role text default 'viewer';
alter table public.trip_members add column if not exists email text;
alter table public.trip_members add column if not exists role text not null default 'viewer';
alter table public.trip_members add column if not exists status text not null default 'accepted';
alter table public.trip_members add column if not exists invited_by uuid references auth.users(id) on delete set null;
alter table public.trip_members add column if not exists accepted_at timestamptz;
alter table public.trip_members add column if not exists updated_at timestamptz default now();

-- Remove exact duplicate invite rows so owners can re-invite the same email without ON CONFLICT errors.
with ranked_invites as (
  select id,
         row_number() over (
           partition by trip_id, lower(invited_email)
           order by coalesce(updated_at, created_at) desc nulls last, created_at desc nulls last, id desc
         ) as rn
  from public.trip_invites
  where invited_email is not null
)
delete from public.trip_invites ti
using ranked_invites r
where ti.id = r.id and r.rn > 1;

-- Remove duplicate active member rows for the same trip/user.
with ranked_members as (
  select id,
         row_number() over (
           partition by trip_id, user_id
           order by coalesce(updated_at, accepted_at, created_at) desc nulls last, id desc
         ) as rn
  from public.trip_members
  where user_id is not null
)
delete from public.trip_members tm
using ranked_members r
where tm.id = r.id and r.rn > 1;

create unique index if not exists trip_invites_trip_email_unique_idx
  on public.trip_invites (trip_id, lower(invited_email));

create unique index if not exists trip_members_trip_user_unique_idx
  on public.trip_members (trip_id, user_id)
  where user_id is not null;

create index if not exists trip_members_trip_email_idx
  on public.trip_members (trip_id, lower(email));

-- Current bug cleanup: accepted invites that were never actually accepted by the invitee
-- should go back to pending and lose member access until the user presses Join.
with broken_accepted as (
  select ti.id, ti.trip_id, ti.invited_email, u.id as invited_user_id
  from public.trip_invites ti
  left join auth.users u on lower(u.email) = lower(ti.invited_email)
  where lower(coalesce(ti.status, '')) = 'accepted'
    and ti.accepted_at is null
)
delete from public.trip_members tm
using broken_accepted b
where tm.trip_id = b.trip_id
  and (
    (b.invited_user_id is not null and tm.user_id = b.invited_user_id)
    or lower(coalesce(tm.email, '')) = lower(b.invited_email)
  );

update public.trip_invites
set status = 'pending', updated_at = now()
where lower(coalesce(status, '')) = 'accepted'
  and accepted_at is null;

create or replace function public.create_or_reset_trip_invite(
  p_trip_id uuid,
  p_invited_email text,
  p_role text default 'viewer'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(trim(p_invited_email));
  v_invite_id uuid;
  v_existing_user uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if v_email is null or v_email = '' or position('@' in v_email) = 0 then
    raise exception 'invalid invited email';
  end if;

  if not exists (select 1 from public.trips t where t.id = p_trip_id and (t.user_id = auth.uid() or public.is_admin())) then
    raise exception 'trip not found or not allowed';
  end if;

  select id into v_existing_user
  from auth.users
  where lower(email) = v_email
  limit 1;

  select id into v_invite_id
  from public.trip_invites
  where trip_id = p_trip_id and lower(invited_email) = v_email
  limit 1;

  if v_invite_id is null then
    insert into public.trip_invites (trip_id, owner_id, invited_email, role, status, created_at, updated_at, accepted_at)
    values (p_trip_id, auth.uid(), v_email, coalesce(nullif(p_role, ''), 'viewer'), 'pending', now(), now(), null)
    returning id into v_invite_id;
  else
    update public.trip_invites
    set owner_id = auth.uid(),
        role = coalesce(nullif(p_role, ''), 'viewer'),
        status = 'pending',
        accepted_at = null,
        updated_at = now()
    where id = v_invite_id;
  end if;

  delete from public.trip_members tm
  where tm.trip_id = p_trip_id
    and (
      (v_existing_user is not null and tm.user_id = v_existing_user)
      or lower(coalesce(tm.email, '')) = v_email
    );

  return v_invite_id;
end;
$$;

create or replace function public.accept_trip_invite(p_invite_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite public.trip_invites%rowtype;
  v_email text;
  v_member_id uuid;
begin
  v_email := public.current_user_email();

  select * into v_invite
  from public.trip_invites
  where id = p_invite_id
    and lower(invited_email) = v_email
    and status in ('pending','accepted')
    and (expires_at is null or expires_at > now())
  limit 1;

  if not found then
    raise exception 'invite not found or not allowed';
  end if;

  update public.trip_invites
  set status = 'accepted', accepted_at = now(), updated_at = now()
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

create or replace function public.decline_trip_invite(p_invite_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trip_id uuid;
  v_email text := public.current_user_email();
begin
  update public.trip_invites
  set status = 'declined', updated_at = now()
  where id = p_invite_id
    and lower(invited_email) = v_email
    and status in ('pending','accepted')
  returning trip_id into v_trip_id;

  if v_trip_id is null then
    raise exception 'invite not found or not allowed';
  end if;

  delete from public.trip_members tm
  where tm.trip_id = v_trip_id
    and (tm.user_id = auth.uid() or lower(coalesce(tm.email, '')) = v_email);

  return v_trip_id;
end;
$$;

create or replace function public.reset_trip_invite_pending(p_invite_id uuid)
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

  update public.trip_invites
  set status = 'pending', accepted_at = null, updated_at = now()
  where id = p_invite_id;

  delete from public.trip_members tm
  where tm.trip_id = v_invite.trip_id
    and ((v_user_id is not null and tm.user_id = v_user_id) or lower(coalesce(tm.email, '')) = lower(v_invite.invited_email));

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

create or replace function public.list_my_trip_invites()
returns table (
  id uuid,
  trip_id uuid,
  owner_id uuid,
  invited_email text,
  role text,
  status text,
  created_at timestamptz,
  updated_at timestamptz,
  expires_at timestamptz,
  trip_title text,
  owner_email text,
  owner_name text,
  owner_avatar_url text
)
language sql
security definer
set search_path = public
as $$
  select
    ti.id,
    ti.trip_id,
    ti.owner_id,
    ti.invited_email,
    ti.role,
    ti.status,
    ti.created_at,
    ti.updated_at,
    ti.expires_at,
    coalesce(t.title, 'Trip ที่มีคนเชิญคุณ') as trip_title,
    p.email as owner_email,
    p.display_name as owner_name,
    p.avatar_url as owner_avatar_url
  from public.trip_invites ti
  left join public.trips t on t.id = ti.trip_id
  left join public.profiles p on p.id = ti.owner_id
  where lower(ti.invited_email) = public.current_user_email()
    and ti.status in ('pending','accepted')
    and (ti.expires_at is null or ti.expires_at > now())
  order by ti.updated_at desc nulls last, ti.created_at desc nulls last;
$$;

grant execute on function public.create_or_reset_trip_invite(uuid, text, text) to authenticated;
grant execute on function public.accept_trip_invite(uuid) to authenticated;
grant execute on function public.decline_trip_invite(uuid) to authenticated;
grant execute on function public.reset_trip_invite_pending(uuid) to authenticated;
grant execute on function public.revoke_trip_invite(uuid) to authenticated;
grant execute on function public.list_my_trip_invites() to authenticated;

-- Make profile identity readable so invited Google avatars can be shown inside Trip detail.
drop policy if exists "profiles_select_authenticated_identity" on public.profiles;
create policy "profiles_select_authenticated_identity" on public.profiles
  for select to authenticated
  using (true);

commit;
