export const DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";
export const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
export const MULTIPART_LIMIT_BYTES = 5 * 1024 * 1024;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class GoogleApiError extends Error {
  status: number;
  googleError: string;

  constructor(status: number, googleError: string, message: string) {
    super(message);
    this.name = "GoogleApiError";
    this.status = status;
    this.googleError = googleError;
  }
}

export function folderName(roomName: string, roomId: string): string {
  const cleaned = roomName
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  const shortId = roomId.replace(/-/g, "").slice(0, 8);
  return `Go2_${cleaned || "Room"}_${shortId}`;
}

export function escapeDriveQueryString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export function driveNameQuery(fileName: string, folderId: string): string {
  return `name = '${escapeDriveQueryString(fileName)}' and '${escapeDriveQueryString(folderId)}' in parents and trashed = false`;
}

export function chooseUploadStrategy(byteLength: number): "multipart" | "resumable" {
  return byteLength <= MULTIPART_LIMIT_BYTES ? "multipart" : "resumable";
}

export function normalizeImageType(contentType: string): string | null {
  const base = contentType.toLowerCase().split(";")[0]?.trim() ?? "";
  if (base === "image/jpg") return "image/jpeg";
  if (["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"].includes(base)) {
    return base;
  }
  return null;
}

export function safePhotoName(fileName: string, idempotencyKey: string): string {
  const cleanedKey = idempotencyKey.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) || "photo";
  const extMatch = fileName.toLowerCase().match(/\.([a-z0-9]+)$/);
  const rawExt = extMatch?.[1] ?? "jpg";
  const ext = rawExt === "jpeg" ? "jpg" : rawExt;
  const safeExt = ["jpg", "png", "webp", "heic", "heif"].includes(ext) ? ext : "jpg";
  return `Go2_${cleanedKey}.${safeExt}`;
}

export function buildMultipartRelated(
  meta: Record<string, unknown>,
  contentType: string,
  bytes: Uint8Array,
): { contentTypeHeader: string; body: Uint8Array } {
  const boundary = `go2_${crypto.randomUUID().replace(/-/g, "")}`;
  const preamble =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`;
  const ending = `\r\n--${boundary}--`;
  const head = new TextEncoder().encode(preamble);
  const tail = new TextEncoder().encode(ending);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0);
  body.set(bytes, head.length);
  body.set(tail, head.length + bytes.length);
  return { contentTypeHeader: `multipart/related; boundary=${boundary}`, body };
}

export async function readGoogleError(response: Response): Promise<{ googleError: string; message: string }> {
  const text = await response.text();
  let googleError = "";
  let message = text.slice(0, 300);
  try {
    const parsed = JSON.parse(text) as {
      error?: string | { status?: string; message?: string };
      error_description?: string;
    };
    if (typeof parsed.error === "string") {
      googleError = parsed.error;
      message = parsed.error_description ?? parsed.error;
    } else if (parsed.error && typeof parsed.error === "object") {
      googleError = parsed.error.status ?? "google_error";
      message = parsed.error.message ?? message;
    }
  } catch {
    googleError = "google_error";
  }
  return { googleError, message };
}

export function tokenFailureCode(status: number, googleError: string): "drive_link_required" | "google_exchange_failed" {
  if (
    googleError === "invalid_grant" ||
    googleError === "invalid_client" ||
    status === 401
  ) {
    return "drive_link_required";
  }
  return "google_exchange_failed";
}

async function throwGoogle(response: Response, mapper?: (status: number, googleError: string) => string): Promise<never> {
  const parsed = await readGoogleError(response);
  const code = mapper ? mapper(response.status, parsed.googleError) : parsed.googleError || "google_error";
  throw new GoogleApiError(response.status, code, code);
}

export async function createDriveFolder(
  accessToken: string,
  name: string,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const response = await fetchImpl(`${DRIVE_FILES}?fields=id`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name,
      mimeType: "application/vnd.google-apps.folder",
    }),
  });
  if (!response.ok) await throwGoogle(response);
  const json = await response.json() as { id?: string };
  if (!json.id) throw new GoogleApiError(502, "drive_upload_failed", "drive_upload_failed");
  return json.id;
}

export async function deleteDriveFile(
  accessToken: string,
  fileId: string,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  await fetchImpl(`${DRIVE_FILES}/${fileId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

export async function findDriveFile(
  accessToken: string,
  folderId: string,
  fileName: string,
  fetchImpl: FetchLike = fetch,
): Promise<string | null> {
  const params = new URLSearchParams({
    q: driveNameQuery(fileName, folderId),
    fields: "files(id)",
    pageSize: "1",
    spaces: "drive",
  });
  const response = await fetchImpl(`${DRIVE_FILES}?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) await throwGoogle(response);
  const json = await response.json() as { files?: { id?: string }[] };
  return json.files?.[0]?.id ?? null;
}

export async function uploadMultipart(options: {
  accessToken: string;
  folderId: string;
  fileName: string;
  contentType: string;
  bytes: Uint8Array;
  fetchImpl?: FetchLike;
}): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const meta = { name: options.fileName, parents: [options.folderId] };
  const built = buildMultipartRelated(meta, options.contentType, options.bytes);
  const response = await fetchImpl(`${DRIVE_UPLOAD}?uploadType=multipart&fields=id`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.accessToken}`,
      "Content-Type": built.contentTypeHeader,
      "Content-Length": String(built.body.byteLength),
    },
    body: built.body as unknown as BodyInit,
  });
  if (!response.ok) await throwGoogle(response);
  const json = await response.json() as { id?: string };
  if (!json.id) throw new GoogleApiError(502, "drive_upload_failed", "drive_upload_failed");
  return json.id;
}

export async function uploadResumable(options: {
  accessToken: string;
  folderId: string;
  fileName: string;
  contentType: string;
  bytes: Uint8Array;
  fetchImpl?: FetchLike;
}): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const init = await fetchImpl(`${DRIVE_UPLOAD}?uploadType=resumable&fields=id`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": options.contentType,
      "X-Upload-Content-Length": String(options.bytes.byteLength),
    },
    body: JSON.stringify({ name: options.fileName, parents: [options.folderId] }),
  });
  if (!init.ok) await throwGoogle(init);
  const location = init.headers.get("Location");
  if (!location) throw new GoogleApiError(502, "drive_upload_failed", "drive_upload_failed");

  const put = await fetchImpl(location, {
    method: "PUT",
    headers: {
      "Content-Type": options.contentType,
      "Content-Length": String(options.bytes.byteLength),
    },
    body: options.bytes as unknown as BodyInit,
  });
  if (!put.ok) await throwGoogle(put);
  const json = await put.json() as { id?: string };
  if (!json.id) throw new GoogleApiError(502, "drive_upload_failed", "drive_upload_failed");
  return json.id;
}

export async function uploadPhotoToDrive(options: {
  accessToken: string;
  folderId: string;
  fileName: string;
  contentType: string;
  bytes: Uint8Array;
  fetchImpl?: FetchLike;
}): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const existing = await findDriveFile(options.accessToken, options.folderId, options.fileName, fetchImpl);
  if (existing) return existing;
  const strategy = chooseUploadStrategy(options.bytes.byteLength);
  if (strategy === "multipart") return uploadMultipart({ ...options, fetchImpl });
  return uploadResumable({ ...options, fetchImpl });
}
