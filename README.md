# Go2

Go2 is a React Native app for a shared, event-sized camera roll. The host signs in with Google, creates a room, and Go2 makes a folder in that person's own Google Drive. Guests scan a QR code, shoot with the in-app camera, and photos queue on the phone until they upload into the host folder. A room-wide photo cap is reserved one photo at a time so two phones cannot slip past the limit together.

The Supabase project this build targets is `rsmxyisnwluqashngmht` (`https://rsmxyisnwluqashngmht.supabase.co`). The app already defaults to that URL and its public anon key. Google OAuth client IDs are still empty until you create them.

## Architecture

```text
phone (Expo dev build)
  Google Sign-In  --->  ID token  --->  Supabase Auth (signInWithIdToken)
  host only       --->  server auth code ---> Edge Function link-drive / create-room
                                              stores refresh token in private.host_google_tokens
  camera          --->  cache file + AsyncStorage queue
  queue worker    --->  Edge Function upload-photo
                         1. reserve_photo_slot (row lock, increment count)
                         2. refresh the HOST token server-side
                         3. Drive resumable or multipart upload into the room folder
                         4. complete_photo_upload, or release_photo_slot on failure
```

Guests never receive the host refresh token, access token, or client secret. The upload function reads the token with the service role and does not put it in the response. `private.host_google_tokens` and `private.room_secrets` are not granted to `anon` or `authenticated`, and they are not part of the Data API schema list.

