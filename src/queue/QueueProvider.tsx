import NetInfo from "@react-native-community/netinfo";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { useAuth } from "../auth/AuthProvider";
import { deleteCachedFile } from "../lib/files";
import { supabase } from "../lib/supabase";
import { uploadQueuedFile } from "../lib/api";
import {
  applyUploadResult,
  classifyUploadFailure,
  countActiveForRoom,
  emptyQueue,
  enqueue as enqueueItem,
  markUploading,
  pickNext,
  removeItem,
  retryAll,
  retryItem,
  type QueueItem,
  type QueueState,
} from "./logic";
import { loadQueue, saveQueue } from "./storage";

type QueueContextValue = {
  items: QueueItem[];
  pendingCount: number;
  enqueue: (input: {
    roomId: string;
    localUri: string;
    fileName: string;
    contentType: string;
  }) => Promise<void>;
  retry: (id: string) => Promise<void>;
  retryEverything: () => Promise<void>;
  discard: (id: string) => Promise<void>;
  countForRoom: (roomId: string) => number;
};

const QueueContext = createContext<QueueContextValue | null>(null);

export function QueueProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;
  const [state, setState] = useState<QueueState>(emptyQueue());
  const stateRef = useRef(state);
  const working = useRef(false);
  const chain = useRef(Promise.resolve());
  const userIdRef = useRef(userId);
  useEffect(() => {
    userIdRef.current = userId;
  }, [userId]);

  const mutate = useCallback((update: (current: QueueState) => QueueState) => {
    const run = chain.current.then(async () => {
      const next = update(stateRef.current);
      stateRef.current = next;
      setState(next);
      await saveQueue(next);
    });
    chain.current = run.then(() => undefined, () => undefined);
    return run;
  }, []);

  const kickRef = useRef<() => void>(() => {});

  const loop = useCallback(async () => {
    const activeUser = userIdRef.current;
    if (!activeUser || working.current) return;
    const net = await NetInfo.fetch();
    if (!net.isConnected) return;
    const next = pickNext(stateRef.current, Date.now(), activeUser);
    if (!next) return;

    working.current = true;
    try {
      await mutate((current) => markUploading(current, next.id));
      const sessionResult = await supabase.auth.getSession();
      const accessToken = sessionResult.data.session?.access_token;
      if (!accessToken) {
        await mutate((current) => applyUploadResult(
          current,
          next.id,
          { ok: false, retryable: true, message: "not_authenticated" },
          Date.now(),
        ));
        return;
      }
      let result;
      try {
        const uploaded = await uploadQueuedFile({
          accessToken,
          roomId: next.roomId,
          idempotencyKey: next.id,
          fileName: next.fileName,
          contentType: next.contentType,
          localUri: next.localUri,
        });
        result = uploaded.error
          ? classifyUploadFailure(uploaded.status, uploaded.error)
          : { ok: true as const };
      } catch (error) {
        result = {
          ok: false as const,
          retryable: true,
          message: error instanceof Error ? error.message : "network",
        };
      }
      if (result.ok) deleteCachedFile(next.localUri);
      await mutate((current) => applyUploadResult(current, next.id, result, Date.now()));
    } finally {
      working.current = false;
    }
    kickRef.current();
  }, [mutate]);

  useEffect(() => {
    kickRef.current = () => {
      void loop();
    };
  }, [loop]);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    loadQueue().then((loaded) => {
      if (cancelled) return;
      void mutate(() => loaded).then(() => kickRef.current());
    });
    const net = NetInfo.addEventListener((info) => {
      if (info.isConnected) kickRef.current();
    });
    const app = AppState.addEventListener("change", (status) => {
      if (status === "active") kickRef.current();
    });
    return () => {
      cancelled = true;
      net();
      app.remove();
    };
  }, [userId, mutate]);

  const enqueue = useCallback(async (input: {
    roomId: string;
    localUri: string;
    fileName: string;
    contentType: string;
  }) => {
    const activeUser = userIdRef.current;
    if (!activeUser) throw new Error("Sign in before taking photos.");
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    await mutate((current) => enqueueItem(current, {
      id,
      userId: activeUser,
      roomId: input.roomId,
      localUri: input.localUri,
      fileName: input.fileName,
      contentType: input.contentType,
    }));
    kickRef.current();
  }, [mutate]);

  const retry = useCallback(async (id: string) => {
    await mutate((current) => retryItem(current, id));
    kickRef.current();
  }, [mutate]);

  const retryEverything = useCallback(async () => {
    const activeUser = userIdRef.current;
    if (!activeUser) return;
    await mutate((current) => retryAll(current, activeUser));
    kickRef.current();
  }, [mutate]);

  const discard = useCallback(async (id: string) => {
    const item = stateRef.current.items.find((candidate) => candidate.id === id);
    if (item) deleteCachedFile(item.localUri);
    await mutate((current) => removeItem(current, id));
  }, [mutate]);

  const value = useMemo<QueueContextValue>(() => {
    const mine = userId ? state.items.filter((item) => item.userId === userId) : [];
    return {
      items: mine,
      pendingCount: mine.filter((item) => item.status !== "blocked").length,
      enqueue,
      retry,
      retryEverything,
      discard,
      countForRoom: (roomId: string) => (userId ? countActiveForRoom(state, roomId, userId) : 0),
    };
  }, [state, userId, enqueue, retry, retryEverything, discard]);

  return <QueueContext.Provider value={value}>{children}</QueueContext.Provider>;
}

export function useQueue(): QueueContextValue {
  const value = useContext(QueueContext);
  if (!value) throw new Error("useQueue must be used inside QueueProvider");
  return value;
}
