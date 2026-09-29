#!/usr/bin/env bash
# Деплой «Зал» на сервер (одна SSH-сессия через мультиплексинг).
# Локально: ./bin/deploy.sh
# Требует: ssh-доступ root@94.103.1.126 (Host kinopap в ~/.ssh/config).
set -euo pipefail

SERVER=kinopap
APP_DIR=/opt/kinopap
PUBLIC_URL="http://94.103.1.126"
# HTTPS-адрес: имя в зоне sslip.io резолвится в тот же IP, сертификат Let's Encrypt
# выпущен (vhost zal-ssl). Нужен потому, что мобильные браузеры по умолчанию идут
# на HTTPS, а на 443 за голым IP отвечает чужой сертификат — телефон блокирует сайт.
HTTPS_URL="https://zal.94-103-1-126.sslip.io"
API_INTERNAL="http://127.0.0.1:7001"
TMDB_KEY="${TMDB_API_KEY:?export TMDB_API_KEY=... перед запуском}"

echo "==> 1/6: код на сервер (rsync, без node_modules/.next/.env/data/bin)"
# media/ исключён намеренно: это MEDIA_ROOT, рабочий каталог сервера. Локально
# его нет, и без --exclude rsync --delete вычистил бы оттуда всё залитое.
# .workbuddy-ai — заметки агента, на сервере не нужны.
rsync -az --delete \
  --exclude node_modules --exclude .next --exclude .turbo --exclude .expo \
  --exclude .env --exclude data --exclude bin --exclude .git \
  --exclude media --exclude .workbuddy-ai \
  --exclude test-results --exclude dist-e2e --exclude dist --exclude coverage \
  --exclude ios --exclude android \
  ./ "$SERVER:$APP_DIR/"

echo "==> 2/6: серверная часть (env, redis, nginx, install, миграции, build, pm2)"
# Неквотированный heredoc: локальные переменные подставляются здесь,
# удалённые — экранированы (\$).
ssh "$SERVER" bash -s <<REMOTE
set -euo pipefail
cd $APP_DIR

# --- env: дополняем недостающее, существующее перезаписываем актуальным ---
add_env() {
  local key=\$1 val=\$2
  if ! grep -q "^\${key}=" .env 2>/dev/null; then
    echo "\${key}=\${val}" >> .env
    echo "  + \${key}"
  else
    sed -i.bak "s|^\${key}=.*|\${key}=\${val}|" .env && rm -f .env.bak
    echo "  = \${key}"
  fi
}
touch .env
add_env TMDB_API_KEY "$TMDB_KEY"
add_env CORS_ORIGIN "$PUBLIC_URL,$HTTPS_URL"
# Сайт отдаётся по HTTPS, а порт 80 теперь только редиректит на него (vhost
# `default`). Значит refresh-cookie обязан идти с флагом Secure: по plain HTTP
# браузер такую cookie не отправит, и попасть туда можно лишь через редирект.
add_env COOKIE_SECURE "1"
add_env MEDIA_ROOT "$APP_DIR/media"
# Относительный путь: постеры и спрайты должны открываться и с http://<ip>,
# и с https://<имя>, а абсолютный http:// на HTTPS-странице браузер блокирует.
add_env MEDIA_BASE_URL "/media"
add_env REDIS_URL "redis://127.0.0.1:6379"
add_env INTERNAL_API_URL "$API_INTERNAL"
# Пусто = относительные URL API (lib/api.ts, lib/auth.tsx берут origin окна).
# Один билд обслуживает оба адреса; абсолютный http:// дал бы mixed content.
add_env NEXT_PUBLIC_API_URL ""
# То же для ссылок на потоки: TorrServer проксируется nginx на том же хосте,
# поэтому /gst/... и /stream?... обязаны быть относительными.
add_env TORRSERVER_PUBLIC_URL ""
add_env PORT "7001"
add_env DATABASE_URL "postgres://zal:zal@localhost:5433/zal"
# JWT_SECRET обязателен (>= 32 символов) — API не стартует без него.
if ! grep -q "^JWT_SECRET=.\{32,\}" .env; then
  echo "ОШИБКА: JWT_SECRET в .env отсутствует или короче 32 символов" >&2
  exit 1
