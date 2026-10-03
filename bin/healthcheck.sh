#!/usr/bin/env bash
# Мониторинг «Зала» раз в 2 минуты (kinopap-healthcheck.timer).
#
# Проверяет: веб (:7000), API (:7001/healthz), TorrServer, Postgres, свободное
# место на диске и свежесть ночного бэкапа. Два провала подряд — перезапуск
# упавшего процесса pm2 и сообщение в Telegram; восстановление — тоже
# сообщение. Telegram включается файлом /etc/kinopap/alert.env:
#   TG_BOT_TOKEN=123:ABC
#   TG_CHAT_ID=123456
# Без него — только журнал (journalctl -u kinopap-healthcheck).
set -uo pipefail

STATE_DIR=/var/lib/kinopap-health
mkdir -p "$STATE_DIR"
[ -f /etc/kinopap/alert.env ] && . /etc/kinopap/alert.env
HOST=$(hostname -s)

log() { echo "[health] $*"; }

notify() {
  log "ALERT: $1"
  if [ -n "${TG_BOT_TOKEN:-}" ] && [ -n "${TG_CHAT_ID:-}" ]; then
    curl -s -m 10 -o /dev/null "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${TG_CHAT_ID}" --data-urlencode "text=🎬 kino.pap (${HOST}): $1" || true
  fi
}

# check <name> <command…>: два провала подряд → алерт (+ действие), успех после алерта → «восстановлено».
check() {
  local name=$1; shift
  local fails_file="$STATE_DIR/$name.fails" alerted_file="$STATE_DIR/$name.alerted"
  if "$@" >/dev/null 2>&1; then
    if [ -f "$alerted_file" ]; then notify "✅ $name снова в норме"; rm -f "$alerted_file"; fi
    rm -f "$fails_file"
    return 0
  fi
  local n=$(( $(cat "$fails_file" 2>/dev/null || echo 0) + 1 ))
  echo "$n" > "$fails_file"
  log "$name: провал $n"
  if [ "$n" -ge 2 ] && [ ! -f "$alerted_file" ]; then
    touch "$alerted_file"
    return 2
  fi
  return 1
}

http_ok() { curl -fsS -m 10 -o /dev/null "$1"; }

check web http_ok http://127.0.0.1:7000/
if [ $? -eq 2 ]; then pm2 restart kinopap-web >/dev/null 2>&1; notify "❌ веб не отвечает — перезапустил kinopap-web"; fi

check api http_ok http://127.0.0.1:7001/healthz
if [ $? -eq 2 ]; then pm2 restart kinopap-api >/dev/null 2>&1; notify "❌ API не отвечает — перезапустил kinopap-api"; fi

check torrserver http_ok http://127.0.0.1:7002/echo
if [ $? -eq 2 ]; then pm2 restart kinopap-torrserver >/dev/null 2>&1; notify "❌ TorrServer не отвечает — перезапустил"; fi

check postgres docker exec kinopap-postgres pg_isready -U zal -q
if [ $? -eq 2 ]; then docker start kinopap-postgres >/dev/null 2>&1; notify "❌ Postgres недоступен — docker start kinopap-postgres"; fi

disk_ok() { [ "$(df --output=pcent / | tail -1 | tr -dc 0-9)" -lt 90 ]; }
check disk disk_ok
if [ $? -eq 2 ]; then notify "⚠️ диск заполнен на $(df --output=pcent / | tail -1 | tr -d ' ')"; fi

# Ночной бэкап не старше 30 часов.
backup_ok() { [ -n "$(find /var/backups/kinopap -maxdepth 1 -name 'db-*.sql.gz' -mmin -1800 2>/dev/null | head -1)" ]; }
check backup backup_ok
if [ $? -eq 2 ]; then notify "⚠️ ночной бэкап БД не делался больше 30 часов"; fi

exit 0
