import { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, space } from "../theme";

export function Screen({
  children,
  scroll = true,
  footer,
}: {
  children: ReactNode;
  scroll?: boolean;
  footer?: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
      {scroll ? (
        <ScrollView
          contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 28 }]}
          keyboardShouldPersistTaps="handled"
        >
          {children}
        </ScrollView>
      ) : (
        <View style={styles.fill}>{children}</View>
      )}
      {footer ? <View style={{ paddingBottom: insets.bottom + 12, paddingHorizontal: space.lg }}>{footer}</View> : null}
    </View>
  );
}

export function Title({ children }: { children: string }) {
  return <Text style={styles.title}>{children}</Text>;
}

export function Body({ children }: { children: ReactNode }) {
  return <Text style={styles.body}>{children}</Text>;
}

export function Muted({ children }: { children: ReactNode }) {
  return <Text style={styles.muted}>{children}</Text>;
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Button({
  label,
  variant = "primary",
  loading = false,
  ...props
}: PressableProps & { label: string; variant?: "primary" | "secondary" | "danger" | "ghost"; loading?: boolean }) {
  const tone =
    variant === "primary" ? styles.primary :
    variant === "danger" ? styles.danger :
    variant === "ghost" ? styles.ghost :
    styles.secondary;
  const textTone = variant === "secondary" || variant === "ghost" ? styles.secondaryText : styles.primaryText;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled || loading}
      style={({ pressed }) => [styles.button, tone, (props.disabled || loading) && styles.disabled, pressed && styles.pressed]}
      {...props}
    >
      {loading ? <ActivityIndicator color={variant === "secondary" || variant === "ghost" ? colors.ink : colors.white} /> : (
        <Text style={[styles.buttonText, textTone]}>{label}</Text>
      )}
    </Pressable>
  );
}

export function Pill({ label, tone = "neutral" }: { label: string; tone?: "neutral" | "good" | "bad" }) {
  const background = tone === "good" ? colors.mist : tone === "bad" ? "#F8E6E1" : colors.paper;
  const color = tone === "good" ? colors.pineDark : tone === "bad" ? colors.clay : colors.muted;
  return (
    <View style={[styles.pill, { backgroundColor: background }]}>
      <Text style={[styles.pillText, { color }]}>{label}</Text>
    </View>
  );
}

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <View style={styles.errorBox}>
      <Text style={styles.errorText}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  fill: { flex: 1 },
  scroll: { paddingHorizontal: space.lg, gap: space.md },
  title: { fontSize: 34, lineHeight: 38, fontWeight: "700", color: colors.ink, letterSpacing: -0.8 },
  body: { fontSize: 16, lineHeight: 23, color: colors.ink },
  muted: { fontSize: 14, lineHeight: 20, color: colors.muted },
  card: {
    backgroundColor: colors.card,
    borderRadius: 18,
    padding: space.md,
    borderWidth: 1,
    borderColor: colors.line,
    gap: 8,
  },
  button: {
    minHeight: 52,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  primary: { backgroundColor: colors.pine },
  danger: { backgroundColor: colors.clay },
  secondary: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
  ghost: { backgroundColor: "transparent" },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.82 },
  buttonText: { fontSize: 16, fontWeight: "600" },
  primaryText: { color: colors.white },
  secondaryText: { color: colors.ink },
  pill: { alignSelf: "flex-start", borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  pillText: { fontSize: 12, fontWeight: "700", letterSpacing: 0.2 },
  errorBox: {
    backgroundColor: "#F8E6E1",
    borderRadius: 12,
    padding: 12,
  },
  errorText: { color: colors.clay, fontSize: 14, lineHeight: 20 },
});