fi

# Всё дальше (db:setup с DATABASE_URL, build, pm2) работает с env из .env.
set -a; . ./.env; set +a

# --- Redis для BullMQ (воркер) ---
if ! command -v redis-server >/dev/null 2>&1; then
  apt-get install -y -qq redis-server >/dev/null
  systemctl enable --now redis-server
  echo "  + redis установлен"
fi

# --- nginx: /media отдаётся статикой прямо с диска (Range из коробки) ---
# -R, а не -r: в sites-enabled лежат симлинки, и `grep -r` по ним не идёт —
# с -r список всегда пуст, поэтому весь блок ниже молча пропускался, и nginx на
# деплое не проверялся и не перезагружался. С -R находится ровно vhost сайта.
NGINX_SITE=\$(grep -Rl "7001" /etc/nginx/sites-enabled/ 2>/dev/null | head -1 || true)
if [ -n "\$NGINX_SITE" ]; then
  if ! grep -q "location /media/" "\$NGINX_SITE"; then
    python3 - "\$NGINX_SITE" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p).read()
block = """
    location /media/ {
        alias /opt/kinopap/media/;
        add_header Accept-Ranges bytes;
        add_header Cache-Control "public, max-age=86400";
        try_files \$uri \$uri/ =404;
    }
"""
m = re.search(r"location[^\{]*\{", s)
if m:
    s = s[:m.start()] + block.strip("\n") + "\n    " + s[m.start():]
    open(p, "w").write(s)
    print("nginx: /media добавлен")
PY
  fi
  # /gst — HLS-транскодер TorrServer (AAC-звук для браузеров). Сегменты
  # генерируются на лету — буферизация nginx выключена, таймаут длинный.
  if ! grep -q "location /gst/" "\$NGINX_SITE"; then
    python3 - "\$NGINX_SITE" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p).read()
block = """
    location /gst/ {
        proxy_pass http://127.0.0.1:7002;
        proxy_buffering off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
"""
m = re.search(r"location[^\{]*\{", s)
if m:
    s = s[:m.start()] + block.strip("\n") + "\n    " + s[m.start():]
    open(p, "w").write(s)
    print("nginx: /gst добавлен")
PY
  fi
  nginx -t && systemctl reload nginx
fi
mkdir -p "$APP_DIR/media"

# --- зависимости ---
pnpm install --frozen-lockfile --prefer-offline 2>&1 | tail -1

# --- миграции + сид (владелец/инвайты/жанры; идемпотентно) ---
pnpm db:setup 2>&1 | tail -2

# --- кэш media_sources: выкидываем ссылки с зашитым хостом ---
# Разрешённые ссылки лежат в БД до 6 часов и хранятся целиком, вместе с URL,
# которые строятся из TORRSERVER_PUBLIC_URL на момент резолва. Пока адрес был
# абсолютным, в кэше оседали http://<ip>/gst/... — на HTTPS-странице браузер их
# блокирует, и фильм не играет, хотя конфиг уже правильный. Сейчас ссылки
# относительные, поэтому строка с «http://» в кэше — по определению протухшая.
# Чистим до перезапуска API: иначе L1 в памяти подхватит старые строки обратно.
STALE=$(docker exec kinopap-postgres psql -U zal -d zal -tAc \
  "select count(*) from media_sources where files::text like '%http://%';" | tr -d '[:space:]')
if [ "\${STALE:-0}" != "0" ]; then
  docker exec kinopap-postgres psql -U zal -d zal -q -c \
    "delete from media_sources where files::text like '%http://%';" >/dev/null
  echo "  кэш ссылок: вычищено протухших записей — \$STALE"
else
  echo "  кэш ссылок: чисто"
fi

