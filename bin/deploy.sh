#!/usr/bin/env bash
# Деплой «Зал» на сервер (одна SSH-сессия через мультиплексинг).
# Локально: ./bin/deploy.sh
# Требует: ssh-доступ root@94.103.1.126 (Host kinopap в ~/.ssh/config).
set -euo pipefail

SERVER=kinopap
APP_DIR=/opt/kinopap
PUBLIC_URL="http://94.103.1.126"
API_INTERNAL="http://127.0.0.1:7001"
TMDB_KEY="${TMDB_API_KEY:?TMDB_API_KEY is required (export before deploy)}"

echo "==> 1/6: код на сервер (rsync, без node_modules/.next/.env/data/bin)"
rsync -az --delete \
  --exclude node_modules --exclude .next --exclude .turbo \
  --exclude .env --exclude data --exclude bin --exclude .git \
  --exclude test-results --exclude dist-e2e --exclude coverage \
  ./ "$SERVER:$APP_DIR/"

echo "==> 2/6: серверная часть (install, env, миграции, redis, nginx, build, pm2)"
ssh "$SERVER" bash -s <<REMOTE
set -euo pipefail
cd $APP_DIR

# --- env: дополняем недостающее, существующее не трогаем ---
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
add_env CORS_ORIGIN "$PUBLIC_URL"
add_env COOKIE_SECURE "0"
add_env MEDIA_ROOT "$APP_DIR/media"
add_env MEDIA_BASE_URL "$PUBLIC_URL/media"
add_env REDIS_URL "redis://127.0.0.1:6379"
add_env INTERNAL_API_URL "$API_INTERNAL"
add_env NEXT_PUBLIC_API_URL "$PUBLIC_URL"
# JWT_SECRET обязателен (>= 32 символов) — API не стартует без него.
if ! grep -q "^JWT_SECRET=.\{32,\}" .env; then
  echo "ОШИБКА: JWT_SECRET в .env отсутствует или короче 32 символов" >&2
  exit 1
fi

# --- Redis для BullMQ (воркер) ---
if ! command -v redis-server >/dev/null 2>&1; then
  apt-get install -y -qq redis-server >/dev/null
  systemctl enable --now redis-server
  echo "  + redis установлен"
fi

# --- nginx: /media отдаётся статикой прямо с диска (Range из коробки) ---
NGINX_SITE=/etc/nginx/sites-available/kinopap
if [ ! -f "\$NGINX_SITE" ] && ls /etc/nginx/sites-enabled/ >/dev/null 2>&1; then
  # Пытаемся найти конфиг, где проксируется 7001.
  CONF=\$(grep -rl "7001" /etc/nginx/sites-enabled/ 2>/dev/null | head -1 || true)
  [ -n "\$CONF" ] && NGINX_SITE="\$CONF"
fi
if [ -n "\$NGINX_SITE" ] && [ -f "\$NGINX_SITE" ] && ! grep -q "location /media/" "\$NGINX_SITE"; then
  python3 - "\$NGINX_SITE" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p).read()
block = """
    location /media/ {
        alias /opt/kinopap/media/;
        # Range для HLS-сегментов и Seeking.
        add_header Accept-Ranges bytes;
        add_header Cache-Control "public, max-age=86400";
        try_files \$uri \$uri/ =404;
    }
"""
# Вставляем внутрь server {} перед первым location.
m = re.search(r"location[^\{]*\{", s)
if m:
    s = s[:m.start()] + block.strip("\n") + "\n    " + s[m.start():]
    open(p, "w").write(s)
    print("nginx: /media добавлен")
PY
  nginx -t && systemctl reload nginx
fi
mkdir -p "$APP_DIR/media"

# --- зависимости ---
pnpm install --frozen-lockfile --prefer-offline 2>&1 | tail -1

# --- миграции + сид ---
pnpm db:setup 2>&1 | tail -2

# --- веб-сборка: NEXT_PUBLIC_API_URL инлайнится в бандл при билде ---
NEXT_PUBLIC_API_URL="$PUBLIC_URL" INTERNAL_API_URL="$API_INTERNAL" \
  pnpm --filter @zal/web build 2>&1 | tail -2

# --- PM2: воркер теперь в ecosystem; env из .env ---
set -a; . ./.env; set +a
pm2 startOrReload ecosystem.config.cjs
pm2 save
pm2 ls
REMOTE

echo "==> 3/6: ждём здоровья API"
for i in $(seq 1 30); do
  if ssh "$SERVER" "curl -sf http://127.0.0.1:7001/healthz" >/dev/null 2>&1; then
    echo "  api: ok"; break
  fi
  [ "$i" = 30 ] && { echo "  api не поднялся"; ssh "$SERVER" "pm2 logs kinopap-api --lines 50 --nostream"; exit 1; }
  sleep 2
done

echo "==> 4/6: постеры сида: обновляем метаданные из TMDb (битые URL чинятся)"
ssh "$SERVER" bash -s <<REMOTE
cd $APP_DIR
set -a; . ./.env; set +a
cd packages/db
npx tsx src/seed-catalog.ts 2>&1 | tail -3
REMOTE

echo "==> 5/6: смоук проверки"
ssh "$SERVER" bash -s <<REMOTE
echo -n "web:     "; curl -s -o /dev/null -w "%{http_code}\n" $PUBLIC_URL/
echo -n "api:     "; curl -s -o /dev/null -w "%{http_code}\n" $PUBLIC_URL/v1/items?limit=1
echo -n "media:   "; curl -s -o /dev/null -w "%{http_code}\n" $PUBLIC_URL/media/ 2>/dev/null || echo "(пока пусто)"
pm2 ls | grep kinopap
REMOTE

echo "==> 6/6: готово. Наполнение каталога: POST $PUBLIC_URL/v1/discover (owner)"
