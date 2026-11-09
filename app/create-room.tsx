import { router } from "expo-router";
import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useAuth } from "../src/auth/AuthProvider";
import { Body, Button, ErrorNote, Muted, Screen, Title } from "../src/components/ui";
import { createRoom } from "../src/lib/api";
import { errorText } from "../src/lib/errors";
import { colors } from "../src/theme";

const PRESETS = [100, 300, 500];

export default function CreateRoomScreen() {
  const auth = useAuth();
  const [name, setName] = useState("");
  const [limit, setLimit] = useState(300);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createWithDrive(forceConsent: boolean) {
    if (forceConsent || !auth.profile?.drive_linked) {
      await auth.connectDrive();
    }
    try {
      return await createRoom({ roomName: name.trim(), maxPhotoLimit: limit });
    } catch (reason) {
      if (!forceConsent && errorText(reason) === "drive_link_required") {
        return createWithDrive(true);
      }
      throw reason;
    }
  }

  async function submit() {
    const roomName = name.trim();
    if (roomName.length < 1) {
      setError("Name the room first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const room = await createWithDrive(false);
      await auth.refreshProfile();
      router.replace(`/room/${room.id}`);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Button label="Back" variant="ghost" onPress={() => router.back()} />
      <Title>New room</Title>
      <Body>
        Go2 creates a folder named Go2_[room]_[id] in your Drive. Guests never receive your Google token. Uploads go through the server.
      </Body>
      <Text style={styles.label}>Room name</Text>
      <TextInput
        value={name}
        onChangeText={setName}
        placeholder="Lisbon weekend"
        placeholderTextColor={colors.muted}
        maxLength={80}
        style={styles.input}
      />
      <Text style={styles.label}>Photo limit</Text>
      <View style={styles.presets}>
        {PRESETS.map((preset) => (
          <Pressable
            key={preset}
            onPress={() => setLimit(preset)}
            style={[styles.preset, limit === preset && styles.presetOn]}
          >
            <Text style={[styles.presetText, limit === preset && styles.presetTextOn]}>{preset}</Text>
          </Pressable>
        ))}
      </View>
      <TextInput
        value={String(limit)}
        onChangeText={(value) => {
          const next = Number(value.replace(/[^0-9]/g, ""));
          setLimit(Number.isFinite(next) ? next : 0);
        }}
        keyboardType="number-pad"
        style={styles.input}
      />
      <Muted>The cap is shared by the whole room and enforced one photo at a time.</Muted>
      <ErrorNote message={error} />
      <Button label="Create room" loading={busy || auth.busy} onPress={() => { void submit(); }} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 14, fontWeight: "700", color: colors.ink },
  input: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 14,
    fontSize: 16,
    color: colors.ink,
  },
  presets: { flexDirection: "row", gap: 8 },
  preset: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
  },
  presetOn: { backgroundColor: colors.pine, borderColor: colors.pine },
  presetText: { color: colors.ink, fontWeight: "700" },
  presetTextOn: { color: colors.white },
});
