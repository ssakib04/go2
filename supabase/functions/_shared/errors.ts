const KNOWN = [
  "room_full",
  "room_closed",
  "not_a_member",
  "not_host",
  "not_authenticated",
  "room_not_found",
  "reservation_not_found",
  "invalid_join_token",
  "invalid_room_name",
  "invalid_photo_limit",
  "invalid_folder",
  "invalid_idempotency_key",
  "invalid_file_name",
  "invalid_drive_file",
  "invalid_refresh_token",
  "profile_missing",
  "idempotency_conflict",
  "reservation_not_open",
  "count_underflow",
  "drive_link_required",
  "no_refresh_token",
  "google_exchange_failed",
  "missing_google_credentials",
  "missing_service_credentials",
] as const;

export function rpcErrorCode(message: string | undefined): string {
  const text = message ?? "";
  for (const code of KNOWN) {
    if (text.includes(code)) return code;
  }
  return "rpc_failed";
}
