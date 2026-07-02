-- Travel Memo v2.1.27
-- Shared trip bundle v2: make joined members see Trip Memo / Photo content reliably.
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

create or replace function public.get_trip_shared_bundle_v2(p_trip_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_allowed boolean := false;
  v_trip jsonb := null;
  v_memos jsonb := '[]'::jsonb;
  v_photos jsonb := '[]'::jsonb;
  v_invites jsonb := '[]'::jsonb;
  v_members jsonb := '[]'::jsonb;
  v_profiles jsonb := '[]'::jsonb;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  if v_email = '' then
    select lower(coalesce(email, '')) into v_email from auth.users where id = v_uid;
  end if;

  select exists (
    select 1
    from public.trips t
    where t.id = p_trip_id
      and t.deleted_at is null
      and (
        t.user_id = v_uid
        or exists (
          select 1 from public.trip_members tm
          where tm.trip_id = t.id
            and lower(coalesce(tm.status, 'accepted')) = 'accepted'
            and (tm.user_id = v_uid or lower(coalesce(tm.email, '')) = v_email)
        )
        or exists (
          select 1 from public.trip_invites ti
          where ti.trip_id = t.id
            and lower(coalesce(ti.status, '')) = 'accepted'
            and lower(coalesce(ti.invited_email, '')) = v_email
            and (ti.expires_at is null or ti.expires_at > now())
        )
      )
  ) into v_allowed;

  if not coalesce(v_allowed, false) then
    raise exception 'trip not found or not allowed';
  end if;

  select to_jsonb(t) into v_trip
  from public.trips t
  where t.id = p_trip_id and t.deleted_at is null
  limit 1;

  select coalesce(jsonb_agg(to_jsonb(m) order by m.visited_at desc nulls last, m.created_at desc nulls last), '[]'::jsonb)
  into v_memos
  from public.memos m
  where m.trip_id = p_trip_id
    and m.deleted_at is null;

  select coalesce(jsonb_agg(to_jsonb(p) order by p.created_at desc nulls last), '[]'::jsonb)
  into v_photos
  from public.photos p
  where p.deleted_at is null
    and (
      p.trip_id = p_trip_id
      or exists (
        select 1 from public.memos m
        where m.id = p.memo_id
          and m.trip_id = p_trip_id
          and m.deleted_at is null
      )
    );

  select coalesce(jsonb_agg(to_jsonb(ti) order by ti.updated_at desc nulls last, ti.created_at desc nulls last), '[]'::jsonb)
  into v_invites
  from public.trip_invites ti
  where ti.trip_id = p_trip_id
    and lower(coalesce(ti.status, '')) not in ('revoked', 'declined');

  select coalesce(jsonb_agg(to_jsonb(tm) order by tm.updated_at desc nulls last, tm.accepted_at desc nulls last), '[]'::jsonb)
  into v_members
  from public.trip_members tm
  where tm.trip_id = p_trip_id
    and lower(coalesce(tm.status, 'accepted')) = 'accepted';

  with people as (
    select t.user_id as id, null::text as email from public.trips t where t.id = p_trip_id
    union
    select m.user_id, null::text from public.memos m where m.trip_id = p_trip_id and m.deleted_at is null
    union
    select p.user_id, null::text from public.photos p where p.trip_id = p_trip_id and p.deleted_at is null
    union
    select tm.user_id, lower(tm.email) from public.trip_members tm where tm.trip_id = p_trip_id
    union
    select ti.owner_id, lower(ti.invited_email) from public.trip_invites ti where ti.trip_id = p_trip_id
  )
  select coalesce(jsonb_agg(distinct to_jsonb(pr)), '[]'::jsonb)
  into v_profiles
  from public.profiles pr
  where pr.id in (select id from people where id is not null)
     or lower(coalesce(pr.email, '')) in (select email from people where email is not null);

  return jsonb_build_object(
    'trip', v_trip,
    'memos', v_memos,
    'photos', v_photos,
    'invites', v_invites,
    'members', v_members,
    'profiles', v_profiles
  );
end;
$$;

grant execute on function public.get_trip_shared_bundle_v2(uuid) to authenticated;

commit;
