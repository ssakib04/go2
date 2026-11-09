export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function statusForCode(code: string): number {
  switch (code) {
    case "room_full":
    case "room_closed":
    case "drive_link_required":
      return 409;
    case "not_a_member":
    case "not_host":
      return 403;
    case "not_authenticated":
      return 401;
    case "room_not_found":
    case "reservation_not_found":
      return 404;
    case "unsupported_type":
      return 415;
    case "too_large":
      return 413;
    case "bad_request":
    case "invalid_room_name":
    case "invalid_photo_limit":
    case "invalid_folder":
    case "invalid_idempotency_key":
    case "invalid_file_name":
    case "no_refresh_token":
    case "profile_missing":
      return 400;
    case "drive_upload_failed":
    case "google_exchange_failed":
      return 502;
    case "method_not_allowed":
      return 405;
    default:
      return 500;
  }
}
