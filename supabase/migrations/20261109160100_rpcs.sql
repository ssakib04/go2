-- Go2 migration 2 of 3: security-definer RPCs.
-- Bodies live in the private schema (not exposed by the Data API).
-- Public wrappers are security invoker so PostgREST can call them, and they
-- only delegate to the private functions. Grants are applied in migration 3,
-- after the default PUBLIC execute privilege is revoked here.

create or replace function private.sha256_hex(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(extensions.digest(convert_to(p_text, 'utf8'), 'sha256'), 'hex');
$$;

create or replace function private.ensure_user_row(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_meta jsonb;
  v_provider_id text;
  v_identity_email text;
  v_identity_data jsonb;
  v_google_id text;
  v_full_name text;
  v_avatar text;
begin
  select u.email, u.raw_user_meta_data
    into v_email, v_meta
  from auth.users u
  where u.id = p_user_id;

  if not found then
    raise exception 'profile_missing';
  end if;

  select i.provider_id, i.email, i.identity_data
    into v_provider_id, v_identity_email, v_identity_data
  from auth.identities i
  where i.user_id = p_user_id
    and i.provider = 'google'
  limit 1;

  v_google_id := coalesce(v_provider_id, v_meta ->> 'sub', v_meta ->> 'provider_id', p_user_id::text);
  v_full_name := coalesce(
    v_identity_data ->> 'full_name',
    v_identity_data ->> 'name',
    v_meta ->> 'full_name',
    v_meta ->> 'name'
  );
  v_avatar := coalesce(
    v_identity_data ->> 'avatar_url',
    v_identity_data ->> 'picture',
    v_meta ->> 'avatar_url',
    v_meta ->> 'picture'
  );

  insert into public.users (id, google_id, email, full_name, avatar_url)
  values (
    p_user_id,
    v_google_id,
    coalesce(v_identity_email, v_identity_data ->> 'email', v_email, v_meta ->> 'email', ''),
    v_full_name,
    v_avatar
  )
  on conflict (id) do update
    set google_id = excluded.google_id,
        email = excluded.email,
        full_name = coalesce(excluded.full_name, public.users.full_name),
        avatar_url = coalesce(excluded.avatar_url, public.users.avatar_url);
end;
$$;

create or replace function private.ensure_profile()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.users%rowtype;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  perform private.ensure_user_row(v_uid);

  select * into v_row from public.users where id = v_uid;
  return jsonb_build_object(
    'id', v_row.id,
    'google_id', v_row.google_id,
    'email', v_row.email,
    'full_name', v_row.full_name,
    'avatar_url', v_row.avatar_url,
    'drive_linked', v_row.drive_linked,
    'created_at', v_row.created_at
  );
end;
$$;

create or replace function private.is_room_participant(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
    and (
      exists (
        select 1
        from public.rooms r
        where r.id = p_room_id
          and r.host_id = (select auth.uid())
      )
      or exists (
        select 1
        from public.room_members m
        where m.room_id = p_room_id
          and m.user_id = (select auth.uid())
      )
    );
$$;

create or replace function private.create_room_record(
  p_host_id uuid,
  p_room_name text,
  p_folder_id text,
  p_max_photo_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := trim(coalesce(p_room_name, ''));
  v_room_id uuid := gen_random_uuid();
  v_token text;
  v_created timestamptz;
begin
  if p_host_id is null or not exists (select 1 from public.users where id = p_host_id) then
    raise exception 'profile_missing';
  end if;
  if char_length(v_name) < 1 or char_length(v_name) > 80 then
    raise exception 'invalid_room_name';
  end if;
  if p_max_photo_limit is null or p_max_photo_limit < 1 or p_max_photo_limit > 10000 then
    raise exception 'invalid_photo_limit';
  end if;
  if p_folder_id is null or p_folder_id !~ '^[A-Za-z0-9_-]{10,128}$' then
    raise exception 'invalid_folder';
  end if;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');

  insert into public.rooms (
    id, host_id, room_name, google_drive_folder_id, max_photo_limit
  ) values (
    v_room_id, p_host_id, v_name, p_folder_id, p_max_photo_limit
  )
  returning created_at into v_created;

  insert into private.room_secrets (room_id, join_token_hash)
  values (v_room_id, private.sha256_hex(v_token));

  insert into public.room_members (room_id, user_id)
  values (v_room_id, p_host_id);

  return jsonb_build_object(
    'join_token', v_token,
    'room', jsonb_build_object(
      'id', v_room_id,
      'host_id', p_host_id,
      'room_name', v_name,
      'google_drive_folder_id', p_folder_id,
      'max_photo_limit', p_max_photo_limit,
      'current_photo_count', 0,
      'is_active', true,
      'created_at', v_created
    )
  );
end;
$$;

create or replace function private.issue_join_token(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_token text;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  if not exists (
    select 1 from public.rooms r
    where r.id = p_room_id and r.host_id = v_uid
  ) then
    raise exception 'not_host';
  end if;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');

  insert into private.room_secrets (room_id, join_token_hash)
  values (p_room_id, private.sha256_hex(v_token))
  on conflict (room_id) do update
    set join_token_hash = excluded.join_token_hash;

  return jsonb_build_object('token', v_token, 'room_id', p_room_id);
end;
$$;

create or replace function private.join_room(p_room_id uuid, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_room public.rooms%rowtype;
  v_hash text;
  v_stored text;
  v_member public.room_members%rowtype;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  perform private.ensure_user_row(v_uid);

  select * into v_room
  from public.rooms
  where id = p_room_id
  for share;

  if not found then
    raise exception 'room_not_found';
  end if;

  select * into v_member
  from public.room_members
  where room_id = p_room_id and user_id = v_uid;

  if found then
    return jsonb_build_object(
      'status', 'already_member',
      'room_id', p_room_id,
      'user_id', v_uid,
      'photos_uploaded', v_member.photos_uploaded
    );
  end if;

  if p_token is null or char_length(p_token) < 32 then
    raise exception 'invalid_join_token';
  end if;

  v_hash := private.sha256_hex(p_token);
  select s.join_token_hash into v_stored
  from private.room_secrets s
  where s.room_id = p_room_id;

  if v_stored is null or v_hash <> v_stored then
    raise exception 'invalid_join_token';
  end if;

  if not v_room.is_active then
    raise exception 'room_closed';
  end if;

  if v_room.current_photo_count >= v_room.max_photo_limit then
    raise exception 'room_full';
  end if;

  insert into public.room_members (room_id, user_id)
  values (p_room_id, v_uid)
  on conflict (room_id, user_id) do nothing;

  select * into v_member
  from public.room_members
  where room_id = p_room_id and user_id = v_uid;

  return jsonb_build_object(
    'status', 'joined',
    'room_id', p_room_id,
    'user_id', v_uid,
    'photos_uploaded', v_member.photos_uploaded
  );
end;
$$;

create or replace function private.reserve_photo_slot(
  p_room_id uuid,
  p_uploader_id uuid,
  p_idempotency_key text,
  p_file_name text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room public.rooms%rowtype;
  v_existing public.photo_slot_reservations%rowtype;
  v_drive_file_id text;
  v_reservation_id uuid;
  v_has_existing boolean := false;
begin
  if p_uploader_id is null then
    raise exception 'profile_missing';
  end if;
  if p_idempotency_key is null
    or char_length(p_idempotency_key) < 8
    or char_length(p_idempotency_key) > 128 then
    raise exception 'invalid_idempotency_key';
  end if;
  if p_file_name is null
    or char_length(trim(p_file_name)) < 1
    or char_length(p_file_name) > 200 then
    raise exception 'invalid_file_name';
  end if;

  -- Serializes every capacity change for this room.
  select * into v_room
  from public.rooms
  where id = p_room_id
  for update;

  if not found then
    raise exception 'room_not_found';
  end if;

  select * into v_existing
  from public.photo_slot_reservations
  where room_id = p_room_id
    and idempotency_key = p_idempotency_key
  for update;

  v_has_existing := found;

  if v_has_existing then
    if v_existing.uploader_id <> p_uploader_id then
      raise exception 'idempotency_conflict';
    end if;

    if v_existing.status = 'uploaded' then
      select q.drive_file_id into v_drive_file_id
      from public.photo_queue_meta q
      where q.room_id = p_room_id
        and q.idempotency_key = p_idempotency_key;

      return jsonb_build_object(
        'status', 'uploaded',
        'reservation_id', v_existing.id,
        'drive_file_id', v_drive_file_id,
        'host_id', v_room.host_id,
        'google_drive_folder_id', v_room.google_drive_folder_id,
        'current_photo_count', v_room.current_photo_count,
        'max_photo_limit', v_room.max_photo_limit,
        'already_uploaded', true
      );
    end if;

    if v_existing.status = 'reserved' then
      return jsonb_build_object(
        'status', 'reserved',
        'reservation_id', v_existing.id,
        'host_id', v_room.host_id,
        'google_drive_folder_id', v_room.google_drive_folder_id,
        'current_photo_count', v_room.current_photo_count,
        'max_photo_limit', v_room.max_photo_limit,
        'already_reserved', true
      );
    end if;
  end if;

  if not exists (
    select 1
    from public.room_members m
    where m.room_id = p_room_id
      and m.user_id = p_uploader_id
  ) then
    raise exception 'not_a_member';
  end if;

  if not v_room.is_active then
    raise exception 'room_closed';
  end if;

  if v_room.current_photo_count >= v_room.max_photo_limit then
    raise exception 'room_full';
  end if;

  update public.rooms
  set current_photo_count = current_photo_count + 1
  where id = p_room_id;

  update public.room_members
  set photos_uploaded = photos_uploaded + 1
  where room_id = p_room_id
    and user_id = p_uploader_id;

  if v_has_existing then
    update public.photo_slot_reservations
    set status = 'reserved',
        file_name = trim(p_file_name)
    where id = v_existing.id
    returning id into v_reservation_id;
  else
    insert into public.photo_slot_reservations (
      room_id, uploader_id, idempotency_key, file_name, status
    ) values (
      p_room_id, p_uploader_id, p_idempotency_key, trim(p_file_name), 'reserved'
    )
    returning id into v_reservation_id;
  end if;

  return jsonb_build_object(
    'status', 'reserved',
    'reservation_id', v_reservation_id,
    'host_id', v_room.host_id,
    'google_drive_folder_id', v_room.google_drive_folder_id,
    'current_photo_count', v_room.current_photo_count + 1,
    'max_photo_limit', v_room.max_photo_limit,
    'already_reserved', false
  );
end;
$$;

create or replace function private.release_photo_slot(p_reservation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_res public.photo_slot_reservations%rowtype;
begin
  select * into v_res
  from public.photo_slot_reservations
  where id = p_reservation_id
  for update;

  if not found then
    raise exception 'reservation_not_found';
  end if;

  if v_res.status = 'released' then
    return jsonb_build_object('status', 'released', 'idempotent', true);
  end if;

  if v_res.status <> 'reserved' then
    raise exception 'reservation_not_open';
  end if;

  update public.rooms
  set current_photo_count = current_photo_count - 1
  where id = v_res.room_id
    and current_photo_count > 0;

  if not found then
    raise exception 'count_underflow';
  end if;

  update public.room_members
  set photos_uploaded = photos_uploaded - 1
  where room_id = v_res.room_id
    and user_id = v_res.uploader_id
    and photos_uploaded > 0;

  if not found then
    raise exception 'count_underflow';
  end if;

  update public.photo_slot_reservations
  set status = 'released'
  where id = p_reservation_id;

  return jsonb_build_object('status', 'released', 'reservation_id', p_reservation_id);
end;
$$;

create or replace function private.complete_photo_upload(
  p_reservation_id uuid,
  p_drive_file_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_res public.photo_slot_reservations%rowtype;
  v_drive_file_id text;
  v_meta_id uuid;
begin
  select * into v_res
  from public.photo_slot_reservations
  where id = p_reservation_id
  for update;

  if not found then
    raise exception 'reservation_not_found';
  end if;

  if v_res.status = 'uploaded' then
    select q.drive_file_id into v_drive_file_id
    from public.photo_queue_meta q
    where q.room_id = v_res.room_id
      and q.idempotency_key = v_res.idempotency_key;

    return jsonb_build_object(
      'status', 'uploaded',
      'reservation_id', v_res.id,
      'drive_file_id', v_drive_file_id,
      'already_uploaded', true
    );
  end if;

  if v_res.status <> 'reserved' then
    raise exception 'reservation_not_open';
  end if;

  if p_drive_file_id is null or p_drive_file_id !~ '^[A-Za-z0-9_-]{10,128}$' then
    raise exception 'invalid_drive_file';
  end if;

  insert into public.photo_queue_meta (
    room_id, uploader_id, drive_file_id, file_name, idempotency_key
  ) values (
    v_res.room_id, v_res.uploader_id, p_drive_file_id, v_res.file_name, v_res.idempotency_key
  )
  returning id into v_meta_id;

  update public.photo_slot_reservations
  set status = 'uploaded'
  where id = v_res.id;

  return jsonb_build_object(
    'status', 'uploaded',
    'reservation_id', v_res.id,
    'photo_id', v_meta_id,
    'drive_file_id', p_drive_file_id,
    'already_uploaded', false
  );
end;
$$;

create or replace function private.store_host_refresh_token(
  p_user_id uuid,
  p_refresh_token text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user_id is null or not exists (select 1 from public.users where id = p_user_id) then
    raise exception 'profile_missing';
  end if;
  if p_refresh_token is null or char_length(p_refresh_token) < 20 then
    raise exception 'invalid_refresh_token';
  end if;

  insert into private.host_google_tokens (user_id, refresh_token)
  values (p_user_id, p_refresh_token)
  on conflict (user_id) do update
    set refresh_token = excluded.refresh_token,
        updated_at = now();

  update public.users
  set drive_linked = true
  where id = p_user_id;
end;
$$;

create or replace function private.get_host_refresh_token(p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text;
begin
  select t.refresh_token into v_token
  from private.host_google_tokens t
  where t.user_id = p_user_id;
  return v_token;
end;
$$;

-- Public, security-invoker wrappers. PostgREST only exposes public.

create or replace function public.ensure_profile()
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.ensure_profile();
$$;

create or replace function public.issue_join_token(p_room_id uuid)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.issue_join_token(p_room_id);
$$;

create or replace function public.join_room(p_room_id uuid, p_token text)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.join_room(p_room_id, p_token);
$$;

create or replace function public.create_room_record(
  p_host_id uuid,
  p_room_name text,
  p_folder_id text,
  p_max_photo_limit integer
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.create_room_record(p_host_id, p_room_name, p_folder_id, p_max_photo_limit);
$$;

create or replace function public.reserve_photo_slot(
  p_room_id uuid,
  p_uploader_id uuid,
  p_idempotency_key text,
  p_file_name text
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.reserve_photo_slot(p_room_id, p_uploader_id, p_idempotency_key, p_file_name);
$$;

create or replace function public.release_photo_slot(p_reservation_id uuid)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.release_photo_slot(p_reservation_id);
$$;

create or replace function public.complete_photo_upload(
  p_reservation_id uuid,
  p_drive_file_id text
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.complete_photo_upload(p_reservation_id, p_drive_file_id);
$$;

create or replace function public.store_host_refresh_token(
  p_user_id uuid,
  p_refresh_token text
)
returns void
language sql
security invoker
set search_path = ''
as $$
  select private.store_host_refresh_token(p_user_id, p_refresh_token);
$$;

create or replace function public.get_host_refresh_token(p_user_id uuid)
returns text
language sql
security invoker
set search_path = ''
as $$
  select private.get_host_refresh_token(p_user_id);
$$;

-- Drop the default PUBLIC execute grant immediately. Migration 3 re-grants
-- only the roles that should call each function.
do $$
declare
  r record;
begin
  for r in
    select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and p.proname in (
        'sha256_hex',
        'ensure_user_row',
        'ensure_profile',
        'is_room_participant',
        'create_room_record',
        'issue_join_token',
        'join_room',
        'reserve_photo_slot',
        'release_photo_slot',
        'complete_photo_upload',
        'store_host_refresh_token',
        'get_host_refresh_token',
        'handle_new_user'
      )
  loop
    execute format(
      'revoke all on function %I.%I(%s) from public',
      r.nspname,
      r.proname,
      r.args
    );
  end loop;
end $$;
