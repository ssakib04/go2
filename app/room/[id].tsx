import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import QRCode from "react-native-qrcode-svg";
import { useAuth } from "../../src/auth/AuthProvider";
import { Button, Card, ErrorNote, Muted, Pill, Screen, Title } from "../../src/components/ui";
import { getRoom, issueJoinToken, listMembers, listRecentPhotos, setRoomActive } from "../../src/lib/api";
import { errorText } from "../../src/lib/errors";
import { AuthCancelledError } from "../../src/lib/googleAuth";
import { encodeJoinPayload } from "../../src/lib/joinPayload";
import { readJoinToken } from "../../src/lib/joinTokens";
import { supabase } from "../../src/lib/supabase";
import type { PhotoMeta, Room, RoomMember } from "../../src/lib/types";
import { colors } from "../../src/theme";

export default function RoomScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const roomId = typeof id === "string" ? id : "";
  const auth = useAuth();
  const [room, setRoom] = useState<Room | null>(null);
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [photos, setPhotos] = useState<PhotoMeta[]>([]);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!roomId) return;
    try {
      const [nextRoom, nextMembers, nextPhotos, stored] = await Promise.all([
        getRoom(roomId),
        listMembers(roomId),
        listRecentPhotos(roomId),
        readJoinToken(roomId),
      ]);
      setRoom(nextRoom);
      setMembers(nextMembers);
      setPhotos(nextPhotos);
      setToken(stored);
      setError(nextRoom ? null : "This room is not available.");
    } catch (reason) {
      setError(errorText(reason));
    }
  }, [roomId]);

  useEffect(() => {
    const initial = setTimeout(() => { void refresh(); }, 0);
    const channel = supabase
      .channel(`room-${roomId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "rooms", filter: `id=eq.${roomId}` }, () => {
        void refresh();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "room_members", filter: `room_id=eq.${roomId}` }, () => {
        void refresh();
      })
      .subscribe();
    const poll = setInterval(() => { void refresh(); }, 12000);
    return () => {
      clearTimeout(initial);
      clearInterval(poll);
      void supabase.removeChannel(channel);
    };
  }, [refresh, roomId]);

  const isHost = room?.host_id === auth.session?.user.id;
  const full = !!room && room.current_photo_count >= room.max_photo_limit;

  async function rotate() {
    setBusy(true);
    setError(null);
    try {
      const next = await issueJoinToken(roomId);
      setToken(next);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }

  async function toggle() {
    if (!room) return;
    setBusy(true);
    try {
      await setRoomActive(room.id, !room.is_active);
      await refresh();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Button label="Back" variant="ghost" onPress={() => router.back()} />
      <View style={styles.row}>
        <Title>{room?.room_name ?? "Room"}</Title>
      </View>
      {room ? (
        <View style={styles.row}>
          <Pill label={room.is_active ? "Open" : "Closed"} tone={room.is_active ? "good" : "bad"} />
          <Pill label={full ? "Full" : "Space left"} tone={full ? "bad" : "neutral"} />
        </View>
      ) : null}
      <Text style={styles.count}>
        {room ? `${room.current_photo_count}` : "–"}
        <Text style={styles.countRest}> / {room?.max_photo_limit ?? "–"}</Text>
      </Text>
      <Muted>Photos in the host Drive folder. The count updates live.</Muted>
      <ErrorNote message={error} />

      {isHost ? (
        <Card>
          <Text style={styles.section}>Join QR</Text>
          {token && room ? (
            <View style={styles.qrWrap}>
              <QRCode
                value={encodeJoinPayload(room.id, token)}
                size={220}
                backgroundColor={colors.card}
                color={colors.ink}
              />
            </View>
          ) : (
            <Muted>This phone does not have the join code anymore. Issue a new one. The previous QR stops working.</Muted>
          )}
          <Button
            label={token ? "New QR code" : "Issue QR code"}
            variant="secondary"
            loading={busy}
            onPress={() => { void rotate(); }}
          />
        </Card>
      ) : null}

      <Button
        label={room?.is_active && !full ? "Open camera" : full ? "Room is full" : "Room is closed"}
        disabled={!room || !room.is_active || full}
        onPress={() => router.push(`/camera/${roomId}`)}
      />
      {isHost && room ? (
        <Button
          label={room.is_active ? "Close room" : "Reopen room"}
          variant="secondary"
          loading={busy}
          onPress={() => { void toggle(); }}
        />
      ) : null}
      {isHost ? (
        <Button
          label="Reconnect Drive"
          variant="secondary"
          loading={auth.busy}
          onPress={() => {
            void auth.connectDrive().catch((reason: unknown) => {
              if (reason instanceof AuthCancelledError) return;
              setError(errorText(reason));
            });
          }}
        />
      ) : null}

      <Text style={styles.section}>People</Text>
      {members.map((member) => (
        <Card key={member.id}>
          <Text style={styles.person}>{member.full_name || member.email}</Text>
          <Muted>{member.photos_uploaded} uploaded{member.user_id === room?.host_id ? " · Host" : ""}</Muted>
        </Card>
      ))}

      <Text style={styles.section}>Latest uploads</Text>
      {photos.length === 0 ? <Muted>No photos have landed yet.</Muted> : photos.map((photo) => (
        <Muted key={photo.id}>{photo.file_name}</Muted>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: 8, alignItems: "center" },
  count: { fontSize: 64, fontWeight: "700", color: colors.ink, letterSpacing: -2 },
  countRest: { fontSize: 28, color: colors.muted, fontWeight: "600" },
  section: { fontSize: 18, fontWeight: "700", color: colors.ink },
  qrWrap: { alignItems: "center", paddingVertical: 8 },
  person: { fontSize: 16, fontWeight: "700", color: colors.ink },
});
