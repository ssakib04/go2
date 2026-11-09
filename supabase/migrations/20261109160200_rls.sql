-- Go2 migration 3 of 3: grants, row level security, realtime.
-- Idempotent.

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema private to authenticated, service_role;
grant usage on schema extensions to postgres, service_role;

revoke all on table public.users from public, anon;
revoke all on table public.rooms from public, anon;
revoke all on table public.room_members from public, anon;
revoke all on table public.photo_queue_meta from public, anon;
revoke all on table public.photo_slot_reservations from public, anon;
revoke all on table private.host_google_tokens from public, anon, authenticated;
revoke all on table private.room_secrets from public, anon, authenticated;

grant select on public.users to authenticated;
grant select on public.rooms to authenticated;
grant update (is_active) on public.rooms to authenticated;
grant select on public.room_members to authenticated;
grant select on public.photo_queue_meta to authenticated;

grant select, insert, update, delete on public.users to service_role;
grant select, insert, update, delete on public.rooms to service_role;
grant select, insert, update, delete on public.room_members to service_role;
grant select, insert, update, delete on public.photo_queue_meta to service_role;
grant select, insert, update, delete on public.photo_slot_reservations to service_role;
grant select, insert, update, delete on private.host_google_tokens to service_role;
grant select, insert, update, delete on private.room_secrets to service_role;

-- Client-callable. These check auth.uid() inside the definer body.
grant execute on function public.ensure_profile() to authenticated;
grant execute on function private.ensure_profile() to authenticated;
grant execute on function public.issue_join_token(uuid) to authenticated;
grant execute on function private.issue_join_token(uuid) to authenticated;
grant execute on function public.join_room(uuid, text) to authenticated;
grant execute on function private.join_room(uuid, text) to authenticated;
grant execute on function private.is_room_participant(uuid) to authenticated, service_role;
-- ensure_user_row is only called from security-definer functions. Do not grant it
-- to authenticated; a direct call could rewrite another user's profile.

-- Service role only. Guests and hosts must not call these directly:
-- they would be able to mint rooms, burn capacity, or read refresh tokens.
grant execute on function public.create_room_record(uuid, text, text, integer) to service_role;
grant execute on function private.create_room_record(uuid, text, text, integer) to service_role;
grant execute on function public.reserve_photo_slot(uuid, uuid, text, text) to service_role;
grant execute on function private.reserve_photo_slot(uuid, uuid, text, text) to service_role;
grant execute on function public.release_photo_slot(uuid) to service_role;
grant execute on function private.release_photo_slot(uuid) to service_role;
grant execute on function public.complete_photo_upload(uuid, text) to service_role;
grant execute on function private.complete_photo_upload(uuid, text) to service_role;
grant execute on function public.store_host_refresh_token(uuid, text) to service_role;
grant execute on function private.store_host_refresh_token(uuid, text) to service_role;
grant execute on function public.get_host_refresh_token(uuid) to service_role;
grant execute on function private.get_host_refresh_token(uuid) to service_role;
grant execute on function private.sha256_hex(text) to service_role;

alter table public.users enable row level security;
alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.photo_queue_meta enable row level security;
alter table public.photo_slot_reservations enable row level security;
alter table private.host_google_tokens enable row level security;
alter table private.room_secrets enable row level security;

drop policy if exists users_select_visible on public.users;
create policy users_select_visible
  on public.users
  for select
  to authenticated
  using (
    id = (select auth.uid())
    or exists (
      select 1
      from public.room_members m
      where m.user_id = public.users.id
        and (select private.is_room_participant(m.room_id))
    )
  );

drop policy if exists rooms_select_participant on public.rooms;
create policy rooms_select_participant
  on public.rooms
  for select
  to authenticated
  using ((select private.is_room_participant(id)));

drop policy if exists rooms_update_active on public.rooms;
create policy rooms_update_active
  on public.rooms
  for update
  to authenticated
  using (host_id = (select auth.uid()))
  with check (host_id = (select auth.uid()));

drop policy if exists room_members_select_participant on public.room_members;
create policy room_members_select_participant
  on public.room_members
  for select
  to authenticated
  using ((select private.is_room_participant(room_id)));

drop policy if exists photo_queue_meta_select_participant on public.photo_queue_meta;
create policy photo_queue_meta_select_participant
  on public.photo_queue_meta
  for select
  to authenticated
  using ((select private.is_room_participant(room_id)));

-- No policies on photo_slot_reservations, host_google_tokens, or room_secrets.
-- Combined with the grants above, authenticated and anon cannot read them.
-- Privileged writes go through security-definer functions owned by the migration role.

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'rooms'
    ) then
      alter publication supabase_realtime add table public.rooms;
    end if;

    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'room_members'
    ) then
      alter publication supabase_realtime add table public.room_members;
    end if;
  end if;
end $$;
