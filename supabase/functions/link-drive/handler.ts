import { requireUser, adminClient } from "../_shared/auth.ts";
import { rpcErrorCode } from "../_shared/errors.ts";
import { GoogleApiError } from "../_shared/drive.ts";
import { exchangeServerAuthCode, googleClientCredentials } from "../_shared/google.ts";
import { corsHeaders, json, statusForCode } from "../_shared/http.ts";

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const user = await requireUser(req);
    if (!user) return json({ error: "not_authenticated" }, 401);

    const body = await req.json() as { serverAuthCode?: string };
    const serverAuthCode = body.serverAuthCode?.trim() ?? "";
    if (serverAuthCode.length < 8) return json({ error: "bad_request" }, 400);

    const { clientId, clientSecret } = googleClientCredentials();
    const refreshToken = await exchangeServerAuthCode(serverAuthCode, clientId, clientSecret);
    const admin = adminClient();
    const stored = await admin.rpc("store_host_refresh_token", {
      p_user_id: user.id,
      p_refresh_token: refreshToken,
    });
    if (stored.error) {
      const code = rpcErrorCode(stored.error.message);
      return json({ error: code }, statusForCode(code));
    }
    return json({ drive_linked: true });
  } catch (error) {
    if (error instanceof GoogleApiError) {
      return json({ error: error.googleError }, statusForCode(error.googleError));
    }
    const message = error instanceof Error ? error.message : "link_drive_failed";
    const code = rpcErrorCode(message);
    return json({ error: code === "rpc_failed" ? "link_drive_failed" : code }, statusForCode(code));
  }
}
