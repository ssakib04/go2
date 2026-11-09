import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { AuthProvider } from "../src/auth/AuthProvider";
import { QueueProvider } from "../src/queue/QueueProvider";
import { colors } from "../src/theme";

export default function RootLayout() {
  return (
    <AuthProvider>
      <QueueProvider>
        <StatusBar style="dark" />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors.paper },
          }}
        />
      </QueueProvider>
    </AuthProvider>
  );
}
