import AsyncStorage from "@react-native-async-storage/async-storage";
import { hydrateQueue, serializeQueue, type QueueState } from "./logic";

const KEY = "@go2/upload-queue/v1";

export async function loadQueue(): Promise<QueueState> {
  const raw = await AsyncStorage.getItem(KEY);
  return hydrateQueue(raw);
}

export async function saveQueue(state: QueueState): Promise<void> {
  await AsyncStorage.setItem(KEY, serializeQueue(state));
}
