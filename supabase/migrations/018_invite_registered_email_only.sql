-- v2.2.1 Invite validation: allow invites only to emails already registered in this Supabase project.
begin;

create or replace function public.registered_user_exists_by_email(p_email text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if v_email = '' or position('@' in v_email) = 0 then
    return false;
  end if;
  return exists (select 1 from auth.users u where lower(u.email) = v_email)
      or exists (select 1 from public.profiles p where lower(coalesce(p.email, '')) = v_email);
end;
$$;

grant execute on function public.registered_user_exists_by_email(text) to authenticated;

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
    raise exception 'รูปแบบอีเมลไม่ถูกต้อง';
  end if;

  if not exists (select 1 from public.trips t where t.id = p_trip_id and (t.user_id = auth.uid() or public.is_admin())) then
    raise exception 'trip not found or not allowed';
  end if;

  select id into v_existing_user
  from auth.users
  where lower(email) = v_email
  limit 1;

  if v_existing_user is null
     and not exists (select 1 from public.profiles p where lower(coalesce(p.email, '')) = v_email) then
    raise exception 'ไม่มีอีเมล์นี้ในระบบ';
  end if;

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

grant execute on function public.create_or_reset_trip_invite(uuid, text, text) to authenticated;

commit;
