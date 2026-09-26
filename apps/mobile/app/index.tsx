import { StyleSheet, Text, View } from "react-native";
import { tokens } from "@zal/ui";

/** Стартовый экран каркаса; каталог и плеер — следующие фазы. */
export default function HomeScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>
        Зал<Text style={styles.dot}>.</Text>
      </Text>
      <Text style={styles.subtitle}>
        Кино для своих. Каркас клиента на общем API — фаза 1.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: tokens.color.bg,
    justifyContent: "center",
    padding: tokens.space.lg,
  },
  title: {
    color: tokens.color.text,
    fontSize: tokens.fontSize.xxl,
    fontWeight: "700",
  },
  dot: {
    color: tokens.color.accent,
  },
  subtitle: {
    color: tokens.color.textMuted,
    fontSize: tokens.fontSize.md,
    marginTop: tokens.space.md,
    lineHeight: 24,
  },
});
