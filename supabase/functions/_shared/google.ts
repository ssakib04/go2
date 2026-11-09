import { GoogleApiError, tokenFailureCode, type FetchLike, readGoogleError } from "./drive.ts";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

export function googleClientCredentials(): { clientId: string; clientSecret: string } {
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";
  if (!clientId || !clientSecret) {
    throw new GoogleApiError(500, "missing_google_credentials", "missing_google_credentials");
  }
  return { clientId, clientSecret };
}

async function postToken(body: URLSearchParams, fetchImpl: FetchLike): Promise<{ accessToken?: string; refreshToken?: string }> {
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    const parsed = await readGoogleError(response);
    const code = tokenFailureCode(response.status, parsed.googleError);
    throw new GoogleApiError(response.status, code, code);
  }
  const json = await response.json() as { access_token?: string; refresh_token?: string };
  return { accessToken: json.access_token, refreshToken: json.refresh_token };
}

export async function refreshAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const tokens = await postToken(new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  }), fetchImpl);
  if (!tokens.accessToken) {
    throw new GoogleApiError(502, "google_exchange_failed", "google_exchange_failed");
  }
  return tokens.accessToken;
}

// Native Google Sign-In server auth codes are minted for the Web client.
// Google expects that Web client id + secret and no redirect_uri.
export async function exchangeServerAuthCode(
  code: string,
  clientId: string,
  clientSecret: string,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const tokens = await postToken(new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
  }), fetchImpl);
  if (!tokens.refreshToken) {
    throw new GoogleApiError(400, "no_refresh_token", "no_refresh_token");
  }
  return tokens.refreshToken;
}
