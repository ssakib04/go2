import { adminClient, isUuid, requireUser } from "../_shared/auth.ts";
import { rpcErrorCode } from "../_shared/errors.ts";
import {
  createDriveFolder,
  deleteDriveFile,
  folderName,
  GoogleApiError,
} from "../_shared/drive.ts";
import {
  exchangeServerAuthCode,
  googleClientCredentials,
  refreshAccessToken,
} from "../_shared/google.ts";
import { corsHeaders, json, statusForCode } from "../_shared/http.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

type CreateBody = {
  roomName?: string;
  maxPhotoLimit?: number;
  serverAuthCode?: string;
};

async function accessTokenForHost(admin: SupabaseClient, hostId: string): Promise<string> {
  const { clientId, clientSecret } = googleClientCredentials();
  const tokenResult = await admin.rpc("get_host_refresh_token", { p_user_id: hostId });
  if (tokenResult.error) throw new Error(tokenResult.error.message);
  const refreshToken = tokenResult.data as string | null;
  if (!refreshToken) throw new GoogleApiError(409, "drive_link_required", "drive_link_required");
  return refreshAccessToken(refreshToken, clientId, clientSecret);
}

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const user = await requireUser(req);
    if (!user) return json({ error: "not_authenticated" }, 401);

    const body = await req.json() as CreateBody;
    const roomName = body.roomName?.trim() ?? "";
    const maxPhotoLimit = body.maxPhotoLimit;
    if (roomName.length < 1 || roomName.length > 80) return json({ error: "invalid_room_name" }, 400);
    if (!Number.isInteger(maxPhotoLimit) || (maxPhotoLimit ?? 0) < 1 || (maxPhotoLimit ?? 0) > 10000) {
      return json({ error: "invalid_photo_limit" }, 400);
    }

    const admin = adminClient();
    const serverAuthCode = body.serverAuthCode?.trim();
    if (serverAuthCode) {
      const { clientId, clientSecret } = googleClientCredentials();
      const refreshToken = await exchangeServerAuthCode(serverAuthCode, clientId, clientSecret);
      const stored = await admin.rpc("store_host_refresh_token", {
        p_user_id: user.id,
        p_refresh_token: refreshToken,
      });
      if (stored.error) {
        const code = rpcErrorCode(stored.error.message);
        return json({ error: code }, statusForCode(code));
      }
    }

    const accessToken = await accessTokenForHost(admin, user.id);
    const roomId = crypto.randomUUID();
    if (!isUuid(roomId)) return json({ error: "bad_request" }, 400);
    const name = folderName(roomName, roomId);
    const folderId = await createDriveFolder(accessToken, name);

    const created = await admin.rpc("create_room_record", {
      p_host_id: user.id,
      p_room_name: roomName,
      p_folder_id: folderId,
      p_max_photo_limit: maxPhotoLimit,
    });
    if (created.error) {
      await deleteDriveFile(accessToken, folderId);
      const code = rpcErrorCode(created.error.message);
      return json({ error: code }, statusForCode(code));
    }

    return json(created.data);
  } catch (error) {
    if (error instanceof GoogleApiError) {
      return json({ error: error.googleError }, statusForCode(error.googleError));
    }
    const message = error instanceof Error ? error.message : "create_room_failed";
    const code = rpcErrorCode(message);
    return json({ error: code === "rpc_failed" ? "create_room_failed" : code }, statusForCode(code));
  }
}
