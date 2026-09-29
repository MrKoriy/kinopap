/**
 * Стили экрана профиля: вынесены из компонента, как в watch-экране —
 * логика и вёрстка живут отдельно от стилевой простыни.
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
    gap: tokens.space.md,
    padding: tokens.space.lg,
    backgroundColor: tokens.color.bg,
  },
  title: {
    color: tokens.color.text,
    fontSize: tokens.fontSize.xl,
    fontWeight: "700",
  },
  muted: {
    color: tokens.color.textMuted,
    fontSize: tokens.fontSize.sm,
  },
  dangerText: {
    color: tokens.color.accent,
    fontSize: tokens.fontSize.sm,
    fontWeight: "600",
  },
  counters: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: tokens.space.sm,
    marginTop: tokens.space.md,
  },
  counter: {
    backgroundColor: tokens.color.surface,
    borderRadius: tokens.radius.md,
    borderWidth: 1,
    borderColor: tokens.color.border,
    paddingHorizontal: tokens.space.md,
    paddingVertical: tokens.space.sm,
    minWidth: 84,
  },
  counterValue: {
    color: tokens.color.text,
    fontSize: tokens.fontSize.md,
    fontWeight: "700",
  },
  counterLabel: {
    color: tokens.color.textMuted,
    fontSize: tokens.fontSize.xs,
  },
  section: {
    marginTop: tokens.space.lg,
    gap: tokens.space.xs,
  },
  sectionHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: tokens.space.xs,
  },
  sectionTitle: {
    color: tokens.color.text,
    fontSize: tokens.fontSize.lg,
    fontWeight: "700",
  },
  textButton: {
    paddingVertical: tokens.space.xs,
  },
  confirmBar: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: tokens.space.md,
    backgroundColor: tokens.color.surface,
    borderRadius: tokens.radius.md,
    padding: tokens.space.sm,
    marginBottom: tokens.space.xs,
  },
  confirmButton: {
    paddingHorizontal: tokens.space.sm,
    paddingVertical: tokens.space.xs,
  },
  histRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.space.sm,
    backgroundColor: tokens.color.surface,
    borderRadius: tokens.radius.md,
    padding: tokens.space.sm,
    marginBottom: tokens.space.xs,
  },
  histMain: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.space.sm,
  },
  histPoster: {
    width: 44,
    aspectRatio: 2 / 3,
    borderRadius: tokens.radius.sm,
    backgroundColor: tokens.color.surfaceHover,
  },
  histBody: {
    flex: 1,
    gap: 2,
  },
  histLabel: {
    color: tokens.color.text,
    fontSize: tokens.fontSize.sm,
    fontWeight: "600",
  },
  progressTrack: {
    height: 3,
    borderRadius: tokens.radius.full,
    backgroundColor: tokens.color.surfaceHover,
    overflow: "hidden",
    marginVertical: 2,
  },
  progressFill: {
    height: "100%",
    backgroundColor: tokens.color.accent,
  },
  iconButton: {
    paddingHorizontal: tokens.space.sm,
    paddingVertical: tokens.space.xs,
    borderRadius: tokens.radius.sm,
  },
  iconText: {
    color: tokens.color.textMuted,
    fontSize: tokens.fontSize.md,
    fontWeight: "700",
  },
  placeholder: {
    alignItems: "center",
    justifyContent: "center",
  },
  placeholderText: {
    color: tokens.color.textMuted,
    fontSize: tokens.fontSize.sm,
    fontWeight: "700",
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: tokens.space.sm,
  },
  cell: {
    width: 104,
    gap: tokens.space.xs,
  },
  cellLink: {
    gap: tokens.space.xs,
  },
  cellPoster: {
    width: "100%",
    aspectRatio: 2 / 3,
    borderRadius: tokens.radius.md,
    backgroundColor: tokens.color.surface,
  },
  cellTitle: {
    color: tokens.color.text,
    fontSize: tokens.fontSize.xs,
  },
  createRow: {
    flexDirection: "row",
    gap: tokens.space.sm,
    marginBottom: tokens.space.xs,
  },
  input: {
    flex: 1,
    backgroundColor: tokens.color.surface,
    borderRadius: tokens.radius.md,
    borderWidth: 1,
    borderColor: tokens.color.border,
    color: tokens.color.text,
    fontSize: tokens.fontSize.sm,
    paddingHorizontal: tokens.space.md,
    paddingVertical: tokens.space.sm,
  },
  createButton: {
    backgroundColor: tokens.color.accent,
    borderRadius: tokens.radius.md,
    justifyContent: "center",
    paddingHorizontal: tokens.space.md,
  },
  createOff: {
    opacity: 0.5,
  },
  listRow: {
    backgroundColor: tokens.color.surface,
    borderRadius: tokens.radius.md,
    padding: tokens.space.sm,
    marginBottom: tokens.space.xs,
  },
  listHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  listTitleWrap: {
    flex: 1,
    gap: 2,
  },
  listTitle: {
    color: tokens.color.text,
    fontSize: tokens.fontSize.sm,
    fontWeight: "600",
  },
  listItems: {
    marginTop: tokens.space.sm,
    gap: tokens.space.xs,
  },
  listItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.space.sm,
    backgroundColor: tokens.color.surfaceHover,
    borderRadius: tokens.radius.sm,
    paddingHorizontal: tokens.space.sm,
    paddingVertical: tokens.space.xs,
  },
  listItemLink: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.space.sm,
  },
  loginButton: {
    backgroundColor: tokens.color.accent,
    borderRadius: tokens.radius.full,
    paddingHorizontal: tokens.space.lg,
    paddingVertical: tokens.space.sm,
  },
  loginText: {
    color: tokens.color.text,
    fontSize: tokens.fontSize.sm,
    fontWeight: "700",
  },
});
