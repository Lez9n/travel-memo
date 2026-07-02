-- Travel Memo v2.1.22
-- Invite owner controls + Google avatar visibility stabilization.
-- Safe to run after 009_trip_invite_acceptance_notifications.sql. Does not touch storage.objects.

begin;

alter table public.trip_invites add column if not exists updated_at timestamptz default now();
alter table public.trip_members add column if not exists email text;
alter table public.trip_members add column if not exists status text not null default 'accepted';
alter table public.trip_members add column if not exists accepted_at timestamptz;
alter table public.trip_members add column if not exists updated_at timestamptz default now();

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

  select u.id into v_user_id
  from auth.users u
  where lower(u.email) = lower(v_invite.invited_email)
  limit 1;

  update public.trip_invites
  set status = 'pending', updated_at = now()
  where id = p_invite_id;

  delete from public.trip_members tm
  where tm.trip_id = v_invite.trip_id
    and (
      (v_user_id is not null and tm.user_id = v_user_id)
      or lower(coalesce(tm.email, '')) = lower(v_invite.invited_email)
    );

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

  select u.id into v_user_id
  from auth.users u
  where lower(u.email) = lower(v_invite.invited_email)
  limit 1;

  update public.trip_invites
  set status = 'revoked', updated_at = now()
  where id = p_invite_id;

  delete from public.trip_members tm
  where tm.trip_id = v_invite.trip_id
    and (
      (v_user_id is not null and tm.user_id = v_user_id)
      or lower(coalesce(tm.email, '')) = lower(v_invite.invited_email)
    );

  return v_invite.trip_id;
end;
$$;

grant execute on function public.reset_trip_invite_pending(uuid) to authenticated;
grant execute on function public.revoke_trip_invite(uuid) to authenticated;

-- v2.1.22 may have left test invitees as accepted before they explicitly accepted.
-- Reset existing accepted invites back to pending once, and remove matching member rows.
with affected as (
  select ti.id, ti.trip_id, ti.invited_email, u.id as invited_user_id
  from public.trip_invites ti
  left join auth.users u on lower(u.email) = lower(ti.invited_email)
  where lower(coalesce(ti.status, '')) = 'accepted'
)
delete from public.trip_members tm
using affected a
where tm.trip_id = a.trip_id
  and (
    (a.invited_user_id is not null and tm.user_id = a.invited_user_id)
    or lower(coalesce(tm.email, '')) = lower(a.invited_email)
  );

update public.trip_invites
set status = 'pending', updated_at = now()
where lower(coalesce(status, '')) = 'accepted';

-- Keep invitees' Google avatars readable to Trip owners and accepted/pending invite participants.
drop policy if exists "profiles_select_authenticated_identity" on public.profiles;
create policy "profiles_select_authenticated_identity" on public.profiles
  for select to authenticated
  using (true);

commit;
