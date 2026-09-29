/**
 * Стили watch-экрана. Вынесены из компонента: экран — 950 строк логики
 * плеера, и стилевой блок в конце превращал файл в простыню, где поиск
 * кода требует прокрутки сотен строк.
 */
import { tokens } from "@zal/ui";
import { StyleSheet } from "react-native";

export const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: tokens.color.bg,
  },
  videoWrap: {
    width: "100%",
    alignSelf: "center",
    backgroundColor: "#000",
  },
  video: {
    width: "100%",
    height: "100%",
  },
  subtitleOverlay: {
    position: "absolute",
    left: tokens.space.md,
    right: tokens.space.md,
    bottom: tokens.space.sm,
    alignItems: "center",
  },
  subtitleText: {
    color: tokens.color.text,
    backgroundColor: "rgba(0,0,0,0.65)",
    fontSize: tokens.fontSize.md,
    textAlign: "center",
    paddingHorizontal: tokens.space.sm,
    paddingVertical: 2,
    borderRadius: tokens.radius.sm,
  },
  /** Оверлей обрыва потока: поверх замершего кадра, полупрозрачная вуаль. */
  errorOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: tokens.space.md,
    backgroundColor: "rgba(0,0,0,0.72)",
    paddingHorizontal: tokens.space.md,
  },
  errorTitle: {
    color: tokens.color.text,
    fontSize: tokens.fontSize.lg,
    fontWeight: "700",
    textAlign: "center",
  },
  errorButtons: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: tokens.space.sm,
    justifyContent: "center",
  },
  controls: {
    flex: 1,
    backgroundColor: tokens.color.bg,
  },
  controlsContent: {
    padding: tokens.space.md,
    gap: tokens.space.sm,
  },
  timeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.space.sm,
  },
  time: {
    color: tokens.color.textMuted,
    fontSize: tokens.fontSize.xs,
    fontVariant: ["tabular-nums"],
    minWidth: 44,
    textAlign: "center",
  },
  seekbar: {
    flex: 1,
    height: 6,
    borderRadius: tokens.radius.full,
    backgroundColor: tokens.color.surfaceHover,
    overflow: "hidden",
  },
  seekFill: {
    height: "100%",
    backgroundColor: tokens.color.accent,
  },
  /**
   * Серая полоса скачанного. Цвет задан напрямую, а не токеном: белый с
   * прозрачностью поверх тёмного трека — это приём, а не цвет палитры, и в
   * токенах его нет. Ровно так же сделано в веб-плеере (`bg-white/40`), чтобы
   * полоса выглядела одинаково на обеих платформах.
   */
  seekBuffered: {
    position: "absolute",
    top: 0,
    bottom: 0,
    backgroundColor: "rgba(255, 255, 255, 0.4)",
  },
  buttonRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: tokens.space.sm,
    alignItems: "center",
  },
  controlButton: {
    backgroundColor: tokens.color.surface,
    borderRadius: tokens.radius.full,
    borderWidth: 1,
    borderColor: tokens.color.border,
    paddingHorizontal: tokens.space.md,
    paddingVertical: tokens.space.sm,
  },
  controlActive: {
    borderColor: tokens.color.accent,
    backgroundColor: tokens.color.surfaceHover,
  },
  controlOff: {
    opacity: 0.4,
  },
  controlText: {
    color: tokens.color.text,
    fontSize: tokens.fontSize.sm,
    fontWeight: "600",
  },
  playButton: {
    backgroundColor: tokens.color.accent,
    borderRadius: tokens.radius.full,
    paddingHorizontal: tokens.space.lg,
    paddingVertical: tokens.space.sm,
  },
  playText: {
    color: tokens.color.text,
    fontSize: tokens.fontSize.sm,
    fontWeight: "700",
  },
  introButton: {
    backgroundColor: tokens.color.surfaceHover,
    borderRadius: tokens.radius.full,
    borderWidth: 1,
    borderColor: tokens.color.accent,
    alignItems: "center",
    paddingVertical: tokens.space.sm,
  },
  nextButton: {
    alignItems: "center",
    paddingVertical: tokens.space.sm,
  },
  dubSection: {
    marginTop: tokens.space.sm,
    gap: tokens.space.xs,
  },
  sectionTitle: {
    color: tokens.color.text,
    fontSize: tokens.fontSize.md,
    fontWeight: "700",
  },
  muted: {
    color: tokens.color.textMuted,
    fontSize: tokens.fontSize.sm,
  },
});
