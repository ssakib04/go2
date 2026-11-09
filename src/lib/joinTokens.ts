import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "@go2/join-tokens/v1";

async function readAll(): Promise<Record<string, string>> {
  const raw = await AsyncStorage.getItem(KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export async function saveJoinToken(roomId: string, token: string): Promise<void> {
  const all = await readAll();
  all[roomId] = token;
  await AsyncStorage.setItem(KEY, JSON.stringify(all));
}

export async function readJoinToken(roomId: string): Promise<string | null> {
  const all = await readAll();
  return all[roomId] ?? null;
}
