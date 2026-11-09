import assert from "node:assert/strict";
import test from "node:test";
import { decodeJoinPayload, encodeJoinPayload, isUuid } from "../src/lib/joinPayload";

test("join payload round-trips through a go2 URL and JSON", () => {
  const roomId = "123e4567-e89b-41d3-a456-426614174000";
  const token = "a".repeat(64);
  const encoded = encodeJoinPayload(roomId, token);
  assert.equal(encoded.startsWith("go2://join?"), true);
  assert.deepEqual(decodeJoinPayload(encoded), { roomId, token });
  assert.deepEqual(decodeJoinPayload(JSON.stringify({ v: 1, roomId, token })), { roomId, token });
});

test("join payload rejects unrelated codes", () => {
  assert.equal(decodeJoinPayload(""), null);
  assert.equal(decodeJoinPayload("https://example.com"), null);
  assert.equal(decodeJoinPayload("{"), null);
  assert.equal(isUuid("123e4567-e89b-41d3-a456-426614174000"), true);
  assert.equal(isUuid("not-a-uuid"), false);
});