Auth uses [`@react-native-google-signin/google-signin`](https://react-native-google-signin.github.io/docs/setting-up/expo), not `expo-auth-session`. The native SDK returns a Google ID token whose audience is the Web client ID, which is what `supabase.auth.signInWithIdToken({ provider: "google", token })` expects, and with `offlineAccess` it returns a server auth code the Edge Function exchanges for a refresh token. That exchange uses the Web client id and secret and no redirect URI. `drive.file` plus this native module are not in Expo Go. Use an Expo development build.

Guest sign-in asks only for the default identity scopes (openid, profile, email). Drive scope and offline access are requested when someone creates a room, or when the host taps Reconnect Drive.

## What the app does

- Sign in, sign out, and a home list of rooms you host and rooms you joined.
- Create a room with a name and a photo limit (presets 100, 300, 500, or a custom number from 1 to 10000). The server creates `Go2_<Name>_<id prefix>` in the host Drive root.
- Room screen with the live count, member list, recent file names, and a QR code. The join secret is kept on the host phone. New QR code rotates it and invalidates the previous one.
- Scan the QR with the in-app camera. Join checks the token, that the room is open, and that it is not already full. Someone who already joined can open the room again.
- Camera screen. Each photo is copied into the cache and appended to a persistent queue. The shutter turns off when the server count plus this phone's unsent photos reach the cap.
- Upload queue with retry and discard. The worker is sequential, backs off up to five minutes, gives up after eight attempts, resumes when the app becomes active, and resumes when the network returns. A crash mid-upload puts that item back to pending on the next launch.

## Schema notes

The spec's `users` table is `public.users`, but `id` references `auth.users(id)` so row level security can use `auth.uid()`. A trigger on `auth.users` copies the Google profile, and `ensure_profile()` refreshes it from `auth.identities` (the provider id, not editable user metadata).

`rooms.google_drive_folder_id` matches the spec. The join token is not stored in plaintext. `private.room_secrets` holds its SHA-256. The QR payload is `go2://join?room=<uuid>&token=<64 hex chars>` (JSON `{ roomId, token }` is also accepted).

`photo_queue_meta` records a finished upload and adds `idempotency_key` so a retry does not count twice. `photo_slot_reservations` is the in-between row the cap lock updates. Client roles cannot write either table.

Capacity changes take `SELECT ... FOR UPDATE` on the room row, then increment `rooms.current_photo_count` and `room_members.photos_uploaded` in the same transaction. A failed upload calls `release_photo_slot`, which decrements both. A repeated idempotency key returns the existing reservation instead of taking another slot.

## Project layout

- `app/` screens (expo-router)
- `src/queue/logic.ts` queue rules, covered by unit tests
- `src/lib/` Supabase client, Google sign-in, Drive upload request
- `supabase/migrations/` three SQL files, in filename order
- `supabase/functions/` `link-drive`, `create-room`, `upload-photo`
- `tests/sql/run.ts` applies those migrations twice on local Postgres and exercises the RPCs and RLS

## Environment

Copy `.env.example` to `.env` if you want to override the defaults. The checked-in defaults in `app.config.ts` already point at the Supabase project above.

| Name | Where it goes |
| --- | --- |
| `EXPO_PUBLIC_SUPABASE_URL` | App. Default: `https://rsmxyisnwluqashngmht.supabase.co` |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | App. The legacy anon JWT is the default. Publishable alternative: `sb_publishable_1qi-YIW-428vqUFCWBht0w_oc9gPVvM` |
| `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` | App. Also the Supabase Google client id, and `GOOGLE_CLIENT_ID` |
| `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` | App |
| `EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME` | Optional. Defaults to the reversed iOS client id |
| `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID` | Documented for the Android OAuth client. The native SDK uses the Web client id on Android |
| `GOOGLE_CLIENT_ID` | Edge Function secret. Web client id |
| `GOOGLE_CLIENT_SECRET` | Edge Function secret. Web client secret |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Injected into Edge Functions by Supabase. Do not put the service role key in the app |

Set the Edge secrets before deploying:

```bash
supabase secrets set \
  GOOGLE_CLIENT_ID="your-web-client-id.apps.googleusercontent.com" \
  GOOGLE_CLIENT_SECRET="your-web-client-secret" \
  --project-ref rsmxyisnwluqashngmht
```

## Google Cloud Console

1. Open [Google Cloud Console](https://console.cloud.google.com/), create a project, and select it.
2. APIs & Services → Library. Enable **Google Drive API**.
3. APIs & Services → OAuth consent screen.
   - User type: External (or Internal if this is a Workspace-only app).
   - App name: Go2. Add your support email.
   - Scopes: `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`, and `https://www.googleapis.com/auth/drive.file`.
   - Add every Google account you will test with under Test users, while the app stays in Testing.
4. APIs & Services → Credentials → Create credentials → OAuth client ID. Create three clients:

   **Web application**
   - Name: Go2 Web.
   - Authorized redirect URI: `https://rsmxyisnwluqashngmht.supabase.co/auth/v1/callback`
   - Copy the client id into `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` and `GOOGLE_CLIENT_ID`.
   - Copy the client secret into `GOOGLE_CLIENT_SECRET` and into the Supabase Google provider. This is the client that mints the host server auth code.

   **Android**
   - Name: Go2 Android.
   - Package name: `com.go2.photos`.
   - SHA-1: the certificate that signs the build you install.
     - Local debug keystore: `keytool -list -v -alias androiddebugkey -keystore ~/.android/debug.keystore -storepass android`
     - EAS: `eas credentials -p android` and copy the SHA-1 for the build profile you use. A debug keystore SHA-1 will not match an EAS-signed install.
   - You can store this client id in `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID`. The sign-in SDK still wants the Web client id as `webClientId`.

   **iOS**
   - Name: Go2 iOS.
   - Bundle ID: `com.go2.photos`.
   - Copy the iOS client id into `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`.
   - The URL scheme is the reversed client id: `com.googleusercontent.apps.` plus the part before `.apps.googleusercontent.com`. `app.config.ts` derives it when `EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME` is empty. Set the real iOS client id before `npx expo prebuild` or `eas build`, otherwise the native project keeps the placeholder scheme.

5. Supabase dashboard → Authentication → Providers → Google.
   - Enable it.
   - Client ID and secret: the **Web** client, same values as the Edge secrets.
   - Turn **Skip nonce check** on. The native Google SDK does not attach a nonce on Android, and `signInWithIdToken` rejects the token without this.

## Supabase setup

You apply the database and functions yourself. This repo does not connect as a database admin.

Install the [Supabase CLI](https://supabase.com/docs/guides/cli), then from the repo root:

```bash
supabase login
supabase link --project-ref rsmxyisnwluqashngmht
```

Apply the migrations **in this order**. They are idempotent (`create ... if not exists`, `create or replace`, drop-then-create policies), so running them again is safe.

1. `supabase/migrations/20261109160000_schema.sql`
2. `supabase/migrations/20261109160100_rpcs.sql`
3. `supabase/migrations/20261109160200_rls.sql`

Either:

```bash
supabase db push
```

or paste each file, in that order, into the Supabase SQL editor.

`db push` reads `supabase/config.toml`. That file only sets the project id and function JWT flags. If the CLI rejects it as an incomplete config, paste the three SQL files in order instead, and keep the `[functions.*]` blocks when you deploy.

Then deploy the functions. `verify_jwt` is `true` for every function (`supabase/config.toml`). Leave JWT verification on if you deploy from the dashboard. The app sends the user access token.

| Function | verify_jwt | What it does |
| --- | --- | --- |
| `link-drive` | `true` | Exchanges a host server auth code and stores the refresh token |
| `create-room` | `true` | Optionally stores a new code, creates the Drive folder, inserts the room, returns the join token once |
| `upload-photo` | `true` | Reserves a slot, uploads the bytes with the host token, completes or releases the slot |

```bash
supabase functions deploy link-drive --project-ref rsmxyisnwluqashngmht
supabase functions deploy create-room --project-ref rsmxyisnwluqashngmht
supabase functions deploy upload-photo --project-ref rsmxyisnwluqashngmht
```

Required secrets: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. Supabase injects `SUPABASE_URL`, `SUPABASE_ANON_KEY` (or the publishable key), and `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_SECRET_KEY`). The functions accept either name.

The third migration adds `rooms` and `room_members` to the `supabase_realtime` publication when that publication exists. If live counts do not move, Dashboard → Database → Publications → `supabase_realtime`, and include those two tables. The room screen also polls every 12 seconds.

## Run it on a phone

Expo Go will not load the Google Sign-In native module, and it cannot request `drive.file`. Build a development client.

```bash
npm install
npx expo login
npx eas login
npx eas init          # writes EAS_PROJECT_ID; optional for the first build
npx eas build --profile development --platform android
npx eas build --profile development --platform ios
```

`eas.json` has a `development` profile with `developmentClient: true`. After the build is installed:

```bash
npx expo start --dev-client
```

iOS builds need a Mac or EAS, an Apple Developer account, and the bundle id `com.go2.photos` registered to that team. Android needs the SHA-1 from the keystore EAS used, registered on the Android OAuth client, before sign-in works. `DEVELOPER_ERROR` / code 10 on Android almost always means the SHA-1 or package name does not match.

Put the Google client IDs in `.env` before the EAS build so they are baked into `app.config.ts`. EAS environment variables for the `development` profile should include the same `EXPO_PUBLIC_*` names.

## Local checks

```bash
npm run typecheck
npm run lint
npm test
npm run test:sql          # needs Postgres; default socket DB go2_test
npm run export:android
npm run export:ios
```

`test:sql` uses `DATABASE_URL` when set, otherwise a local socket (`PGHOST`, default `/var/run/postgresql`, database `go2_test`). It creates a stub `auth.users`, applies the three migrations twice, and checks join, bad tokens, the photo cap under parallel reservations, idempotent retries, release, and RLS (guests cannot read refresh tokens, cannot call service RPCs, cannot see other rooms, cannot change the count).

Edge Functions:

```bash
deno check supabase/functions/link-drive/index.ts \
  supabase/functions/create-room/index.ts \
  supabase/functions/upload-photo/index.ts
deno test --allow-net=none --config supabase/functions/deno.json supabase/functions/tests
```

## Deviations from the spec

- `users.id` references `auth.users` instead of `gen_random_uuid()`, so RLS and `auth.uid()` line up. `drive_linked` is an extra boolean so the UI knows whether to ask for Drive without reading the token.
- The join QR is a high-entropy random token (shown once, stored as a SHA-256 hash), not an encrypted room id. Encrypting the id would require a key on the phone, which would not keep the room private. Rotating the QR invalidates the old token.
- Uploads go through the Edge Function proxy. The function uses Drive multipart for files up to 5 MB and resumable upload above that, and looks up an existing file name before retrying so a lost response does not duplicate the file.
- `photo_slot_reservations` and `idempotency_key` are extra. They are how the cap stays atomic across a crash between "count incremented" and "Drive accepted the file".
- Host refresh tokens live in `private.host_google_tokens`, readable only by the service role through `get_host_refresh_token`. That is stricter than a Vault secret and does not require the Vault extension. A leaked anon key cannot select the table.
- Security-definer function bodies live in the `private` schema. Public wrappers are security invoker and exist so PostgREST can call them. Service-only wrappers (`reserve_photo_slot`, `get_host_refresh_token`, and the rest of that list) are not granted to `authenticated`.
