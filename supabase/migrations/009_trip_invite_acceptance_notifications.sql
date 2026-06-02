-- Travel Memo v2.1.22
-- Invite acceptance notifications + shared trip membership stabilization.
-- Safe to run after v2.1.19/2.1.20 migrations. Does not touch storage.objects.

begin;

create table if not exists public.trip_members (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  email text,
  role text not null default 'viewer',
  status text not null default 'accepted',
  invited_by uuid references auth.users(id) on delete set null,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (trip_id, user_id)
);

alter table public.trip_invites add column if not exists expires_at timestamptz;
alter table public.trip_invites add column if not exists updated_at timestamptz default now();
alter table public.trip_invites add column if not exists created_at timestamptz default now();
alter table public.trip_members add column if not exists email text;
alter table public.trip_members add column if not exists role text not null default 'viewer';
alter table public.trip_members add column if not exists status text not null default 'accepted';
alter table public.trip_members add column if not exists invited_by uuid references auth.users(id) on delete set null;
alter table public.trip_members add column if not exists accepted_at timestamptz;
alter table public.trip_members add column if not exists updated_at timestamptz default now();

create index if not exists trip_invites_email_status_idx on public.trip_invites(lower(invited_email), status);
create index if not exists trip_invites_trip_idx on public.trip_invites(trip_id);
create index if not exists trip_members_trip_idx on public.trip_members(trip_id);
create index if not exists trip_members_user_idx on public.trip_members(user_id);
create index if not exists trip_members_email_idx on public.trip_members(lower(email));

alter table public.trip_invites enable row level security;
alter table public.trip_members enable row level security;

create or replace function public.current_user_email()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select lower(email) from auth.users where id = (select auth.uid());
$$;

create or replace function public.accept_trip_invite(p_invite_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite public.trip_invites%rowtype;
begin
  select * into v_invite
  from public.trip_invites
  where id = p_invite_id
    and lower(invited_email) = public.current_user_email()
    and status in ('pending','accepted')
    and (expires_at is null or expires_at > now())
  limit 1;

  if not found then
    raise exception 'invite not found or not allowed';
  end if;

  update public.trip_invites
  set status = 'accepted', updated_at = now()
  where id = p_invite_id;

  insert into public.trip_members (trip_id, user_id, email, role, status, invited_by, accepted_at, created_at, updated_at)
  values (v_invite.trip_id, auth.uid(), public.current_user_email(), coalesce(v_invite.role, 'viewer'), 'accepted', v_invite.owner_id, now(), now(), now())
  on conflict (trip_id, user_id) do update
    set email = excluded.email,
        role = excluded.role,
        status = 'accepted',
        invited_by = excluded.invited_by,
        accepted_at = coalesce(public.trip_members.accepted_at, now()),
        updated_at = now();

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
begin
  update public.trip_invites
  set status = 'revoked', updated_at = now()
  where id = p_invite_id
    and lower(invited_email) = public.current_user_email()
    and status in ('pending','accepted')
  returning trip_id into v_trip_id;

  if v_trip_id is null then
    raise exception 'invite not found or not allowed';
  end if;

  update public.trip_members
  set status = 'revoked', updated_at = now()
  where trip_id = v_trip_id
    and (user_id = auth.uid() or lower(email) = public.current_user_email());

  return v_trip_id;
end;
$$;

grant execute on function public.accept_trip_invite(uuid) to authenticated;
grant execute on function public.decline_trip_invite(uuid) to authenticated;

-- Policies: owners can manage invites; invitees can read and accept/decline their own invitation.
drop policy if exists "trip_invites_select_related" on public.trip_invites;
create policy "trip_invites_select_related" on public.trip_invites
  for select to authenticated
  using (owner_id = auth.uid() or lower(invited_email) = public.current_user_email() or public.is_admin());

drop policy if exists "trip_invites_insert_owner" on public.trip_invites;
create policy "trip_invites_insert_owner" on public.trip_invites
  for insert to authenticated
  with check (owner_id = auth.uid() and exists (select 1 from public.trips t where t.id = trip_id and t.user_id = auth.uid()));

drop policy if exists "trip_invites_update_owner" on public.trip_invites;
drop policy if exists "trip_invites_update_owner_or_invitee" on public.trip_invites;
create policy "trip_invites_update_owner_or_invitee" on public.trip_invites
  for update to authenticated
  using (owner_id = auth.uid() or lower(invited_email) = public.current_user_email() or public.is_admin())
  with check (owner_id = auth.uid() or lower(invited_email) = public.current_user_email() or public.is_admin());

-- Members are visible to trip owners, invited members, and admins.
drop policy if exists "trip_members_select_related" on public.trip_members;
create policy "trip_members_select_related" on public.trip_members
  for select to authenticated
  using (user_id = auth.uid() or lower(email) = public.current_user_email() or public.is_trip_owner(trip_id) or public.is_admin());

-- Authenticated users may see basic profile cards so Trip owners can show invited Google avatars.
-- This exposes only profile table fields already intended for in-app identity display.
drop policy if exists "profiles_select_own_or_admin" on public.profiles;
drop policy if exists "profiles_select_own_or_admin_or_shared" on public.profiles;
drop policy if exists "profiles_select_authenticated_identity" on public.profiles;
create policy "profiles_select_authenticated_identity" on public.profiles
  for select to authenticated
  using (true);

commit;
