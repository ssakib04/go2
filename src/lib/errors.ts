export function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong.";
}

export function friendlyAuthError(error: unknown): string {
  const message = errorText(error);
  if (/nonce/i.test(message)) {
    return "Supabase rejected the Google ID token. In the Supabase Google provider, enable Skip nonce check. The native Google SDK does not send a nonce on Android.";
  }
  if (/Expo Go|native module|RNGoogleSignin|TurboModule|not (?:been )?linked/i.test(message)) {
    return "Google Sign-In needs an Expo development build. It does not run inside Expo Go, and drive.file cannot be requested there either.";
  }
  if (/web client id/i.test(message) || /DEVELOPER_ERROR|10\b/.test(message)) {
    return "Google Sign-In is not configured. Set the Web client ID, and on Android register the app SHA-1 on the Android OAuth client.";
  }
  return message;
}
