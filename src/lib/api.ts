import { FunctionsHttpError } from "@supabase/supabase-js";
import { config } from "./config";
import { saveJoinToken } from "./joinTokens";
import { supabase } from "./supabase";
import type { PhotoMeta, Profile, Room, RoomMember } from "./types";

const ROOM_COLUMNS =
  "id, host_id, room_name, max_photo_limit, current_photo_count, is_active, created_at";

async function functionError(error: unknown): Promise<Error> {
  if (error instanceof FunctionsHttpError) {
    try {
      const payload = (await error.context.json()) as { error?: string };
      if (payload.error) return new Error(payload.error);
    } catch {
      // Fall through to the generic message.
    }
  }
  if (error instanceof Error) return error;
  return new Error("Request failed.");
}

export async function ensureProfile(): Promise<Profile> {
  const { data, error } = await supabase.rpc("ensure_profile");
  if (error) throw new Error(error.message);
  return data as Profile;
}

export async function linkDrive(serverAuthCode: string): Promise<void> {
  const { error } = await supabase.functions.invoke("link-drive", {
    body: { serverAuthCode },
  });
  if (error) throw await functionError(error);
}

export async function createRoom(input: {
  roomName: string;
  maxPhotoLimit: number;
  serverAuthCode?: string;
}): Promise<Room> {
  const { data, error } = await supabase.functions.invoke("create-room", { body: input });
  if (error) throw await functionError(error);
  const payload = data as { join_token: string; room: Room };
  await saveJoinToken(payload.room.id, payload.join_token);
  return payload.room;
}

export async function listHostedRooms(userId: string): Promise<Room[]> {
  const { data, error } = await supabase
    .from("rooms")
    .select(ROOM_COLUMNS)
    .eq("host_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as Room[];
}

export async function listJoinedRooms(userId: string): Promise<Room[]> {
  const { data, error } = await supabase
    .from("room_members")
    .select(`room_id, rooms(${ROOM_COLUMNS})`)
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
  const rooms: Room[] = [];
  for (const row of data ?? []) {
    const nested = row.rooms as Room | Room[] | null;
    const room = Array.isArray(nested) ? nested[0] : nested;
    if (room && room.host_id !== userId) rooms.push(room);
  }
  return rooms;
}

export async function getRoom(roomId: string): Promise<Room | null> {
  const { data, error } = await supabase.from("rooms").select(ROOM_COLUMNS).eq("id", roomId).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as Room | null) ?? null;
}

export async function listMembers(roomId: string): Promise<RoomMember[]> {
  const { data, error } = await supabase
    .from("room_members")
    .select("id, user_id, photos_uploaded, joined_at, users(full_name, email, avatar_url)")
    .eq("room_id", roomId)
    .order("joined_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => {
    const user = (Array.isArray(row.users) ? row.users[0] : row.users) as
      | { full_name: string | null; email: string; avatar_url: string | null }
      | null;
    return {
      id: row.id,
      user_id: row.user_id,
      photos_uploaded: row.photos_uploaded,
      joined_at: row.joined_at,
      full_name: user?.full_name ?? null,
      email: user?.email ?? "",
      avatar_url: user?.avatar_url ?? null,
    };
  });
}

export async function listRecentPhotos(roomId: string): Promise<PhotoMeta[]> {
  const { data, error } = await supabase
    .from("photo_queue_meta")
    .select("id, file_name, uploaded_at, uploader_id")
    .eq("room_id", roomId)
    .order("uploaded_at", { ascending: false })
    .limit(12);
  if (error) throw new Error(error.message);
  return (data ?? []) as PhotoMeta[];
}

export async function joinRoom(roomId: string, token: string): Promise<void> {
  const { error } = await supabase.rpc("join_room", { p_room_id: roomId, p_token: token });
  if (error) throw new Error(error.message);
}

export async function issueJoinToken(roomId: string): Promise<string> {
  const { data, error } = await supabase.rpc("issue_join_token", { p_room_id: roomId });
  if (error) throw new Error(error.message);
  const token = (data as { token?: string } | null)?.token;
  if (!token) throw new Error("The server did not return a join token.");
  await saveJoinToken(roomId, token);
  return token;
}

export async function setRoomActive(roomId: string, isActive: boolean): Promise<void> {
  const { error } = await supabase.from("rooms").update({ is_active: isActive }).eq("id", roomId);
  if (error) throw new Error(error.message);
}

export async function uploadQueuedFile(input: {
  accessToken: string;
  roomId: string;
  idempotencyKey: string;
  fileName: string;
  contentType: string;
  localUri: string;
}): Promise<{ error?: string; status: number }> {
  const form = new FormData();
  form.append("roomId", input.roomId);
  form.append("idempotencyKey", input.idempotencyKey);
  form.append("fileName", input.fileName);
  form.append("file", {
    uri: input.localUri,
    name: input.fileName,
    type: input.contentType,
  } as unknown as Blob);

  const response = await fetch(`${config.supabaseUrl}/functions/v1/upload-photo`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      apikey: config.supabaseAnonKey,
    },
    body: form,
  });
  if (response.ok) return { status: response.status };
  let errorCode = `http_${response.status}`;
  try {
    const payload = (await response.json()) as { error?: string };
    if (payload.error) errorCode = payload.error;
  } catch {
    // Non-JSON error body.
  }
  return { status: response.status, error: errorCode };
}
