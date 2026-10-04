#!/usr/bin/env bash
# Настройки TorrServer под быстрый старт и фоновый прогрев (идемпотентно).
#
# Главное — дисковый кэш, переживающий «drop»: TorrServer выгружает раздачу
# через TorrentDisconnectTimeout без читателей, и RAM-кэш уходит вместе с ней.
# Прогрев API (PREWARM) тянет голову файла заранее — без диска она исчезала
# через полминуты. Теперь куски остаются в TS_CACHE_DIR, а объём держит
# kinopap-ts-prune.timer (TS_CACHE_MAX_GB, по умолчанию 25 ГБ). Головы файлов
# топ-N заранее читает воркер (stream-headwarm, STREAM_HEAD_WARM_TOP/STREAM_HEAD_MB).
set -euo pipefail
TS="${TORRSERVER_URL:-http://127.0.0.1:7002}"
DIR="${TS_CACHE_DIR:-/opt/kinopap/data/ts-cache}"
mkdir -p "$DIR"
CUR=$(curl -fsS -X POST "$TS/settings" -d '{"action":"get"}')
NEW=$(DIR="$DIR" python3 -c '
import json, os, sys
s = json.loads(sys.stdin.read())
s.update({
  "UseDisk": True,
  "TorrentsSavePath": os.environ["DIR"],
  "RemoveCacheOnDrop": False,
  "CacheSize": 512 * 1024 * 1024,
  "ResponsiveMode": True,
  "PreloadCache": 10,
  "ReaderReadAHead": 95,
  "ConnectionsLimit": 250,
  "TorrentDisconnectTimeout": 60,
})
print(json.dumps({"action": "set", "sets": s}))
' <<<"$CUR")
curl -fsS -X POST "$TS/settings" -d "$NEW" >/dev/null
echo "torrserver: настройки применены (disk cache: $DIR)"