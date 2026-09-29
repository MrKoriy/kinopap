#!/usr/bin/env bash
# Ночной бэкап «Зала»: дамп БД + медиа, ротация по возрасту.
#
# Запускается таймером kinopap-backup.timer, а не руками: бэкап, который надо
# не забыть сделать, не бэкап. Запуск вручную (например, перед рискованной
# правкой) — тот же скрипт, ничего дополнительно указывать не нужно.
#
#   /opt/kinopap/bin/backup.sh
#
# ВАЖНО про проверку. Наличие файла ничего не доказывает: gzip от оборванного
# pg_dump получится валидным и маленьким, а `ls` покажет свежую дату. Поэтому
# скрипт сам проверяет архив (gzip -t + наличие ожидаемых таблиц + размер) и
# возвращает ненулевой код, если дамп подозрительный. Проверять бэкап
# восстановлением — отдельная команда, см. `--restore-check`.
set -euo pipefail

BACKUP_DIR=/var/backups/kinopap
KEEP_DAYS=14

CONTAINER=kinopap-postgres
DB_USER=zal
DB_NAME=zal
MEDIA_DIR=/opt/kinopap/media

# Дамп меньше этого — почти наверняка оборвался. Сейчас база ~82 МБ, таблиц
# около тридцати; порог с большим запасом, чтобы не срабатывать на пустой БД
# в первый день, но поймать пустой gzip.
MIN_DUMP_BYTES=10000

log() { echo "[backup] $*"; }

# Считаем таблицы во всех пользовательских схемах, а не только в public: в дамп
# попадает и схема drizzle со своей таблицей миграций, и сравнение «27 в дампе
# против 26 в БД» выглядело бы как расхождение, не будучи им.
LIVE_TABLES_SQL="select count(*) from information_schema.tables
  where table_schema not in ('pg_catalog','information_schema','pg_toast');"
live_tables() {
  docker exec "$1" psql -U "$2" -d "$3" -tAc "$LIVE_TABLES_SQL" | tr -d '[:space:]'
}

# --- проверка восстановлением: разворачивает дамп в одноразовую БД ---
# Отдельная ветка, потому что она пишет в postgres, а ночной прогон — нет.
if [ "${1:-}" = "--restore-check" ]; then
  DUMP="${2:-}"
  if [ -z "$DUMP" ] || [ ! -f "$DUMP" ]; then
    echo "использование: $0 --restore-check /var/backups/kinopap/db-YYYY-MM-DD.sql.gz" >&2
    exit 2
  fi
  SCRATCH="zal_restore_check_$$"
  # Уборка через trap, а не в конце: любая ветка с exit оставила бы за собой
  # базу-призрак, а следующая проверка упала бы на «database already exists».
  cleanup() {
    docker exec "$CONTAINER" psql -U "$DB_USER" -d postgres -q \
      -c "drop database if exists $SCRATCH;" >/dev/null 2>&1 || true
  }
  trap cleanup EXIT

  log "разворачиваю $DUMP в $SCRATCH"
  docker exec "$CONTAINER" psql -U "$DB_USER" -d postgres -q -c "create database $SCRATCH;" >/dev/null
  gzip -dc "$DUMP" | docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$SCRATCH" -q -v ON_ERROR_STOP=1 >/dev/null

  LIVE=$(live_tables "$CONTAINER" "$DB_USER" "$DB_NAME")
  RESTORED=$(live_tables "$CONTAINER" "$DB_USER" "$SCRATCH")
  log "таблиц в живой БД: $LIVE, в восстановленной: $RESTORED"

  # Сравнение идёт первым: если дамп неполный, сообщение должно быть про это,
  # а не про первую таблицу, которой в нём не оказалось.
  if [ "$LIVE" != "$RESTORED" ]; then
    log "ОШИБКА: число таблиц не совпало — дамп неполный"
    exit 1
  fi

  # Проверка на непустоту: дамп может быть полным по схеме и пустым по данным.
  # `|| echo 0` — чтобы отсутствие items дало понятный отказ ниже, а не
  # прервало скрипт ошибкой psql раньше диагностики.
  ITEMS=$(docker exec "$CONTAINER" psql -U "$DB_USER" -d "$SCRATCH" -tAc \
    "select count(*) from items;" 2>/dev/null | tr -d '[:space:]' || echo 0)
  log "тайтлов в восстановленной БД: ${ITEMS:-0}"
  if [ "${ITEMS:-0}" -lt 1 ]; then
    log "ОШИБКА: в восстановленной БД нет ни одного тайтла"
    exit 1
  fi
  log "восстановление прошло"
  exit 0
