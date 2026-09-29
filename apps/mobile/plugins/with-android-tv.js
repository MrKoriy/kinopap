/**
 * Expo config plugin: Android TV.
 *
 * Делает из обычного телефонного APK TV-приложение: ставит категорию
 * LEANBACK_LAUNCHER (иначе APK не появится в лончере Android TV), снимает
 * обязательность тачскрина и добавляет баннер 320×180.
 *
 * Разрешение на открытый HTTP отсюда убрано в `with-dev-cleartext`: оно нужно
 * обеим платформам и управляется одним флагом, а этот плагин — про TV и только
 * про TV.
 *
 * Применяется на prebuild: `npx expo prebuild --platform android`.
 */
const fs = require("node:fs");
const path = require("node:path");
const { withAndroidManifest, withDangerousMod } = require("expo/config-plugins");

/** Ресурс баннера должен лежать в res/drawable/tv_banner.png. */
const BANNER_NAME = "tv_banner";

function usesFeature(manifest, name, required) {
  const list = manifest["uses-feature"] ?? [];
  if (list.some((f) => f.$?.["android:name"] === name)) return list;
  list.push({
    $: { "android:name": name, "android:required": required ? "true" : "false" },
  });
  manifest["uses-feature"] = list;
  return list;
}

/** Категория LEANBACK_LAUNCHER на главной активити. */
function addLeanbackLauncher(app) {
  const activities = app.activity ?? [];
  const main = activities.find((a) =>
    (a["intent-filter"] ?? []).some((f) =>
      (f.action ?? []).some((a2) => a2.$?.["android:name"] === "android.intent.action.MAIN"),
    ),
  );
  if (!main) return;
  const filters = main["intent-filter"] ?? [];
  const hasLeanback = filters.some((f) =>
    (f.category ?? []).some((c) => c.$?.["android:name"] === "android.intent.category.LEANBACK_LAUNCHER"),
  );
  if (hasLeanback) return;
  filters.push({
    action: [{ $: { "android:name": "android.intent.action.MAIN" } }],
    category: [
      { $: { "android:name": "android.intent.category.LEANBACK_LAUNCHER" } },
    ],
  });
  main["intent-filter"] = filters;
}

module.exports = function withAndroidTv(config) {
  // 1. Манифест: leanback, баннер, необязательный тачскрин.
  config = withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    usesFeature(manifest, "android.software.leanback", false);
    usesFeature(manifest, "android.hardware.touchscreen", false);

    const app = manifest.application?.[0];
    if (app) {
      app.$ = app.$ ?? {};
      app.$["android:banner"] = `@drawable/${BANNER_NAME}`;
      addLeanbackLauncher(app);
    }
    return cfg;
  });

  // 2. Баннер из assets в drawable (ресурс android требует нижний регистр).
  config = withDangerousMod(config, [
    "android",
    async (cfg) => {
      const src = path.join(cfg.modRequest.projectRoot, "assets", "tv-banner.png");
      const dest = path.join(
        cfg.modRequest.platformProjectRoot,
        "app",
        "src",
        "main",
        "res",
        "drawable",
        `${BANNER_NAME}.png`,
      );
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
      }
      return cfg;
    },
  ]);

  return config;
};
