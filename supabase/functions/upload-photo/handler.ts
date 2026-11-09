import { adminClient, isUuid, requireUser } from "../_shared/auth.ts";
import { rpcErrorCode } from "../_shared/errors.ts";
import {
  GoogleApiError,
  MAX_PHOTO_BYTES,
  normalizeImageType,
  safePhotoName,
  uploadPhotoToDrive,
} from "../_shared/drive.ts";
import { googleClientCredentials, refreshAccessToken } from "../_shared/google.ts";
import { corsHeaders, json, statusForCode } from "../_shared/http.ts";

type Reservation = {
  status: string;
  reservation_id: string;
  drive_file_id?: string | null;
  host_id?: string;
  google_drive_folder_id?: string;
  current_photo_count?: number;
  max_photo_limit?: number;
  already_uploaded?: boolean;
};

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const user = await requireUser(req);
  if (!user) return json({ error: "not_authenticated" }, 401);

  let reservationId: string | null = null;
  const admin = adminClient();

  try {
    const form = await req.formData();
    const roomId = String(form.get("roomId") ?? "");
    const idempotencyKey = String(form.get("idempotencyKey") ?? "");
    const fileName = String(form.get("fileName") ?? "");
    const file = form.get("file");
    if (!isUuid(roomId) || idempotencyKey.length < 8 || !fileName || !(file instanceof File)) {
      return json({ error: "bad_request" }, 400);
    }

    const contentType = normalizeImageType(file.type || "image/jpeg");
    if (!contentType) return json({ error: "unsupported_type" }, 415);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength === 0) return json({ error: "bad_request" }, 400);
    if (bytes.byteLength > MAX_PHOTO_BYTES) return json({ error: "too_large" }, 413);

    const reserved = await admin.rpc("reserve_photo_slot", {
      p_room_id: roomId,
      p_uploader_id: user.id,
      p_idempotency_key: idempotencyKey,
      p_file_name: safePhotoName(fileName, idempotencyKey),
    });
    if (reserved.error) {
      const code = rpcErrorCode(reserved.error.message);
      return json({ error: code }, statusForCode(code));
    }

    const reservation = reserved.data as Reservation;
    reservationId = reservation.reservation_id;
    if (reservation.status === "uploaded" && reservation.drive_file_id) {
      return json({
        drive_file_id: reservation.drive_file_id,
        reservation_id: reservation.reservation_id,
        current_photo_count: reservation.current_photo_count,
        max_photo_limit: reservation.max_photo_limit,
        already_uploaded: true,
      });
    }

    const hostId = reservation.host_id;
    const folderId = reservation.google_drive_folder_id;
    if (!hostId || !folderId) return json({ error: "drive_upload_failed" }, 502);

    const { clientId, clientSecret } = googleClientCredentials();
    const tokenResult = await admin.rpc("get_host_refresh_token", { p_user_id: hostId });
    if (tokenResult.error) throw new Error(tokenResult.error.message);
    const refreshToken = tokenResult.data as string | null;
    if (!refreshToken) throw new GoogleApiError(409, "drive_link_required", "drive_link_required");
    const accessToken = await refreshAccessToken(refreshToken, clientId, clientSecret);

    const driveFileId = await uploadPhotoToDrive({
      accessToken,
      folderId,
      fileName: safePhotoName(fileName, idempotencyKey),
      contentType,
      bytes,
    });

    const completed = await admin.rpc("complete_photo_upload", {
      p_reservation_id: reservation.reservation_id,
      p_drive_file_id: driveFileId,
    });
    if (completed.error) throw new Error(completed.error.message);

    return json({
      drive_file_id: driveFileId,
      reservation_id: reservation.reservation_id,
      current_photo_count: reservation.current_photo_count,
      max_photo_limit: reservation.max_photo_limit,
      already_uploaded: false,
    });
  } catch (error) {
    if (reservationId) {
      await admin.rpc("release_photo_slot", { p_reservation_id: reservationId });
    }
    if (error instanceof GoogleApiError) {
      return json({ error: error.googleError }, statusForCode(error.googleError));
    }
    const message = error instanceof Error ? error.message : "drive_upload_failed";
    const code = rpcErrorCode(message);
    const publicCode = code === "rpc_failed" ? "drive_upload_failed" : code;
    return json({ error: publicCode }, statusForCode(publicCode));
  }
}
