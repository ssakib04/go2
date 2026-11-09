-- Go2 migration 1 of 3: tables, indexes, and the auth.users profile trigger.
-- Idempotent. Apply on a Supabase project (auth.users and the standard roles already exist)
-- before 20261109160100_rpcs.sql and 20261109160200_rls.sql.

create schema if not exists extensions;
create schema if not exists private;

-- Supabase installs pgcrypto in the extensions schema. IF NOT EXISTS is a no-op
-- when the extension is already present, including on a hosted project.
create extension if not exists pgcrypto with schema extensions;

comment on schema private is
  'Not exposed through the Data API. Holds host Google refresh tokens and join-token hashes.';

create table if not exists public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  google_id text not null unique,
  email text not null,
  full_name text,
  avatar_url text,
  drive_linked boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references public.users (id) on delete cascade,
  room_name text not null,
  google_drive_folder_id text not null,
  max_photo_limit integer not null default 300,
  current_photo_count integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint rooms_name_len check (char_length(trim(room_name)) between 1 and 80),
  constraint rooms_limit_range check (max_photo_limit between 1 and 10000),
  constraint rooms_count_nonnegative check (current_photo_count >= 0),
  constraint rooms_count_within_limit check (current_photo_count <= max_photo_limit)
);

create table if not exists public.room_members (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  joined_at timestamptz not null default now(),
  photos_uploaded integer not null default 0,
  constraint room_members_room_user_unique unique (room_id, user_id),
  constraint room_members_photos_nonnegative check (photos_uploaded >= 0)
);

create table if not exists public.photo_queue_meta (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  uploader_id uuid not null references public.users (id) on delete cascade,
  drive_file_id text not null,
  file_name text not null,
  idempotency_key text not null,
  uploaded_at timestamptz not null default now(),
  constraint photo_queue_meta_idempotency unique (room_id, idempotency_key)
);

-- Holds the atomic capacity reservation that sits between "slot taken" and
-- "Drive upload finished". Not granted to client roles.
create table if not exists public.photo_slot_reservations (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  uploader_id uuid not null references public.users (id) on delete cascade,
  idempotency_key text not null,
  file_name text not null,
  status text not null default 'reserved',
  created_at timestamptz not null default now(),
  constraint photo_slot_reservations_status check (status in ('reserved', 'uploaded', 'released')),
  constraint photo_slot_reservations_idempotency unique (room_id, idempotency_key)
);

create table if not exists private.host_google_tokens (
  user_id uuid primary key references auth.users (id) on delete cascade,
  refresh_token text not null,
  updated_at timestamptz not null default now(),
  constraint host_google_tokens_present check (char_length(refresh_token) >= 20)
);

create table if not exists private.room_secrets (
  room_id uuid primary key references public.rooms (id) on delete cascade,
  join_token_hash text not null,
  constraint room_secrets_hash_len check (char_length(join_token_hash) = 64)
);

create index if not exists rooms_host_id_idx on public.rooms (host_id);
create index if not exists room_members_user_id_idx on public.room_members (user_id);
create index if not exists photo_queue_meta_room_uploaded_idx
  on public.photo_queue_meta (room_id, uploaded_at desc);
create index if not exists photo_slot_reservations_room_idx
  on public.photo_slot_reservations (room_id);

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.users (id, google_id, email, full_name, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'sub', new.raw_user_meta_data ->> 'provider_id', new.id::text),
    coalesce(new.email, new.raw_user_meta_data ->> 'email', ''),
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture')
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function private.handle_new_user();

revoke all on function private.handle_new_user() from public;
