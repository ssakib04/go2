const JOIN_PROTOCOL = "go2:";
const JOIN_HOST = "join";

export type JoinPayload = {
  roomId: string;
  token: string;
};

export function encodeJoinPayload(roomId: string, token: string): string {
  const url = new URL(`${JOIN_PROTOCOL}//${JOIN_HOST}`);
  url.searchParams.set("room", roomId);
  url.searchParams.set("token", token);
  return url.toString();
}

export function decodeJoinPayload(raw: string): JoinPayload | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    if (trimmed.startsWith("{")) {
      const parsed = JSON.parse(trimmed) as { roomId?: unknown; token?: unknown };
      if (typeof parsed.roomId === "string" && typeof parsed.token === "string") {
        return { roomId: parsed.roomId, token: parsed.token };
      }
      return null;
    }
    const url = new URL(trimmed);
    if (url.protocol !== JOIN_PROTOCOL || url.hostname !== JOIN_HOST) return null;
    const roomId = url.searchParams.get("room");
    const token = url.searchParams.get("token");
    if (!roomId || !token) return null;
    return { roomId, token };
  } catch {
    return null;
  }
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
