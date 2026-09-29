/**
 * Стили карточки тайтла: вынесены из компонента по той же схеме, что
 * watch и profile — логика отдельно от стилевой простыни.
 */
import { tokens } from "@zal/ui";
import { StyleSheet } from "react-native";

export const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: tokens.color.bg,
  },
  content: {
    padding: tokens.space.md,
    paddingBottom: tokens.space.xl,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: tokens.color.bg,
  },
  headerRow: {
    flexDirection: "row",
    gap: tokens.space.md,
    marginBottom: tokens.space.md,
  },
  poster: {
    width: 110,
    aspectRatio: 2 / 3,
    borderRadius: tokens.radius.md,
    backgroundColor: tokens.color.surface,
  },
  headerText: {
    flex: 1,
    gap: 2,
  },
  title: {
    color: tokens.color.text,
    fontSize: tokens.fontSize.lg,
    fontWeight: "700",
  },
  metaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: tokens.space.sm,
    marginVertical: 2,
  },
  rating: {
    color: tokens.color.accent,
    fontSize: tokens.fontSize.sm,
    fontWeight: "700",
  },
  muted: {
    color: tokens.color.textMuted,
    fontSize: tokens.fontSize.sm,
  },
  plot: {
    color: tokens.color.text,
    fontSize: tokens.fontSize.sm,
    lineHeight: 21,
    marginTop: tokens.space.md,
  },
  section: {
    marginTop: tokens.space.lg,
    gap: tokens.space.xs,
  },
  seasonTitle: {
    color: tokens.color.text,
    fontSize: tokens.fontSize.md,
    fontWeight: "700",
    marginBottom: tokens.space.xs,
  },
  chips: {
    flexDirection: "row",
    gap: tokens.space.sm,
    paddingBottom: tokens.space.xs,
  },
  chip: {
    borderRadius: tokens.radius.full,
    backgroundColor: tokens.color.surface,
    borderWidth: 1,
    borderColor: tokens.color.border,
    paddingHorizontal: tokens.space.md,
    paddingVertical: tokens.space.xs,
  },
  chipActive: {
    backgroundColor: tokens.color.accent,
    borderColor: tokens.color.accent,
  },
  chipText: {
    color: tokens.color.text,
    fontSize: tokens.fontSize.sm,
    fontWeight: "600",
  },
  watchButton: {
    marginTop: tokens.space.md,
    backgroundColor: tokens.color.accent,
    borderRadius: tokens.radius.full,
    alignItems: "center",
    paddingVertical: tokens.space.md,
  },
  watchText: {
    color: tokens.color.text,
    fontSize: tokens.fontSize.md,
    fontWeight: "700",
  },
  trailerButton: {
    marginTop: tokens.space.sm,
    alignSelf: "flex-start",
    borderRadius: tokens.radius.full,
    borderWidth: 1,
    borderColor: tokens.color.border,
    backgroundColor: tokens.color.surface,
    paddingHorizontal: tokens.space.md,
    paddingVertical: tokens.space.sm,
  },
  trailerText: {
    color: tokens.color.text,
    fontSize: tokens.fontSize.sm,
    fontWeight: "600",
  },
  epRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.space.sm,
    backgroundColor: tokens.color.surface,
    borderRadius: tokens.radius.md,
    padding: tokens.space.sm,
  },
  epOff: {
    opacity: 0.5,
  },
  epThumb: {
    width: 64,
    height: 36,
    borderRadius: tokens.radius.sm,
    backgroundColor: tokens.color.surfaceHover,
  },
  epNumber: {
    color: tokens.color.accent,
    fontSize: tokens.fontSize.sm,
    fontWeight: "700",
    minWidth: 24,
    textAlign: "center",
  },
  epBody: {
    flex: 1,
    gap: tokens.space.xs,
  },
  epTitle: {
    flex: 1,
    color: tokens.color.text,
    fontSize: tokens.fontSize.sm,
  },
  progressTrack: {
    height: 3,
    borderRadius: tokens.radius.full,
    backgroundColor: tokens.color.surfaceHover,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    backgroundColor: tokens.color.accent,
  },
  doneMark: {
    color: tokens.color.success,
    fontSize: tokens.fontSize.md,
    fontWeight: "700",
  },
});
