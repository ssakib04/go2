import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";

const migrationsDir = path.resolve("supabase/migrations");

function clientConfig(): ConstructorParameters<typeof Client>[0] {
  if (process.env.DATABASE_URL) return { connectionString: process.env.DATABASE_URL };
  return {
    host: process.env.PGHOST ?? "/var/run/postgresql",
    database: process.env.PGDATABASE ?? "go2_test",
    user: process.env.PGUSER,
  };
}

const PRELUDE = `
drop schema if exists private cascade;
drop schema if exists public cascade;
drop schema if exists extensions cascade;
drop schema if exists auth cascade;

create schema public;
grant all on schema public to public;
create schema auth;

do $$
begin
  create role anon nologin;
exception when duplicate_object then null;
end $$;
do $$
begin
  create role authenticated nologin;
exception when duplicate_object then null;
end $$;
do $$
begin
  create role service_role nologin;
exception when duplicate_object then null;
end $$;

create table auth.users (
  id uuid primary key,
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb
);

create table auth.identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null,
  provider_id text not null,
  identity_data jsonb not null default '{}'::jsonb,
  email text
);

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
`;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function applyMigrations(client: Client): Promise<void> {
  const files = readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort();
  assert(files.length === 3, `expected 3 migrations, found ${files.join(", ")}`);
  for (const file of files) {
    const sql = readFileSync(path.join(migrationsDir, file), "utf8");
    await client.query(sql);
  }
}

