#!/usr/bin/env bash
#
# Android TV smoke: поднимает TV-эмулятор, ставит release-APK, запускает его
# через LEANBACK_LAUNCHER, ходит по интерфейсу пультом (D-pad) и снимает
# скриншоты. API для приложения берётся из того, что вшито в бандл при сборке
# (EXPO_PUBLIC_API_URL), поэтому рядом обычно поднимают e2e-харнесс:
#
#   (cd apps/web && ZAL_E2E_LOG=1 npx tsx e2e/server.ts &)   # API на :3001
#   EXPO_PUBLIC_API_URL=http://10.0.2.2:3001 \
#     npx expo prebuild --platform android && \
#     (cd android && ./gradlew :app:assembleRelease)
#   ANDROID_HOME=... apps/mobile/e2e/tv-smoke.sh
#
# 10.0.2.2 — это хост из эмулятора: так TV-приложение видит локальный API.
set -euo pipefail

ANDROID_HOME=${ANDROID_HOME:?нужен ANDROID_HOME с platform-tools, emulator и system-images}
ADB="$ANDROID_HOME/platform-tools/adb"
EMULATOR="$ANDROID_HOME/emulator/emulator"
AVD=${ZAL_AVD:-zal-tv}
IMAGE=${ZAL_TV_IMAGE:-system-images;android-36;android-tv;arm64-v8a}
APK=${ZAL_APK:-$(cd "$(dirname "$0")/.." && pwd)/android/app/build/outputs/apk/release/app-release.apk}
OUT=${ZAL_SHOTS:-/tmp/zal-tv-shots}
BOOT_TIMEOUT=${ZAL_BOOT_TIMEOUT:-420}

mkdir -p "$OUT"
[ -f "$APK" ] || { echo "нет APK: $APK" >&2; exit 1; }

avd_home=${ANDROID_AVD_HOME:-$HOME/.android/avd}
if [ ! -d "$avd_home/$AVD.avd" ]; then
  echo "создаю AVD $AVD ($IMAGE, профиль tv_1080p)"
  echo no | "$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" create avd \
    -n "$AVD" -k "$IMAGE" -d tv_1080p --force
fi

echo "запускаю эмулятор (headless)"
"$EMULATOR" -avd "$AVD" -no-window -no-audio -no-boot-anim \
  -gpu swiftshader_indirect -no-snapshot -port 5554 > "$OUT/emulator.log" 2>&1 &

"$ADB" wait-for-device
echo "жду загрузку системы (до ${BOOT_TIMEOUT}с)"
deadline=$((SECONDS + BOOT_TIMEOUT))
booted=0
while [ $SECONDS -lt $deadline ]; do
  if [ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; then
    booted=1
    break
  fi
  sleep 5
done
[ $booted = 1 ] || { echo "эмулятор не загрузился за ${BOOT_TIMEOUT}с" >&2; exit 1; }
echo "система загружена"

shot() { "$ADB" exec-out screencap -p > "$OUT/$1.png"; echo "  скриншот $OUT/$1.png"; }
key() { "$ADB" shell input keyevent "$1" >/dev/null; sleep "$2"; }

"$ADB" install -r -g "$APK" 2>&1 | tail -1

echo "запуск через LEANBACK_LAUNCHER (как с пульта на TV)"
"$ADB" shell am start -a android.intent.action.MAIN \
  -c android.intent.category.LEANBACK_LAUNCHER \
  -n dev.zal.mobile/.MainActivity >/dev/null
sleep 25
shot tv-home

echo "ходим пультом: вниз ×3, вправо ×2 (фокус по лентам)"
key 20 2
key 20 2
key 20 2
key 22 2
key 22 2
shot tv-focus

echo "центр (DPAD_CENTER) — открыть то, что в фокусе"
key 23 12
shot tv-opened

echo "прямой путь к плееру (scheme zal://)"
"$ADB" shell am start -a android.intent.action.VIEW -d "zal://watch/1/1" >/dev/null
sleep 25
shot tv-player
sleep 12
shot tv-player2

echo "готово: скриншоты в $OUT"