fi

mkdir -p "$BACKUP_DIR"
STAMP=$(date -u +%Y-%m-%d)
DB_OUT="$BACKUP_DIR/db-$STAMP.sql.gz"
MEDIA_OUT="$BACKUP_DIR/media-$STAMP.tar.gz"

# --- дамп БД ---
# pg_dump внутри контейнера: снаружи клиента нужной версии может не быть, а
# несовпадение мажорных версий pg_dump/сервер ломает дамп молча.
log "дамп $DB_NAME"
docker exec "$CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" --no-owner --clean --if-exists \
  | gzip -9 > "$DB_OUT.tmp"
mv "$DB_OUT.tmp" "$DB_OUT"

# --- проверка дампа ---
SIZE=$(stat -c %s "$DB_OUT")
if [ "$SIZE" -lt "$MIN_DUMP_BYTES" ]; then
  log "ОШИБКА: дамп $SIZE байт, меньше порога $MIN_DUMP_BYTES — оборвался"
  exit 1
fi
gzip -t "$DB_OUT"
# Таблицы в дампе ищем по имени: `CREATE TABLE public.items` и т.п. Если
# `--clean` сменит формат, проверка станет бесполезной — поэтому считаем и
# сверяем с живой БД, а не просто «есть хоть одна».
DUMP_TABLES=$(gzip -dc "$DB_OUT" | grep -c '^CREATE TABLE ')
LIVE_TABLES=$(live_tables "$CONTAINER" "$DB_USER" "$DB_NAME")
if [ "$DUMP_TABLES" -lt "$LIVE_TABLES" ]; then
  log "ОШИБКА: в дампе $DUMP_TABLES таблиц, в живой БД $LIVE_TABLES"
  exit 1
fi
log "БД: $DB_OUT ($((SIZE / 1024)) КиБ, таблиц $DUMP_TABLES из $LIVE_TABLES)"

# --- медиа ---
# Сейчас каталог пуст: сайт играет zero-storage через TorrServer, а MEDIA_ROOT
# нужен только локальному транскоду. Пишем размер в лог — когда он перестанет
# быть нулевым, это будет видно, а не выяснится при восстановлении.
if [ -d "$MEDIA_DIR" ] && [ -n "$(ls -A "$MEDIA_DIR" 2>/dev/null)" ]; then
  log "архив медиа"
  tar -czf "$MEDIA_OUT.tmp" -C "$(dirname "$MEDIA_DIR")" "$(basename "$MEDIA_DIR")"
  mv "$MEDIA_OUT.tmp" "$MEDIA_OUT"
  gzip -t "$MEDIA_OUT"
  log "медиа: $MEDIA_OUT ($(du -h "$MEDIA_OUT" | cut -f1))"
else
  log "медиа: каталог $MEDIA_DIR пуст — архивировать нечего"
fi

# --- ротация ---
# По возрасту, а не по счётчику: если бэкапы перестанут сниматься, счётчик
# «последние N файлов» будет вечно хранить старьё и выглядеть здоровым.
DELETED=$(find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.gz' -mtime "+$KEEP_DAYS" -print -delete | wc -l | tr -d '[:space:]')
log "ротация: удалено $DELETED файл(ов) старше $KEEP_DAYS дней"
log "в каталоге: $(find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.gz' | wc -l | tr -d '[:space:]') файл(ов), $(du -sh "$BACKUP_DIR" | cut -f1)"
