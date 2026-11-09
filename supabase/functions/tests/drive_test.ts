import { assertEquals, assertExists, assertStringIncludes } from "jsr:@std/assert@1";
import { rpcErrorCode } from "../_shared/errors.ts";
import {
  buildMultipartRelated,
  chooseUploadStrategy,
  driveNameQuery,
  folderName,
  GoogleApiError,
  MULTIPART_LIMIT_BYTES,
  safePhotoName,
  tokenFailureCode,
  uploadPhotoToDrive,
} from "../_shared/drive.ts";
import { handleRequest as uploadHandler } from "../upload-photo/handler.ts";
import { handleRequest as createHandler } from "../create-room/handler.ts";
import { handleRequest as linkHandler } from "../link-drive/handler.ts";

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) continue outer;
    }
    return true;
  }
  return false;
}

Deno.test("folder names are Go2_Name_id", () => {
  assertEquals(
    folderName("Beach Day!", "123e4567-e89b-12d3-a456-426614174000"),
    "Go2_Beach_Day_123e4567",
  );
  assertEquals(folderName("   ", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"), "Go2_Room_aaaaaaaa");
});

Deno.test("drive query escapes quotes", () => {
  assertEquals(
    driveNameQuery("a'b", "folder_1"),
    "name = 'a\\'b' and 'folder_1' in parents and trashed = false",
  );
});

Deno.test("upload strategy switches at 5MB", () => {
  assertEquals(chooseUploadStrategy(MULTIPART_LIMIT_BYTES), "multipart");
  assertEquals(chooseUploadStrategy(MULTIPART_LIMIT_BYTES + 1), "resumable");
});

Deno.test("photo names are deterministic and safe", () => {
  assertEquals(safePhotoName("../Photo.JPEG", "queue-item_1"), "Go2_queue-item_1.jpg");
});

Deno.test("multipart body contains metadata and bytes", () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const built = buildMultipartRelated({ name: "a.jpg", parents: ["folder"] }, "image/jpeg", bytes);
  assertStringIncludes(built.contentTypeHeader, "multipart/related; boundary=go2_");
  const text = new TextDecoder().decode(built.body);
  assertStringIncludes(text, '{"name":"a.jpg","parents":["folder"]}');
  assertStringIncludes(text, "Content-Type: image/jpeg");
  assertEquals(containsBytes(built.body, bytes), true);
});

Deno.test("token failures that need a new consent map to drive_link_required", () => {
  assertEquals(tokenFailureCode(400, "invalid_grant"), "drive_link_required");
  assertEquals(tokenFailureCode(500, "backend_error"), "google_exchange_failed");
});

Deno.test("rpc errors keep stable codes", () => {
  assertEquals(rpcErrorCode("room_full"), "room_full");
  assertEquals(rpcErrorCode("something else"), "rpc_failed");
});

Deno.test("resumable upload uses the session location and returns the file id", async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.includes("uploadType=resumable")) {
      return Promise.resolve(new Response("", {
        status: 200,
        headers: { Location: "https://upload.example/session" },
      }));
    }
    if (url === "https://upload.example/session") {
      return Promise.resolve(new Response(JSON.stringify({ id: "file_resumable_1" }), { status: 200 }));
    }
    if (url.startsWith("https://www.googleapis.com/drive/v3/files?")) {
      return Promise.resolve(new Response(JSON.stringify({ files: [] }), { status: 200 }));
    }
    return Promise.resolve(new Response("unexpected", { status: 500 }));
  };

  const bytes = new Uint8Array(MULTIPART_LIMIT_BYTES + 8);
  const id = await uploadPhotoToDrive({
    accessToken: "token",
    folderId: "folder_1234567890",
    fileName: "Go2_abc.jpg",
    contentType: "image/jpeg",
    bytes,
    fetchImpl,
  });
  assertEquals(id, "file_resumable_1");
  assertEquals(calls.some((call) => call.includes("uploadType=resumable")), true);
  assertEquals(calls.some((call) => call.startsWith("PUT https://upload.example/session")), true);
});

Deno.test("existing drive file short-circuits a second upload", async () => {
  let uploads = 0;
  const fetchImpl: typeof fetch = (input) => {
    const url = String(input);
    if (url.includes("/upload/")) {
      uploads += 1;
      return Promise.resolve(new Response(JSON.stringify({ id: "should_not_upload" }), { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify({ files: [{ id: "already_there" }] }), { status: 200 }));
  };
  const id = await uploadPhotoToDrive({
    accessToken: "token",
    folderId: "folder_1234567890",
    fileName: "Go2_abc.jpg",
    contentType: "image/jpeg",
    bytes: new Uint8Array([9]),
    fetchImpl,
  });
  assertEquals(id, "already_there");
  assertEquals(uploads, 0);
});

Deno.test("handlers reject missing credentials before calling Google", async () => {
  for (const handler of [uploadHandler, createHandler, linkHandler]) {
    const response = await handler(new Request("https://example.test", { method: "POST" }));
    assertEquals(response.status, 401);
    const body = await response.json() as { error: string };
    assertEquals(body.error, "not_authenticated");
  }
});

Deno.test("google api error carries the public code", () => {
  const error = new GoogleApiError(409, "drive_link_required", "drive_link_required");
  assertExists(error);
  assertEquals(error.googleError, "drive_link_required");
});
