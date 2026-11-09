import assert from "node:assert/strict";
import test from "node:test";
import {
  applyUploadResult,
  backoffMs,
  classifyUploadFailure,
  countActiveForRoom,
  emptyQueue,
  enqueue,
  hydrateQueue,
  MAX_ATTEMPTS,
  pickNext,
  resetInFlight,
  retryAll,
  runAvailable,
  serializeQueue,
} from "../src/queue/logic";

const base = {
  userId: "user-1",
  roomId: "room-1",
  localUri: "file:///cache/a.jpg",
  fileName: "a.jpg",
  contentType: "image/jpeg",
};

test("backoff grows and then caps", () => {
  assert.equal(backoffMs(1), 2000);
  assert.equal(backoffMs(2), 4000);
  assert.equal(backoffMs(3), 8000);
  assert.equal(backoffMs(12), 5 * 60 * 1000);
});

test("classify keeps room-full failures from retrying", () => {
  assert.equal(classifyUploadFailure(409, "room_full").retryable, false);
  assert.equal(classifyUploadFailure(409, "room_closed").retryable, false);
  assert.equal(classifyUploadFailure(502, "drive_upload_failed").retryable, true);
  assert.equal(classifyUploadFailure(409, "drive_link_required").retryable, true);
  assert.equal(classifyUploadFailure(401, "not_authenticated").retryable, false);
});

test("queue runs one photo at a time and retries after backoff", async () => {
  let state = emptyQueue();
  state = enqueue(state, { ...base, id: "a", createdAt: 1 });
  state = enqueue(state, { ...base, id: "b", fileName: "b.jpg", createdAt: 2 });
  state = enqueue(state, { ...base, id: "c", fileName: "c.jpg", createdAt: 3 });

  const order: string[] = [];
  let now = 10_000;
  state = await runAvailable(state, {
    userId: "user-1",
    now: () => now,
    upload: async (item) => {
      order.push(item.id);
      if (item.id === "b") return { ok: false, retryable: true, message: "network" };
      return { ok: true };
    },
  });

  assert.deepEqual(order, ["a", "b", "c"]);
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0]?.id, "b");
  assert.equal(state.items[0]?.status, "failed");
  assert.equal(pickNext(state, now, "user-1"), null);

  now = state.items[0]!.nextAttemptAt;
  state = await runAvailable(state, {
    userId: "user-1",
    now: () => now,
    upload: async () => ({ ok: true }),
  });
  assert.equal(state.items.length, 0);
});

test("a blocked room does not consume later retries until asked", async () => {
  let state = enqueue(emptyQueue(), { ...base, id: "full", createdAt: 1 });
  state = applyUploadResult(state, "full", classifyUploadFailure(409, "room_full"), 50);
  assert.equal(state.items[0]?.status, "blocked");
  assert.equal(pickNext(state, 50, "user-1"), null);
  state = retryAll(state, "user-1");
  assert.equal(pickNext(state, 50, "user-1")?.id, "full");
});

test("gives up after the attempt cap", () => {
  let state = enqueue(emptyQueue(), { ...base, id: "flake", createdAt: 1 });
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    state = applyUploadResult(
      state,
      "flake",
      { ok: false, retryable: true, message: "network" },
      1_000 + attempt,
    );
  }
  assert.equal(state.items[0]?.status, "blocked");
  assert.equal(state.items[0]?.attempts, MAX_ATTEMPTS);
});

test("hydration resets an upload that was in flight when the app quit", () => {
  const raw = serializeQueue({
    items: [
      {
        ...base,
        id: "mid",
        status: "uploading",
        attempts: 1,
        nextAttemptAt: 0,
        createdAt: 5,
      },
    ],
  });
  const state = hydrateQueue(raw);
  assert.equal(state.items[0]?.status, "pending");
  assert.equal(hydrateQueue("not-json").items.length, 0);
  assert.equal(resetInFlight(state).items[0]?.status, "pending");
});

test("pending uploads count toward the room cap shown in the camera", () => {
  let state = enqueue(emptyQueue(), { ...base, id: "a", createdAt: 1 });
  state = enqueue(state, { ...base, id: "b", roomId: "room-2", createdAt: 2 });
  assert.equal(countActiveForRoom(state, "room-1", "user-1"), 1);
});

test("another user's items stay in the queue but are not picked", () => {
  const state = enqueue(emptyQueue(), { ...base, id: "theirs", userId: "user-2", createdAt: 1 });
  assert.equal(pickNext(state, 10, "user-1"), null);
  assert.equal(pickNext(state, 10, "user-2")?.id, "theirs");
});