# --- веб-сборка: NEXT_PUBLIC_API_URL инлайнится в бандл при билде ---
# Пустое значение — намеренно: адрес API берётся из origin окна, поэтому один и
# тот же бандл работает и по http://<ip>, и по https://<имя>.
NEXT_PUBLIC_API_URL="" INTERNAL_API_URL="$API_INTERNAL" \
  pnpm --filter @zal/web build 2>&1 | tail -2

# --- PM2: воркер теперь в ecosystem; env уже в окружении из .env ---
pm2 startOrReload ecosystem.config.cjs
pm2 save
pm2 ls
REMOTE

echo "==> 3/6: ждём здоровья API"
for i in $(seq 1 30); do
  if ssh "$SERVER" "curl -sf http://127.0.0.1:7001/healthz" >/dev/null 2>&1; then
    echo "  api: ok"; break
  fi
  if [ "$i" = 30 ]; then
    echo "  api не поднялся:"; ssh "$SERVER" "pm2 logs kinopap-api --lines 40 --nostream"
    exit 1
  fi
  sleep 2
done

echo "==> 4/6: постеры сида: метаданные из TMDb (битые URL чинятся на месте)"
ssh "$SERVER" bash -s <<REMOTE
cd $APP_DIR
set -a; . ./.env; set +a
cd packages/db
npx tsx src/seed-catalog.ts 2>&1 | tail -3
REMOTE

echo "==> 5/6: смоук"
ssh "$SERVER" bash -s <<REMOTE
# Порт 80 теперь только редиректит на HTTPS: 301 здесь — ожидаемый ответ, а 200
# означал бы, что сайт снова отдаётся по http, где Secure-cookie не отправится.
echo -n "  http/ip:          "; curl -s -o /dev/null -w "%{http_code} -> %{redirect_url}\n" "$PUBLIC_URL/"
echo -n "  web (https/имя):  "; curl -s -o /dev/null -w "%{http_code}\n" $HTTPS_URL/
echo -n "  api (https/имя):  "; curl -s -o /dev/null -w "%{http_code}\n" "$HTTPS_URL/v1/items?limit=1"
echo -n "  docs (https/имя): "; curl -s -o /dev/null -w "%{http_code}\n" "$HTTPS_URL/docs"
# Абсолютный http:// в бандле = mixed content на HTTPS-странице. Ловим регрессию.
echo -n "  mixed content:    "
if grep -rq "$PUBLIC_URL" apps/web/.next/static/ 2>/dev/null; then
  echo "ЕСТЬ ($PUBLIC_URL в бандле) — на HTTPS-странице запросы заблокируются"
else
  echo "нет"
fi
# И то же в ответе API: ссылки на потоки тоже обязаны быть относительными.
# Бандл проверки мало — адрес потока приходит из ответа, а не из сборки.
PAIR=\$(docker exec kinopap-postgres psql -U zal -d zal -tAc \\
  "select item_id || ':' || id from media order by item_id limit 1;" | tr -d '[:space:]')
if [ -n "\$PAIR" ]; then
  BODY=\$(curl -s --max-time 90 "$HTTPS_URL/v1/items/\${PAIR%%:*}/media-links?mid=\${PAIR##*:}")
  ABS=\$(printf '%s' "\$BODY" | grep -o 'http://[^"]*' | wc -l | tr -d '[:space:]')
  FILES=\$(printf '%s' "\$BODY" | grep -o '"quality"' | wc -l | tr -d '[:space:]')
  echo -n "  ссылки API:       "
  if [ "\${ABS:-0}" = "0" ]; then
    echo "относительные (раздач \$FILES)"
  else
    echo "АБСОЛЮТНЫХ \$ABS — на HTTPS браузер их заблокирует"
  fi
fi
pm2 ls | grep kinopap
REMOTE

echo "==> 6/6: готово."
echo "Наполнить каталог: POST $HTTPS_URL/v1/discover (owner/admin, {\"pages\":2})"
