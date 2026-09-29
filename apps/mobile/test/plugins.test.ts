/**
 * Политика открытого HTTP в сборках приложения.
 *
 * Плагины конфигурации — обычные функции, поэтому их можно прогнать здесь, не
 * поднимая prebuild. Это важно: `expo prebuild` переписывает каталоги android/ и
 * ios/, а проверить надо ровно одно — что разрешение на plaintext появляется
 * только с флагом. Без такого теста «только для dev» остаётся обещанием в
 * комментарии, а цена ошибки — релизная сборка, которая молча ходит по http.
 *
 * Мод вызывается с `await` не для красоты: `withMod` оборачивает действие в
 * async-функцию, и без ожидания на руках остаётся промис, а не конфиг.
 */
import { afterEach, describe, expect, it } from "vitest";
import withAndroidTv from "../plugins/with-android-tv";
import withDevCleartext from "../plugins/with-dev-cleartext";

interface ModResults {
  modResults: unknown;
}
type Mod = (config: Record<string, unknown>) => Promise<ModResults>;
interface PluginConfig {
  mods: Record<string, Record<string, Mod>>;
  [key: string]: unknown;
}
type Plugin = (config: PluginConfig) => PluginConfig;

interface Manifest {
  application: { $: Record<string, string> }[];
  "uses-feature": { $: Record<string, string> }[];
}

async function runManifest(plugin: Plugin): Promise<Manifest> {
  const config = plugin({ mods: {} });
  const out = await config.mods.android!.manifest!({
    ...config,
    modResults: { manifest: { application: [{ $: { "android:name": ".MainApplication" } }] } },
  });
  return (out.modResults as { manifest: Manifest }).manifest;
}

async function runInfoPlist(plugin: Plugin): Promise<Record<string, unknown>> {
  const config = plugin({ mods: {} });
  const out = await config.mods.ios!.infoPlist!({ ...config, modResults: {} });
  return out.modResults as Record<string, unknown>;
}

afterEach(() => {
  delete process.env.ZAL_ALLOW_CLEARTEXT;
});

describe("with-dev-cleartext", () => {
  it("без флага Android не разрешает cleartext", async () => {
    const app = (await runManifest(withDevCleartext)).application[0]!;
    expect(app.$["android:usesCleartextTraffic"]).toBeUndefined();
  });

  it("без флага iOS не трогает ATS", async () => {
    // Ключа не должно быть вовсе: пустой объект NSAppTransportSecurity — это не
    // то же самое, что отсутствие ключа, и лишний мусор в Info.plist.
    expect((await runInfoPlist(withDevCleartext)).NSAppTransportSecurity).toBeUndefined();
  });

  it("с флагом обе платформы разрешают открытый HTTP", async () => {
    process.env.ZAL_ALLOW_CLEARTEXT = "1";
    const app = (await runManifest(withDevCleartext)).application[0]!;
    expect(app.$["android:usesCleartextTraffic"]).toBe("true");
    expect((await runInfoPlist(withDevCleartext)).NSAppTransportSecurity).toEqual({
      NSAllowsArbitraryLoads: true,
    });
  });

  it("флаг читается на каждом прогоне, а не кэшируется между сборками", async () => {
    process.env.ZAL_ALLOW_CLEARTEXT = "1";
    expect(
      (await runManifest(withDevCleartext)).application[0]!.$["android:usesCleartextTraffic"],
    ).toBe("true");
    delete process.env.ZAL_ALLOW_CLEARTEXT;
    expect(
      (await runManifest(withDevCleartext)).application[0]!.$["android:usesCleartextTraffic"],
    ).toBeUndefined();
  });
});

describe("with-android-tv", () => {
  it("cleartext отсюда убран — политика живёт в одном месте", async () => {
    // Два источника правды на один флаг разъезжаются молча: включили в одном,
    // забыли в другом, и «почему-то на Android работает, а на iOS нет».
    process.env.ZAL_ALLOW_CLEARTEXT = "1";
    const app = (await runManifest(withAndroidTv)).application[0]!;
    expect(app.$["android:usesCleartextTraffic"]).toBeUndefined();
  });

  it("своё дело делает: TV-баннер и необязательный тачскрин", async () => {
    const manifest = await runManifest(withAndroidTv);
    expect(manifest.application[0]!.$["android:banner"]).toBe("@drawable/tv_banner");
    const features = manifest["uses-feature"].map((f) => f.$["android:name"]);
    expect(features).toContain("android.software.leanback");
    expect(features).toContain("android.hardware.touchscreen");
  });
});
