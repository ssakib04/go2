import { router } from "expo-router";
import { StyleSheet, Text, View } from "react-native";
import { Button, Card, Muted, Pill, Screen, Title } from "../src/components/ui";
import { useQueue } from "../src/queue/QueueProvider";
import { colors } from "../src/theme";

const LABEL = {
  pending: "Waiting",
  uploading: "Uploading",
  failed: "Retrying",
  blocked: "Stopped",
} as const;

export default function QueueScreen() {
  const queue = useQueue();
  return (
    <Screen>
      <Button label="Back" variant="ghost" onPress={() => router.back()} />
      <Title>Uploads</Title>
      <Muted>
        Photos stay on this phone until they reach the host Drive folder. The queue resumes when you reopen the app or come back online.
      </Muted>
      {queue.items.length > 0 ? (
        <Button label="Retry stopped uploads" variant="secondary" onPress={() => { void queue.retryEverything(); }} />
      ) : (
        <Card><Muted>Nothing is waiting.</Muted></Card>
      )}
      {queue.items.map((item) => (
        <Card key={item.id}>
          <View style={styles.row}>
            <Text style={styles.name}>{item.fileName}</Text>
            <Pill
              label={LABEL[item.status]}
              tone={item.status === "blocked" ? "bad" : item.status === "uploading" ? "good" : "neutral"}
            />
          </View>
          <Muted>{item.attempts > 0 ? `${item.attempts} attempts` : "Not sent yet"}{item.lastError ? ` · ${item.lastError}` : ""}</Muted>
          <View style={styles.row}>
            {item.status === "failed" || item.status === "blocked" ? (
              <Button label="Retry" variant="secondary" onPress={() => { void queue.retry(item.id); }} />
            ) : null}
            <Button label="Discard" variant="ghost" onPress={() => { void queue.discard(item.id); }} />
          </View>
        </Card>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  name: { flex: 1, fontSize: 16, fontWeight: "700", color: colors.ink },
});
