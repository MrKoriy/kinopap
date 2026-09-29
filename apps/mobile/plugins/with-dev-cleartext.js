/**
 * Expo config plugin: открытый HTTP только в dev-сборке.
 *
 * Зачем отдельный плагин. Приложению нужен http://<ip>:3001 — домашний API, к
 * которому ходит сборка на телефоне или телевизоре. Обе платформы по умолчанию
 * такой трафик режут: Android с 9-й версии (cleartext), iOS через ATS. Разрешать
 * его безусловно нельзя: это не «настройка разработчика», а дыра в релизной
 * сборке — по открытому каналу пойдут и токены, и запросы прогресса.
 *
 * Поэтому разрешение выдаётся ровно тогда, когда сборку собирают для себя:
 * `ZAL_ALLOW_CLEARTEXT=1 npx expo prebuild ...`. Флаг один на обе платформы
 * намеренно — иначе его легко включить на Android и забыть про iOS (или, что
 * хуже, оставить включённым в релизе и не заметить, потому что «на телефоне
 * всё работает»).
 *
 * Применяется на prebuild:
 *   ZAL_ALLOW_CLEARTEXT=1 npx expo prebuild --platform ios
 *   ZAL_ALLOW_CLEARTEXT=1 npx expo prebuild --platform android
 */

const { withAndroidManifest, withInfoPlist } = require("expo/config-plugins");

module.exports = function withDevCleartext(config) {
  const allowed = process.env.ZAL_ALLOW_CLEARTEXT === "1";

  // Android: android:usesCleartextTraffic на <application>.
  config = withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application?.[0];
    if (app && allowed) {
      app.$ = app.$ ?? {};
      app.$["android:usesCleartextTraffic"] = "true";
    }
    return cfg;
  });

  // iOS: ATS. Ключ добавляется целиком, а не правится по частям: без флага его
  // в Info.plist не должно быть вовсе, тогда ATS работает по умолчанию.
  config = withInfoPlist(config, (cfg) => {
    if (allowed) {
      cfg.modResults.NSAppTransportSecurity = {
        // Именно ArbitraryLoads, а не NSAllowsLocalNetworking: последний
        // покрывает .local и имена без точки, но не голые IP-адреса, а dev-API
        // живёт как раз по http://<ip>:3001.
        NSAllowsArbitraryLoads: true,
      };
    }
    return cfg;
  });

  return config;
};
