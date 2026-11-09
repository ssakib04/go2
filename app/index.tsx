import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../src/auth/AuthProvider";
import { Body, Button, Card, ErrorNote, Muted, Pill, Screen, Title } from "../src/components/ui";
import { listHostedRooms, listJoinedRooms } from "../src/lib/api";
import { errorText } from "../src/lib/errors";
import type { Room } from "../src/lib/types";
import { useQueue } from "../src/queue/QueueProvider";
import { colors } from "../src/theme";

export default function HomeScreen() {
  const auth = useAuth();
  if (!auth.ready) {
    return (
      <Screen>
        <Title>Go2</Title>
        <Muted>Opening your session…</Muted>
      </Screen>
    );
  }
  if (!auth.session) return <SignedOut />;
  return <SignedIn />;
}

function SignedOut() {
  const auth = useAuth();
  return (
    <Screen>
      <Text style={styles.kicker}>Shared camera roll</Text>
      <Title>Go2</Title>
      <Body>
        A host opens a room in their own Google Drive. Everyone else scans a QR code, shoots in the app, and the photos upload themselves.
      </Body>
      <Card>
        <Text style={styles.cardTitle}>Guests share identity only</Text>
        <Muted>Drive access is requested later, and only from the person who creates a room.</Muted>
      </Card>
      <ErrorNote message={auth.error} />
      <Button label="Continue with Google" loading={auth.busy} onPress={() => { void auth.signIn(); }} />
      <Muted>This uses the native Google Sign-In SDK, so it needs an Expo development build rather than Expo Go.</Muted>
    </Screen>
  );
}

function SignedIn() {
  const auth = useAuth();
  const queue = useQueue();
  const [hosted, setHosted] = useState<Room[]>([]);
  const [joined, setJoined] = useState<Room[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!auth.session) return;
    try {
      const userId = auth.session.user.id;
      const [hostRooms, guestRooms] = await Promise.all([
        listHostedRooms(userId),
        listJoinedRooms(userId),
      ]);
      setHosted(hostRooms);
      setJoined(guestRooms);
      setError(null);
    } catch (reason) {
      setError(errorText(reason));
    }
  }, [auth.session]);

  useFocusEffect(useCallback(() => {
    void load();
  }, [load]));

  const name = auth.profile?.full_name || auth.profile?.email || "Signed in";

  return (
    <Screen>
      <View style={styles.topRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.kicker}>Hello</Text>
          <Title>Go2</Title>
          <Muted>{name}</Muted>
        </View>
        <Button label="Sign out" variant="ghost" onPress={() => { void auth.signOut(); }} />
      </View>
      <ErrorNote message={auth.error ?? error} />
      <Button label="Create a room" onPress={() => router.push("/create-room")} />
      <Button label="Scan a QR code" variant="secondary" onPress={() => router.push("/scan")} />
      <Button
        label={queue.pendingCount > 0 ? `Uploads (${queue.pendingCount})` : "Uploads"}
        variant="secondary"
        onPress={() => router.push("/queue")}
      />
      <RoomSection title="Rooms you host" rooms={hosted} empty="Create a room and the QR code shows up on the next screen." />
      <RoomSection title="Rooms you joined" rooms={joined} empty="Scan a host QR code to land in their Drive folder." />
    </Screen>
  );
}

function RoomSection({ title, rooms, empty }: { title: string; rooms: Room[]; empty: string }) {
  return (
    <View style={{ gap: 10 }}>
      <Text style={styles.section}>{title}</Text>
      {rooms.length === 0 ? <Muted>{empty}</Muted> : rooms.map((room) => (
        <Pressable key={room.id} onPress={() => router.push(`/room/${room.id}`)}>
          <Card>
            <View style={styles.topRow}>
              <Text style={styles.cardTitle}>{room.room_name}</Text>
              <Pill label={room.is_active ? "Open" : "Closed"} tone={room.is_active ? "good" : "bad"} />
            </View>
            <Muted>{room.current_photo_count} / {room.max_photo_limit} photos</Muted>
          </Card>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  kicker: {
    color: colors.pine,
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 1.2,
    textTransform: "uppercase",
  },
  topRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  section: { fontSize: 18, fontWeight: "700", color: colors.ink, marginTop: 8 },
  cardTitle: { fontSize: 18, fontWeight: "700", color: colors.ink, flex: 1 },
});
