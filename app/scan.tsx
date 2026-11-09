import { CameraView, useCameraPermissions } from "expo-camera";
import { router } from "expo-router";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button, ErrorNote, Muted, Screen, Title } from "../src/components/ui";
import { joinRoom } from "../src/lib/api";
import { errorText } from "../src/lib/errors";
import { decodeJoinPayload, isUuid } from "../src/lib/joinPayload";
import { colors } from "../src/theme";

export default function ScanScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);

  async function onScan(raw: string) {
    if (locked) return;
    const payload = decodeJoinPayload(raw);
    if (!payload || !isUuid(payload.roomId) || payload.token.length < 32) {
      setError("That QR code is not a Go2 room.");
      return;
    }
    setLocked(true);
    setError(null);
    try {
      await joinRoom(payload.roomId, payload.token);
      router.replace(`/room/${payload.roomId}`);
    } catch (reason) {
      const message = errorText(reason);
      if (message.includes("room_full")) setError("This room is full.");
      else if (message.includes("room_closed")) setError("This room is closed.");
      else if (message.includes("invalid_join_token")) setError("That join code is not valid anymore.");
      else setError(message);
      setLocked(false);
    }
  }

  if (!permission) {
    return <Screen><Title>Scan</Title><Muted>Checking camera permission…</Muted></Screen>;
  }

  if (!permission.granted) {
    return (
      <Screen>
        <Button label="Back" variant="ghost" onPress={() => router.back()} />
        <Title>Scan a room</Title>
        <Muted>Go2 needs the camera to read the host QR code.</Muted>
        <Button label="Allow camera" onPress={() => { void requestPermission(); }} />
      </Screen>
    );
  }

  return (
    <View style={styles.fill}>
      <CameraView
        style={styles.fill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={locked ? undefined : (event) => { void onScan(event.data); }}
      />
      <View style={styles.overlay}>
        <Button label="Back" variant="secondary" onPress={() => router.back()} />
        <Title>Point at the room QR</Title>
        <ErrorNote message={error} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.ink },
  overlay: {
    position: "absolute",
    left: 20,
    right: 20,
    bottom: 36,
    gap: 12,
  },
});
