import {
  GoogleSignin,
  isErrorWithCode,
  isSuccessResponse,
  statusCodes,
} from "@react-native-google-signin/google-signin";
import { config, DRIVE_FILE_SCOPE } from "./config";

export class AuthCancelledError extends Error {
  constructor() {
    super("Google sign-in was cancelled.");
    this.name = "AuthCancelledError";
  }
}

function requireWebClient(): void {
  if (!config.googleWebClientId) {
    throw new Error("Set EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID before signing in.");
  }
}

function configure(host: boolean): void {
  requireWebClient();
  GoogleSignin.configure({
    webClientId: config.googleWebClientId,
    iosClientId: config.googleIosClientId || undefined,
    offlineAccess: host,
    forceCodeForRefreshToken: host,
    scopes: host ? [DRIVE_FILE_SCOPE] : undefined,
  });
}

async function signInNative(host: boolean): Promise<{ idToken: string | null; serverAuthCode: string | null }> {
  configure(host);
  if (GoogleSignin.hasPlayServices) {
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
  }
  const response = await GoogleSignin.signIn();
  if (!isSuccessResponse(response)) {
    throw new AuthCancelledError();
  }
  return {
    idToken: response.data.idToken ?? null,
    serverAuthCode: response.data.serverAuthCode ?? null,
  };
}

export async function signInForIdentity(): Promise<{ idToken: string }> {
  try {
    const result = await signInNative(false);
    if (!result.idToken) {
      throw new Error("Google did not return an ID token. Check the Web client ID.");
    }
    return { idToken: result.idToken };
  } catch (error) {
    if (isErrorWithCode(error) && error.code === statusCodes.SIGN_IN_CANCELLED) {
      throw new AuthCancelledError();
    }
    throw error;
  }
}

export async function signInForDrive(): Promise<{ serverAuthCode: string }> {
  try {
    const result = await signInNative(true);
    if (!result.serverAuthCode) {
      throw new Error(
        "Google did not return a server auth code. Confirm offline access is enabled and the Web client secret matches this Web client ID.",
      );
    }
    return { serverAuthCode: result.serverAuthCode };
  } catch (error) {
    if (isErrorWithCode(error) && error.code === statusCodes.SIGN_IN_CANCELLED) {
      throw new AuthCancelledError();
    }
    throw error;
  }
}

export async function googleSignOut(): Promise<void> {
  try {
    configure(false);
    await GoogleSignin.signOut();
  } catch {
    // The native SDK is unavailable in Expo Go, or there was no Google session.
  }
}
