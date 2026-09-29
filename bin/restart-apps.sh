#!/usr/bin/env bash
# Последовательный перезапуск приложений «Зала» на релиз за симлинком current.
#
#   /opt/kinopap/bin/restart-apps.sh              # поднять текущий релиз
#   /opt/kinopap/bin/restart-apps.sh <каталог>    # поднять конкретный релиз
#
# Зачем отдельным файлом, а не строчками внутри heredoc'а деплоя. Перезапуск
# нужен в двух местах — при деплое и при откате, — и это не «pm2 restart всего»:
# приложения поднимаются по одному, и API обязан ответить на /healthz, прежде
# чем тронут воркер и веб. Продублируй мы эту логику, откат разошёлся бы с
# деплоем — ровно так, как уже разошлись подписи в двух клиентах.
#
# Почему delete+start, а не pm2 reload. cwd приложений — /opt/kinopap/current,
# то есть симлинк на релиз. PM2 хранит pm_cwd, разобранный при старте, и reload
# его не перечитывает: приложения продолжили бы работать из прежнего релиза, а
# деплой отрапортовал бы успех. delete+start читает ecosystem-файл заново и
# всегда попадает в актуальный релиз. Цена — секунда-две, пока порт свободен;
# для этого сайта это приемлемо, а тихий перезапуск не той версии — нет.
#
# torrserver здесь не перезапускается никогда: он держит состояние раздач, а
# его бинарь и данные лежат вне релиза (/opt/kinopap/bin, /opt/kinopap/data) и
# от деплоя не зависят.
set -euo pipefail

REL=${1:-/opt/kinopap/current}
REL=$(readlink -f "$REL")
ECOSYSTEM="$REL/ecosystem.config.cjs"
API_HEALTH=http://127.0.0.1:7001/healthz
TRIES=30
SLEEP=2

if [ ! -f "$ECOSYSTEM" ]; then
  echo "ОШИБКА: нет $ECOSYSTEM — релиз залит не целиком" >&2
  exit 1
fi

# ecosystem.config.cjs падает без DATABASE_URL. При деплое env уже загружен из
# /opt/kinopap/.env, при ручном запуске — загружаем сами: иначе скрипт умрёт на
# чужом сообщении вместо понятного.
if [ -z "${DATABASE_URL:-}" ] && [ -f /opt/kinopap/.env ]; then
  set -a
  . /opt/kinopap/.env
  set +a
fi

restart() {
  local name=$1
  pm2 delete "$name" >/dev/null 2>&1 || true
  if pm2 start "$ECOSYSTEM" --only "$name" >/dev/null; then
    echo "  $name: запущен"
    return 0
  fi
  echo "  ОШИБКА: pm2 не запустил $name" >&2
  pm2 logs "$name" --lines 20 --nostream >&2 || true
  return 1
}

echo "  релиз: $REL"

# API первым: он зависимость и веба, и воркера. Если он не поднялся, деплой
# обязан остановиться здесь, пока остальные ещё работают на прежнем релизе.
restart kinopap-api
for i in $(seq 1 "$TRIES"); do
  if curl -sf "$API_HEALTH" >/dev/null 2>&1; then break; fi
  if [ "$i" = "$TRIES" ]; then
    echo "  ОШИБКА: API не ответил на $API_HEALTH за $((TRIES * SLEEP)) с" >&2
    pm2 logs kinopap-api --lines 40 --nostream >&2 || true
    exit 1
  fi
  sleep "$SLEEP"
done
echo "  kinopap-api: /healthz отвечает"

restart kinopap-worker
restart kinopap-web

# Заводим torrserver, только если его нет вовсе (первый запуск на чистой машине).
if ! pm2 describe kinopap-torrserver >/dev/null 2>&1; then
  pm2 start "$ECOSYSTEM" --only kinopap-torrserver >/dev/null
  echo "  kinopap-torrserver: запущен"
fi

pm2 save >/dev/null
