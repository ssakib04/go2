export type QueueItemStatus = "pending" | "uploading" | "failed" | "blocked";

export type QueueItem = {
  id: string;
  userId: string;
  roomId: string;
  localUri: string;
  fileName: string;
  contentType: string;
  status: QueueItemStatus;
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
  createdAt: number;
};

export type QueueState = {
  items: QueueItem[];
};

export type UploadFailure = {
  ok: false;
  retryable: boolean;
  message: string;
};

export type UploadResult = { ok: true } | UploadFailure;

export const MAX_ATTEMPTS = 8;
const BACKOFF_BASE_MS = 2000;
const BACKOFF_CAP_MS = 5 * 60 * 1000;

export function emptyQueue(): QueueState {
  return { items: [] };
}

export function backoffMs(attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(BACKOFF_BASE_MS * 2 ** exponent, BACKOFF_CAP_MS);
}

export function classifyUploadFailure(status: number, errorCode: string | undefined): UploadFailure {
  const message = errorCode || `http_${status}`;
  if (status === 409 && (errorCode === "room_full" || errorCode === "room_closed")) {
    return { ok: false, retryable: false, message };
  }
  if (status === 400 || status === 401 || status === 403 || status === 404 || status === 413 || status === 415) {
    return { ok: false, retryable: false, message };
  }
  return { ok: false, retryable: true, message };
}

export function enqueue(
  state: QueueState,
  input: {
    id: string;
    userId: string;
    roomId: string;
    localUri: string;
    fileName: string;
    contentType: string;
    createdAt?: number;
  },
): QueueState {
  if (state.items.some((item) => item.id === input.id)) return state;
  const item: QueueItem = {
    id: input.id,
    userId: input.userId,
    roomId: input.roomId,
    localUri: input.localUri,
    fileName: input.fileName,
    contentType: input.contentType,
    status: "pending",
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: input.createdAt ?? Date.now(),
  };
  return { items: [...state.items, item] };
}

export function pickNext(state: QueueState, now: number, userId: string): QueueItem | null {
  const ready = state.items
    .filter((item) => item.userId === userId)
    .filter((item) => item.status === "pending" || item.status === "failed")
    .filter((item) => item.nextAttemptAt <= now)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return ready[0] ?? null;
}

export function markUploading(state: QueueState, id: string): QueueState {
  return mapItem(state, id, (item) => ({ ...item, status: "uploading", lastError: undefined }));
}

export function markUploaded(state: QueueState, id: string): QueueState {
  return { items: state.items.filter((item) => item.id !== id) };
}

export function markFailed(state: QueueState, id: string, failure: UploadFailure, now: number): QueueState {
  return mapItem(state, id, (item) => {
    const attempts = item.attempts + 1;
    const giveUp = !failure.retryable || attempts >= MAX_ATTEMPTS;
    return {
      ...item,
      attempts,
      status: giveUp ? "blocked" : "failed",
      nextAttemptAt: giveUp ? Number.MAX_SAFE_INTEGER : now + backoffMs(attempts),
      lastError: failure.message,
    };
  });
}

export function applyUploadResult(state: QueueState, id: string, result: UploadResult, now: number): QueueState {
  if (result.ok) return markUploaded(state, id);
  return markFailed(state, id, result, now);
}

export function retryItem(state: QueueState, id: string): QueueState {
  return mapItem(state, id, (item) => {
    if (item.status !== "failed" && item.status !== "blocked") return item;
    return { ...item, status: "pending", nextAttemptAt: 0, attempts: 0, lastError: undefined };
  });
}

export function retryAll(state: QueueState, userId: string): QueueState {
  return {
    items: state.items.map((item) => {
      if (item.userId !== userId) return item;
      if (item.status !== "failed" && item.status !== "blocked") return item;
      return { ...item, status: "pending", nextAttemptAt: 0, attempts: 0, lastError: undefined };
    }),
  };
}

export function removeItem(state: QueueState, id: string): QueueState {
  return { items: state.items.filter((item) => item.id !== id) };
}

export function resetInFlight(state: QueueState): QueueState {
  return {
    items: state.items.map((item) =>
      item.status === "uploading" ? { ...item, status: "pending", nextAttemptAt: 0 } : item
    ),
  };
}

export function countActiveForRoom(state: QueueState, roomId: string, userId: string): number {
  return state.items.filter((item) =>
    item.roomId === roomId &&
    item.userId === userId &&
    (item.status === "pending" || item.status === "uploading" || item.status === "failed")
  ).length;
}

export function serializeQueue(state: QueueState): string {
  return JSON.stringify(state);
}

export function hydrateQueue(raw: string | null): QueueState {
  if (!raw) return emptyQueue();
  try {
    const parsed = JSON.parse(raw) as QueueState;
    if (!parsed || !Array.isArray(parsed.items)) return emptyQueue();
    return resetInFlight({
      items: parsed.items.filter((item) =>
        typeof item?.id === "string" &&
        typeof item.userId === "string" &&
        typeof item.roomId === "string" &&
        typeof item.localUri === "string"
      ),
    });
  } catch {
    return emptyQueue();
  }
}

export async function runAvailable(
  state: QueueState,
  deps: {
    userId: string;
    now: () => number;
    upload: (item: QueueItem) => Promise<UploadResult>;
    limit?: number;
  },
): Promise<QueueState> {
  let current = state;
  const limit = deps.limit ?? 50;
  for (let step = 0; step < limit; step += 1) {
    const next = pickNext(current, deps.now(), deps.userId);
    if (!next) break;
    current = markUploading(current, next.id);
    const result = await deps.upload(next);
    current = applyUploadResult(current, next.id, result, deps.now());
  }
  return current;
}

function mapItem(state: QueueState, id: string, update: (item: QueueItem) => QueueItem): QueueState {
  return {
    items: state.items.map((item) => (item.id === id ? update(item) : item)),
  };
}
