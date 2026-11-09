import { CameraView, useCameraPermissions } from "expo-camera";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../../src/auth/AuthProvider";
import { Button, ErrorNote, Muted } from "../../src/components/ui";
import { getRoom } from "../../src/lib/api";
import { errorText } from "../../src/lib/errors";
import { persistCapture } from "../../src/lib/files";
import type { Room } from "../../src/lib/types";
import { useQueue } from "../../src/queue/QueueProvider";
import { colors } from "../../src/theme";

export default function CameraScreen() {
  const { roomId: rawId } = useLocalSearchParams<{ roomId: string }>();
  const roomId = typeof rawId === "string" ? rawId : "";
  const cameraRef = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [room, setRoom] = useState<Room | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const auth = useAuth();
  const queue = useQueue();

  const refresh = useCallback(async () => {
    try {
      setRoom(await getRoom(roomId));
    } catch (reason) {
      setError(errorText(reason));
    }
  }, [roomId]);

  useEffect(() => {
    const initial = setTimeout(() => { void refresh(); }, 0);
    const timer = setInterval(() => { void refresh(); }, 8000);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [refresh]);

  const queued = queue.countForRoom(roomId);
  const remaining = room ? room.max_photo_limit - room.current_photo_count - queued : 0;
  const blocked = !room || !room.is_active || remaining <= 0;

  async function capture() {
    if (!room || capturing) return;
    if (!room.is_active) {
      Alert.alert("Room closed", "The host closed this room.");
      return;
    }
    if (remaining <= 0) {
      Alert.alert("Room is full", "This room has reached its photo limit.");
      return;
    }
    setCapturing(true);
    setError(null);
    try {
      const photo = await cameraRef.current?.takePictureAsync({ quality: 0.7 });
      if (!photo?.uri) throw new Error("The camera did not return a photo.");
      const fileName = `photo-${Date.now()}.jpg`;
      const localUri = await persistCapture(photo.uri, fileName);
      await queue.enqueue({
        roomId,
        localUri,
        fileName,
        contentType: "image/jpeg",
      });
      setSaved("Saved to the upload queue");
      void refresh();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setCapturing(false);
    }
  }

  if (!permission?.granted) {
    return (
      <View style={styles.fallback}>
        <Muted>The camera takes photos straight into the room queue.</Muted>
        <Button label="Allow camera" onPress={() => { void requestPermission(); }} />
        <Button label="Back" variant="ghost" onPress={() => router.back()} />
      </View>
    );
  }

  return (
    <View style={styles.fill}>
      <CameraView ref={cameraRef} style={styles.fill} facing="back" mode="picture" />
      <View style={styles.top}>
        <Button label="Close" variant="secondary" onPress={() => router.back()} />
        <View style={styles.countChip}>
          <Text style={styles.countText}>
            {room ? `${room.current_photo_count + queued} / ${room.max_photo_limit}` : "…"}
          </Text>
        </View>
      </View>
      <View style={styles.bottom}>
        {blocked ? (
          <View style={styles.banner}>
            <Text style={styles.bannerText}>
              {!room?.is_active ? "This room is closed." : "Room limit reached. Capture is off."}
            </Text>
          </View>
        ) : null}
        <ErrorNote message={error} />
        {saved ? <Muted>{saved}</Muted> : null}
        <View style={styles.shutterRow}>
          <Button label="Queue" variant="secondary" onPress={() => router.push("/queue")} />
          <Button
            label={capturing ? "Saving" : "Shutter"}
            loading={capturing}
            disabled={blocked}
            onPress={() => { void capture(); }}
          />
        </View>
        {auth.profile ? null : <Muted>Sign in again if uploads stop.</Muted>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.ink },
  fallback: { flex: 1, backgroundColor: colors.paper, padding: 24, justifyContent: "center", gap: 16 },
  top: {
    position: "absolute",
    top: 54,
    left: 16,
    right: 16,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  countChip: {
    backgroundColor: colors.card,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  countText: { color: colors.ink, fontWeight: "700" },
  bottom: { position: "absolute", left: 16, right: 16, bottom: 28, gap: 10 },
  shutterRow: { flexDirection: "row", gap: 10 },
  banner: { backgroundColor: "#F8E6E1", borderRadius: 12, padding: 12 },
  bannerText: { color: colors.clay, fontWeight: "700" },
});