async function asUser<T>(client: Client, userId: string, fn: () => Promise<T>): Promise<T> {
  await client.query("begin");
  try {
    await client.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
    await client.query("set local role authenticated");
    const result = await fn();
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

async function expectError(fn: () => Promise<unknown>, needle: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(message.toLowerCase().includes(needle.toLowerCase()), `expected "${needle}" in "${message}"`);
    return;
  }
  throw new Error(`expected error containing ${needle}`);
}

async function main(): Promise<void> {
  const client = new Client(clientConfig());
  await client.connect();
  try {
    await client.query(PRELUDE);
    await applyMigrations(client);
    await applyMigrations(client);

    const hash = await client.query<{ sha256_hex: string }>(
      "select private.sha256_hex('abc') as sha256_hex",
    );
    assert(
      hash.rows[0]?.sha256_hex === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      "sha256 vector mismatch",
    );

    const hostId = "11111111-1111-4111-8111-111111111111";
    const guestId = "22222222-2222-4222-8222-222222222222";
    const strangerId = "33333333-3333-4333-8333-333333333333";

    await client.query(
      `insert into auth.users (id, email, raw_user_meta_data) values
        ($1, 'host@example.com', '{"sub":"g-host","full_name":"Host User","email":"host@example.com"}'),
        ($2, 'guest@example.com', '{"sub":"g-guest","full_name":"Guest User","email":"guest@example.com"}'),
        ($3, 'stranger@example.com', '{"sub":"g-stranger","full_name":"Stranger","email":"stranger@example.com"}')`,
      [hostId, guestId, strangerId],
    );

    const hostRow = await client.query<{ google_id: string }>(
      "select google_id from public.users where id = $1",
      [hostId],
    );
    assert(hostRow.rows[0]?.google_id === "g-host", "trigger did not copy google id");

    await client.query(
      `insert into auth.identities (user_id, provider, provider_id, identity_data, email)
       values ($1, 'google', 'g-host-real', '{"name":"Host From Identity"}', 'host@example.com')`,
      [hostId],
    );
    const profile = await asUser(client, hostId, async () => {
      const result = await client.query<{ ensure_profile: { google_id: string; full_name: string } }>(
        "select public.ensure_profile() as ensure_profile",
      );
      return result.rows[0]?.ensure_profile;
    });
    assert(profile?.google_id === "g-host-real", "ensure_profile should prefer the identity provider id");
    assert(profile?.full_name === "Host From Identity", "ensure_profile should read the identity name");

    await client.query("select public.store_host_refresh_token($1, $2)", [
      hostId,
      "refresh-token-value-1234567890",
    ]);

    const created = await client.query<{
      create_room_record: {
        join_token: string;
        room: { id: string; max_photo_limit: number; current_photo_count: number };
      };
    }>(
      "select public.create_room_record($1, $2, $3, $4) as create_room_record",
      [hostId, "Beach Day", "folderABCDE12345", 2],
    );
    const room = created.rows[0]?.create_room_record;
    assert(room?.join_token && room.join_token.length === 64, "join token should be 32 bytes of hex");
    const roomId = room.room.id;

    const secretVisible = await client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'rooms' and column_name = 'join_token_hash'`,
    );
    assert(secretVisible.rowCount === 0, "join token hash must not live on public.rooms");

    await asUser(client, guestId, async () => {
      const joined = await client.query<{ join_room: { status: string } }>(
        "select public.join_room($1, $2) as join_room",
        [roomId, room.join_token],
      );
      assert(joined.rows[0]?.join_room.status === "joined", "guest should join");
    });

    await client.query("begin");
    await client.query("select set_config('request.jwt.claim.sub', $1, true)", [strangerId]);
    await client.query("set local role authenticated");
    await expectError(
      () => client.query("select public.join_room($1, $2)", [roomId, "not-the-token-not-the-token-not-token"]),
      "invalid_join_token",
    );
    await client.query("rollback");

    await client.query("begin");
    await client.query("select set_config('request.jwt.claim.sub', $1, true)", [guestId]);
    await client.query("set local role authenticated");
    await expectError(
      () => client.query("select public.get_host_refresh_token($1)", [hostId]),
      "permission denied",
    );
    await client.query("rollback");

    await client.query("begin");
    await client.query("select set_config('request.jwt.claim.sub', $1, true)", [guestId]);
    await client.query("set local role authenticated");
    await expectError(
      () => client.query("select public.reserve_photo_slot($1, $2, $3, $4)", [roomId, guestId, "guest-key-1", "a.jpg"]),
      "permission denied",
    );
    await client.query("rollback");

    await client.query("begin");
    await client.query("set local role authenticated");
    await expectError(
      () => client.query("select refresh_token from private.host_google_tokens"),
      "permission denied",
    );
    await client.query("rollback");

    await client.query("set role service_role");
    const first = await client.query<{ reserve_photo_slot: { reservation_id: string; current_photo_count: number } }>(
      "select public.reserve_photo_slot($1, $2, $3, $4) as reserve_photo_slot",
      [roomId, guestId, "idem-0001", "a.jpg"],
    );
    const again = await client.query<{ reserve_photo_slot: { already_reserved: boolean; current_photo_count: number } }>(
      "select public.reserve_photo_slot($1, $2, $3, $4) as reserve_photo_slot",
      [roomId, guestId, "idem-0001", "a.jpg"],
    );
    await client.query("reset role");
    assert(again.rows[0]?.reserve_photo_slot.already_reserved === true, "retry should not take a second slot");
    assert(again.rows[0]?.reserve_photo_slot.current_photo_count === 1, "count stays at 1 for the same key");

    const reservationId = first.rows[0]?.reserve_photo_slot.reservation_id;
    assert(reservationId, "missing reservation");
    await client.query("select public.release_photo_slot($1)", [reservationId]);
    await client.query("select public.release_photo_slot($1)", [reservationId]);
    const afterRelease = await client.query<{ current_photo_count: number; photos_uploaded: number }>(
      `select r.current_photo_count, m.photos_uploaded
       from public.rooms r
       join public.room_members m on m.room_id = r.id and m.user_id = $2
       where r.id = $1`,
      [roomId, guestId],
    );
    assert(afterRelease.rows[0]?.current_photo_count === 0, "release decrements the room count");
    assert(afterRelease.rows[0]?.photos_uploaded === 0, "release decrements the member count");

    const reserved = await client.query<{ reserve_photo_slot: { reservation_id: string } }>(
      "select public.reserve_photo_slot($1, $2, $3, $4) as reserve_photo_slot",
      [roomId, hostId, "idem-host-1", "host.jpg"],
    );
    const completed = await client.query<{ complete_photo_upload: { drive_file_id: string } }>(
      "select public.complete_photo_upload($1, $2) as complete_photo_upload",
      [reserved.rows[0]?.reserve_photo_slot.reservation_id, "driveFile123456"],
    );
    assert(completed.rows[0]?.complete_photo_upload.drive_file_id === "driveFile123456", "complete stores the drive id");
    const replay = await client.query<{ reserve_photo_slot: { already_uploaded: boolean; current_photo_count: number } }>(
      "select public.reserve_photo_slot($1, $2, $3, $4) as reserve_photo_slot",
      [roomId, hostId, "idem-host-1", "host.jpg"],
    );
    assert(replay.rows[0]?.reserve_photo_slot.already_uploaded === true, "completed key is idempotent");
    assert(replay.rows[0]?.reserve_photo_slot.current_photo_count === 1, "replay does not increment");

    const clients = await Promise.all(
      Array.from({ length: 8 }, async () => {
        const extra = new Client(clientConfig());
        await extra.connect();
        return extra;
      }),
    );
    try {
      const results = await Promise.all(clients.map(async (extra, index) => {
        try {
          await extra.query(
            "select public.reserve_photo_slot($1, $2, $3, $4)",
            [roomId, guestId, `parallel-${index}-key`, `p-${index}.jpg`],
          );
          return "ok";
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      }));
      const wins = results.filter((result) => result === "ok").length;
      assert(wins === 1, `room limit is 2 with 1 already uploaded, expected 1 more win, got ${wins}: ${results.join(" | ")}`);
    } finally {
      await Promise.all(clients.map((extra) => extra.end()));
    }

    const count = await client.query<{ current_photo_count: number }>(
      "select current_photo_count from public.rooms where id = $1",
      [roomId],
    );
    assert(count.rows[0]?.current_photo_count === 2, "atomic reserves must stop at the limit");

    await client.query("begin");
    await client.query("select set_config('request.jwt.claim.sub', $1, true)", [strangerId]);
    await client.query("set local role authenticated");
    await expectError(
      () => client.query("select public.join_room($1, $2)", [roomId, room.join_token]),
      "room_full",
    );
    await client.query("rollback");

    await client.query("update public.rooms set is_active = false where id = $1", [roomId]);
    const otherRoom = await client.query<{
      create_room_record: { join_token: string; room: { id: string } };
    }>(
      "select public.create_room_record($1, $2, $3, $4) as create_room_record",
      [hostId, "Second", "folderZZZZZ12345", 5],
    );
    const second = otherRoom.rows[0]?.create_room_record;
    assert(second, "second room missing");

    await asUser(client, guestId, async () => {
      const visible = await client.query<{ id: string }>("select id from public.rooms order by created_at");
      assert(visible.rows.length === 1, "guest should see only the room they joined");
      assert(visible.rows[0]?.id === roomId, "guest saw the wrong room");
      const people = await client.query<{ id: string }>("select id from public.users");
      const ids = people.rows.map((row) => row.id).sort();
      assert(ids.includes(hostId) && ids.includes(guestId), "members can see each other's profiles");
      assert(!ids.includes(strangerId), "stranger profile leaked");
      await client.query("update public.rooms set is_active = true where id = $1", [roomId]);
    });
    const stillClosed = await client.query<{ is_active: boolean }>(
      "select is_active from public.rooms where id = $1",
      [roomId],
    );
    assert(stillClosed.rows[0]?.is_active === false, "guest must not reopen a room");

    await asUser(client, hostId, async () => {
      await client.query("update public.rooms set is_active = true where id = $1", [roomId]);
    });
    const reopened = await client.query<{ is_active: boolean }>(
      "select is_active from public.rooms where id = $1",
      [roomId],
    );
    assert(reopened.rows[0]?.is_active === true, "host can update is_active");

    await client.query("begin");
    await client.query("select set_config('request.jwt.claim.sub', $1, true)", [hostId]);
    await client.query("set local role authenticated");
    await expectError(
      () => client.query("update public.rooms set current_photo_count = 0 where id = $1", [roomId]),
      "permission denied",
    );
    await client.query("rollback");

    const issued = await asUser(client, hostId, async () => {
      const result = await client.query<{ issue_join_token: { token: string } }>(
        "select public.issue_join_token($1) as issue_join_token",
        [roomId],
      );
      return result.rows[0]?.issue_join_token.token;
    });
    assert(issued && issued !== room.join_token, "host can rotate the join token");

    await client.query("begin");
    await client.query("select set_config('request.jwt.claim.sub', $1, true)", [guestId]);
    await client.query("set local role authenticated");
    await expectError(
      () => client.query("select public.issue_join_token($1)", [roomId]),
      "not_host",
    );
    await client.query("rollback");

    await client.query("begin");
    await client.query("select set_config('request.jwt.claim.sub', $1, true)", [strangerId]);
    await client.query("set local role authenticated");
    await expectError(
      () => client.query("select public.join_room($1, $2)", [second.room.id, room.join_token]),
      "invalid_join_token",
    );
    await client.query("rollback");

    console.log("SQL RPC and RLS checks passed");
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
