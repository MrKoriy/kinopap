#!/usr/bin/env bash
# Деплой «Зала» на сервер (одна SSH-сессия через мультиплексинг).
#
#   ./bin/deploy.sh              # выложить новый релиз
#   ./bin/deploy.sh --rollback   # вернуться на предыдущий релиз
#
# Требует: ssh-доступ root@94.103.1.126 (Host kinopap в ~/.ssh/config).
#
# Раскладка на сервере:
#
#   /opt/kinopap/releases/<ts>/   код релиза целиком (свой node_modules и .next)
#   /opt/kinopap/current          симлинк на живой релиз
#   /opt/kinopap/previous         симлинк на предыдущий (для отката)
#   /opt/kinopap/.env             общий, вне релиза
#   /opt/kinopap/media/           MEDIA_ROOT, вне релиза — иначе деплой осиротит залитое
#   /opt/kinopap/data/            состояние torrserver, вне релиза
#   /opt/kinopap/bin/             torrserver (61 МБ) и скрипты сервера, вне релиза
#
# Зачем. Раньше код лежал прямо в /opt/kinopap и обновлялся rsync'ом на месте:
# в любой момент времени там была смесь старых и новых файлов, а сборка и
# миграции шли поверх работающего сайта. Теперь релиз собирается целиком рядом,
# и переключается один симлинк — состояния «половина новая» не существует.
# Откат — переключение симлинка назад, а не восстановление из бэкапа.
set -euo pipefail

SERVER=kinopap
APP_DIR=/opt/kinopap
RELEASES_DIR=$APP_DIR/releases
CURRENT=$APP_DIR/current
PREVIOUS=$APP_DIR/previous
PUBLIC_URL="http://94.103.1.126"
# HTTPS-адрес: имя в зоне sslip.io резолвится в тот же IP, сертификат Let's Encrypt
# выпущен (vhost zal-ssl). Нужен потому, что мобильные браузеры по умолчанию идут
# на HTTPS, а на 443 за голым IP отвечает чужой сертификат — телефон блокирует сайт.
HTTPS_URL="https://zal.94-103-1-126.sslip.io"
API_INTERNAL="http://127.0.0.1:7001"

MODE=deploy
if [ "${1:-}" = "--rollback" ]; then MODE=rollback; fi

# Ключ TMDb нужен только сборке нового релиза. Требовать его для отката нельзя:
# откат нужен именно тогда, когда что-то сломалось, и лишняя переменная в этот
# момент — это ещё одна причина не откатиться.
TMDB_KEY=""
if [ "$MODE" = "deploy" ]; then
  : "${TMDB_API_KEY:?export TMDB_API_KEY=... перед запуском}"
  TMDB_KEY="$TMDB_API_KEY"
fi

# Метка релиза считается локально и подставляется в heredoc как $TS.
TS=$(date -u +%Y%m%d-%H%M%S)

# Проверка идёт до rsync, а не после: она про то, что уедет на сервер. Отдельным
# шагом её держать нельзя — про неё забывают, а цена забывчивости уже известна
# дважды (см. bin/audit-heredoc.sh). Скрипт сам решает, есть ли находки.
echo "==> 0/6: тело heredoc — локальные подстановки экранированы"
"$(dirname "$0")/audit-heredoc.sh"

if [ "$MODE" = "rollback" ]; then
  echo "==> откат: переключаю current на previous"
  ssh "$SERVER" bash -s <<REMOTE
set -euo pipefail

TARGET=\$(readlink -f $PREVIOUS || true)
NOW=\$(readlink -f $CURRENT || true)
# readlink -f возвращает сам путь, если его нет, — «не каталог» и означает
# «такого релиза нет».
[ -d "\$TARGET" ] || TARGET=""
[ -d "\$NOW" ] || NOW=""
if [ -z "\$TARGET" ]; then
  echo "ОШИБКА: предыдущего релиза нет ($PREVIOUS)" >&2
  exit 1
fi

echo "  было:  \$(basename "\${NOW:-нет}")"
echo "  станет: \$(basename "\$TARGET")"

# Меняем местами, чтобы откат был обратим: повторный --rollback вернёт назад.
ln -sfn "\$TARGET" $CURRENT.tmp && mv -T $CURRENT.tmp $CURRENT
if [ -n "\$NOW" ]; then
  ln -sfn "\$NOW" $PREVIOUS.tmp && mv -T $PREVIOUS.tmp $PREVIOUS
fi

if ! $APP_DIR/bin/restart-apps.sh; then
  echo "  ОШИБКА: откаченный релиз не поднялся — возвращаю \${NOW:-нет}" >&2
  if [ -n "\$NOW" ]; then
    ln -sfn "\$NOW" $CURRENT.tmp && mv -T $CURRENT.tmp $CURRENT
    $APP_DIR/bin/restart-apps.sh || true
  fi
  exit 1
fi
REMOTE
  echo "==> откат выполнен."
  exit 0
fi

echo "==> 1/6: релиз $TS — код на сервер"
ssh "$SERVER" "mkdir -p '$RELEASES_DIR/$TS'"
# Ведущий слэш у части шаблонов — не косметика. Без него --exclude совпадает с
# ЛЮБЫМ компонентом пути, и «--exclude media» выбрасывал из деплоя
# packages/ingest/src/media/ — probe.ts, assets.ts, ladder.ts, transcode.ts.
# На старой раскладке это не всплывало: rsync --delete исключённое не удаляет,
# поэтому файлы просто оставались на сервере с прошлого раза — и отстали на двое
# суток. Живой API и воркер всё это время импортировали их из /opt/kinopap.
# Свежий каталог релиза такое не прощает: сборка падает на «Cannot find module».
# Якорь нужен всему, что про корень репозитория, а не про вложенный каталог с
# таким же именем: /media, /data, /bin, /.env.
# Без якоря остаются те, что обязаны совпадать на любой глубине: node_modules,
# .next, .turbo, .expo, dist, coverage, ios, android и прочий вывод сборки.
rsync -az --delete \
  --exclude node_modules --exclude .next --exclude .turbo --exclude .expo \
  --exclude /.env --exclude /data --exclude /bin --exclude .git \
  --exclude /media --exclude .workbuddy-ai \
  --exclude test-results --exclude dist-e2e --exclude dist --exclude coverage \
  --exclude ios --exclude android \
  ./ "$SERVER:$RELEASES_DIR/$TS/"

# Скрипты сервера лежат вне релиза: их пути зашиты в systemd-юнит и в этот же
# деплой, поэтому обязаны быть стабильными. Из основного rsync bin/ исключён
# (там 61 МБ torrserver) — и именно поэтому bin/fill-catalog.sh на сервере
# отставал от репозитория на несколько правок, а заметить это было нечем:
# локальный файл выглядел рабочим, а на сервере работал старый.
rsync -az bin/backup.sh bin/fill-catalog.sh bin/restart-apps.sh \
  bin/nginx-tune.py bin/torrserver-tune.sh bin/ts-cache-prune.py \
  "$SERVER:$APP_DIR/bin/"
rsync -az bin/systemd/ "$SERVER:$APP_DIR/bin/systemd/"

echo "==> 2/6: сборка релиза (env, redis, postgres, nginx, install, миграции, build)"
# Неквотированный heredoc: локальные переменные подставляются здесь,
# удалённые — экранированы (\$).
ssh "$SERVER" bash -s <<REMOTE
set -euo pipefail

RELEASE=$RELEASES_DIR/$TS
if [ ! -f "\$RELEASE/package.json" ] || [ ! -f "\$RELEASE/docker-compose.yml" ]; then
  echo "ОШИБКА: релиз \$RELEASE залит не целиком" >&2
  exit 1
fi

# --- env: дополняем недостающее, существующее перезаписываем актуальным ---
# Файл общий для всех релизов и лежит вне них — иначе каждая новая версия
# начиналась бы с пустого .env.
cd $APP_DIR
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
# «default»). Значит refresh-cookie обязан идти с флагом Secure: по plain HTTP
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
# Абсолютный базовый адрес сайта (sitemap/OG-мета читают его в рантайме,
# серверная сторона — инлайн в бандл не важен). Без него site.ts уходит
# в localhost:3000, и карта сайта отдаёт ссылки никуда.
add_env NEXT_PUBLIC_SITE_URL "$HTTPS_URL"
# То же для ссылок на потоки: TorrServer проксируется nginx на том же хосте,
# поэтому /gst/... и /stream?... обязаны быть относительными.
add_env TORRSERVER_PUBLIC_URL ""
add_env PORT "7001"
add_env POSTGRES_PORT "5433"
# Пароль базы живёт в .env и только там. В репозитории он лежал открытым текстом
# рядом с адресом сервера — репозиторий публичный, и база была доступна снаружи
# (29.09.2026). Не выдумываем значение: если его нет, лучше остановиться, чем
# записать в .env неверный пароль и уронить API с мигающим «password
# authentication failed».
# «|| true» обязателен: на сервере set -e и pipefail, а grep без совпадений
# возвращает 1 — без этого присваивание упало бы и скрипт вышел раньше
# сообщения об ошибке, оставив непонятный тишиной отказ.
PG_PW=\$(grep -m1 '^POSTGRES_PASSWORD=' .env 2>/dev/null | cut -d= -f2- || true)
if [ -z "\$PG_PW" ]; then
  echo "ОШИБКА: POSTGRES_PASSWORD нет в $APP_DIR/.env." >&2
  echo "  Добавьте строку POSTGRES_PASSWORD=<текущий пароль базы> и повторите." >&2
  echo "  Текущий пароль: docker inspect kinopap-postgres --format '{{range .Config.Env}}{{println .}}{{end}}' | grep POSTGRES_PASSWORD" >&2
  exit 1
fi
add_env DATABASE_URL "postgres://zal:\${PG_PW}@localhost:5433/zal"
# JWT_SECRET обязателен (>= 32 символов) — API не стартует без него.
if ! grep -q "^JWT_SECRET=.\{32,\}" .env; then
  echo "ОШИБКА: JWT_SECRET в .env отсутствует или короче 32 символов" >&2
  exit 1
fi

# Всё дальше (db:setup с DATABASE_URL, build, pm2) работает с env из .env.
set -a; . ./.env; set +a

# --- Redis для BullMQ (воркер) ---
# В проде redis системный, а не контейнерный: он уже поднят, включён в автозапуск
# и обслуживает только очереди Зала. В docker-compose.yml сервис redis спрятан за
# профилем dev и слушает 6380 — иначе он спорил бы с системным за 6379.
if ! systemctl is-active --quiet redis-server; then
  if ! command -v redis-server >/dev/null 2>&1; then
    apt-get install -y -qq redis-server >/dev/null
  fi
  systemctl enable --now redis-server
  echo "  + redis запущен"
fi
# Проверяем не службу, а то, что на порту из REDIS_URL действительно отвечает
# redis: служба может быть active, а порт — занят чужим процессом.
# Разбор строки — параметрами оболочки, а не sed. В неквотированном heredoc
# регулярка, оканчивающаяся на «доллар», уезжает на сервер испорченной:
# локальная оболочка раскрывает доллар-решётку как число позиционных
# аргументов. Так и вышло — шаблон превратился в «s#/.*0#», и sed упал.
REDIS_HOSTPORT="\${REDIS_URL#redis://}"
REDIS_PORT="\${REDIS_HOSTPORT##*:}"
REDIS_PORT="\${REDIS_PORT%%/*}"
REDIS_HOST="\${REDIS_HOSTPORT%%:*}"
if ! redis-cli -h "\$REDIS_HOST" -p "\$REDIS_PORT" ping >/dev/null 2>&1; then
  echo "ОШИБКА: redis по адресу \$REDIS_URL не отвечает (служба: \$(systemctl is-active redis-server))" >&2
  exit 1
fi
echo "  redis: \$REDIS_HOST:\$REDIS_PORT отвечает"

# --- контейнеры: compose — единственный источник правды ---
# Файл берём из релиза, а переменные — из общего .env, который к этому моменту
# загружен в окружение (compose подставляет их из env раньше, чем из файла).
# Имя проекта в compose зафиксировано, том назван явно — поэтому запуск из
# каталога релиза не создаёт ни нового проекта, ни нового тома.
# База когда-то была поднята руками через docker run. Такой контейнер compose
# не признаёт своим и падает на конфликте имён, поэтому пересоздаём его: данные
# лежат в томе kinopap_pgdata, объявленном external, и пересоздание их не трогает.
COMPOSE_PROJECT=\$(docker inspect kinopap-postgres --format \
  '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null || true)
if [ "\$COMPOSE_PROJECT" != "kinopap" ]; then
  echo "  контейнер kinopap-postgres не под управлением compose (метка: '\${COMPOSE_PROJECT:-нет}') — пересоздаю"
  docker rm -f kinopap-postgres >/dev/null
fi
docker compose -f "\$RELEASE/docker-compose.yml" up -d postgres
# Ждём healthy: миграции ниже упадут, если база ещё поднимается.
for i in \$(seq 1 30); do
  if docker exec kinopap-postgres pg_isready -U zal -d zal >/dev/null 2>&1; then break; fi
  if [ "\$i" = "30" ]; then echo "ОШИБКА: postgres не поднялся" >&2; docker logs --tail 30 kinopap-postgres >&2; exit 1; fi
  sleep 2
done
echo "  postgres: \$(docker inspect kinopap-postgres --format '{{.State.Health.Status}}')"

# --- nginx: /media отдаётся статикой прямо с диска (Range из коробки) ---
# -R, а не -r: в sites-enabled лежат симлинки, и «grep -r» по ним не идёт —
# с -r список всегда пуст, поэтому весь блок ниже молча пропускался, и nginx на
# деплое не проверялся и не перезагружался. С -R находится ровно vhost сайта.
# Алиас указывает на $APP_DIR/media, а не на релиз: медиа переживает деплой.
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
  #
  # Раньше /gst/ проксировался наружу без проверки: любой мог попросить сервер
  # скачать и раздать произвольный торрент по хешу. Теперь, если в .env задан
  # GST_LINK_SECRET, наружу открыт только /gst-s/<expires>/<sig>/<hash>/... —
  # подпись выдаёт API участникам клуба (apps/api/src/lib/stream-links.ts),
  # nginx проверяет её модулем secure_link. Голый /gst/ — 403.
  # Блок управляемый (маркеры BEGIN/END): при смене секрета пересоздаётся.
  # Секрета подписи нет — создаём: без него /gst/ открыт наружу, и любой
  # может заставить сервер качать и раздавать произвольный торрент.
  if ! grep -q '^GST_LINK_SECRET=.\{32,\}' .env 2>/dev/null; then
    sed -i '/^GST_LINK_SECRET=/d' .env
    echo "GST_LINK_SECRET=\$(openssl rand -hex 32)" >> .env
    echo "  + GST_LINK_SECRET (сгенерирован)"
  fi
  GST_SECRET=\$(grep -m1 '^GST_LINK_SECRET=' .env 2>/dev/null | cut -d= -f2- || true)
  if [ -n "\$GST_SECRET" ]; then
    GST_LINK_SECRET="\$GST_SECRET" python3 - "\$NGINX_SITE" <<'PY'
import os, re, sys
p = sys.argv[1]
secret = os.environ["GST_LINK_SECRET"]
if not re.fullmatch(r"[A-Za-z0-9_\-]{32,}", secret):
    sys.exit("GST_LINK_SECRET: только [A-Za-z0-9_-], минимум 32 символа")
s = open(p).read()
# Старый открытый блок и прежняя версия управляемого — убираем.
s = re.sub(r"\n?[ \t]*# BEGIN kinopap-gst.*?# END kinopap-gst[^\n]*\n?", "\n", s, flags=re.S)
s = re.sub(r"\n?[ \t]*location /gst/ \{[^}]*\}\n?", "\n", s)
block = """
    # BEGIN kinopap-gst (managed by bin/deploy.sh)
    location /gst/ {
        return 403;
    }
    location ~ ^/gst-s/(?<gst_exp>[0-9]+)/(?<gst_sig>[A-Za-z0-9_-]+)/(?<gst_hash>[0-9a-fA-F]{40})/(?<gst_rest>.*)$ {
        secure_link \$gst_sig,\$gst_exp;
        secure_link_md5 "\$gst_exp\$gst_hash SECRET";
        if (\$secure_link = "") { return 403; }
        if (\$secure_link = "0") { return 410; }
        proxy_pass http://127.0.0.1:7002/gst/\$gst_hash/\$gst_rest\$is_args\$args;
        proxy_buffering off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
    # END kinopap-gst
""".replace("SECRET", secret)
m = re.search(r"location[^\{]*\{", s)
if m:
    s = s[:m.start()] + block.strip("\n").lstrip() + "\n    " + s[m.start():]
    open(p, "w").write(s)
    os.chmod(p, 0o640)
    print("nginx: /gst закрыт подписью (secure_link)")
PY
  else
    echo "  ВНИМАНИЕ: GST_LINK_SECRET не задан — /gst/ открыт наружу без проверки." >&2
    echo '  Сгенерируйте: echo "GST_LINK_SECRET=\$(openssl rand -hex 32)" >> .env' >&2
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
  fi
  # Перф-блок (gzip, микрокэш API, кэш постеров вне релизов, HTTP/2) и
  # закрытый /torrents. Не прошёл nginx -t — возвращаем прежний vhost.
  cp "\$NGINX_SITE" /tmp/kinopap-vhost.prev
  python3 $APP_DIR/bin/nginx-tune.py "\$NGINX_SITE"
  if nginx -t 2>/tmp/kinopap-nginx-t.log; then
    systemctl reload nginx
  else
    cat /tmp/kinopap-nginx-t.log >&2
    echo "  ВНИМАНИЕ: nginx -t не прошёл — откатываю vhost" >&2
    cat /tmp/kinopap-vhost.prev > "\$NGINX_SITE"
    rm -f /etc/nginx/conf.d/kinopap-cache.conf
    nginx -t && systemctl reload nginx
  fi
fi
mkdir -p "$APP_DIR/media"

# --- ночной бэкап: юниты из репозитория, а не «когда-то поставленные руками» ---
# Иначе после пересборки машины бэкапов не будет, и узнается об этом при
# восстановлении. Установка идемпотентна, включение таймера тоже.
if [ -d "$APP_DIR/bin/systemd" ]; then
  install -m 644 "$APP_DIR/bin/systemd/kinopap-backup.service" /etc/systemd/system/
  install -m 644 "$APP_DIR/bin/systemd/kinopap-backup.timer" /etc/systemd/system/
  install -m 644 "$APP_DIR/bin/systemd/kinopap-ts-prune.service" /etc/systemd/system/
  install -m 644 "$APP_DIR/bin/systemd/kinopap-ts-prune.timer" /etc/systemd/system/
  chmod +x "$APP_DIR/bin/backup.sh" "$APP_DIR/bin/fill-catalog.sh" "$APP_DIR/bin/restart-apps.sh"
  systemctl daemon-reload
  systemctl enable --now kinopap-backup.timer >/dev/null 2>&1 || true
  systemctl enable --now kinopap-ts-prune.timer >/dev/null 2>&1 || true
fi

# --- кэш media_sources: выкидываем ссылки с зашитым хостом ---
# Разрешённые ссылки лежат в БД до 6 часов и хранятся целиком, вместе с URL,
# которые строятся из TORRSERVER_PUBLIC_URL на момент резолва. Пока адрес был
# абсолютным, в кэше оседали http://<ip>/gst/... — на HTTPS-странице браузер их
# блокирует, и фильм не играет, хотя конфиг уже правильный. Сейчас ссылки
# относительные, поэтому строка с «http://» в кэше — по определению протухшая.
# Чистим до перезапуска API: иначе L1 в памяти подхватит старые строки обратно.
# ВАЖНО: подстановки здесь обязаны быть экранированы обратным слешем. Heredoc
# неквотированный, поэтому неэкранированная подстановка выполнится локальной
# оболочкой, и на сервер уедет пустая строка — проверка будет вечно «зелёной»,
# ничего не проверив. Так уже было со STALE: docker искался на маке, ветка всегда
# давала «чисто», а кэш не чистился.
STALE=\$(docker exec kinopap-postgres psql -U zal -d zal -tAc \
  "select count(*) from media_sources where files::text like '%http://%';" | tr -d '[:space:]')
TOTAL=\$(docker exec kinopap-postgres psql -U zal -d zal -tAc \
  "select count(*) from media_sources;" | tr -d '[:space:]')
if [ "\${STALE:-0}" != "0" ]; then
  docker exec kinopap-postgres psql -U zal -d zal -q -c \
    "delete from media_sources where files::text like '%http://%';" >/dev/null
  echo "  кэш ссылок: вычищено протухших записей — \$STALE (всего было \$TOTAL)"
else
  # Счётчик печатаем всегда: без него «чисто» неотличимо от «запрос не выполнился».
  echo "  кэш ссылок: протухших нет (в таблице \$TOTAL)"
fi

# --- сборка релиза ---
cd "\$RELEASE"
# Симлинк на общий .env: docker compose подставляет переменные сначала из
# окружения, и без .env в релизе он тоже работает — проверено на копии
# compose-файла в каталоге без .env. Симлинк всё равно ставим: с ним релиз
# самодостаточен, и «docker compose» руками внутри current ведёт себя так же,
# как в деплое, а не «работает, пока кто-то помнит про set -a».
ln -sfn $APP_DIR/.env "\$RELEASE/.env"

# Несобранный релиз убираем за собой: в current он не попал, но это 1.2 ГБ
# node_modules и .next, а уборка держит три свежих релиза и такую мелочь не
# заметит — она лежала бы до четвёртого удачного деплоя. Логи не трогаем.
fail() {
  echo "ОШИБКА: \$1" >&2
  rm -rf "\$RELEASE"
  exit 1
}

# Вывод пишем в файл, а не в «| tail -N»: при падении хвост нужно показать
# целиком, а не две строки. Первый же деплой в новой раскладке упал на сборке
# web, и «tail -2» оставил от диагностики одну строку
# ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL — настоящая причина (десять «Cannot find
# module» в packages/ingest/src/media) была видна только при ручном прогоне.
if ! pnpm install --frozen-lockfile --prefer-offline > /tmp/kinopap-install.log 2>&1; then
  tail -30 /tmp/kinopap-install.log >&2
  fail "pnpm install упал (полный лог: /tmp/kinopap-install.log)"
fi
tail -1 /tmp/kinopap-install.log

# Миграции обязаны быть аддитивными: до переключения симлинка на этом же коде
# продолжает работать прежний релиз, и удалённая колонка уронит живой сайт.
# Обратной совместимости здесь не на чем стоять — её обеспечивает только
# порядок «сначала добавили, потом убрали в следующем релизе».
# ZAL_DEPLOY=1: сид не создаёт дефолтного владельца owner@zal.local/change-me-owner.
if ! ZAL_DEPLOY=1 pnpm db:setup > /tmp/kinopap-db-setup.log 2>&1; then
  tail -30 /tmp/kinopap-db-setup.log >&2
  fail "миграции/сид упали (полный лог: /tmp/kinopap-db-setup.log)"
fi
tail -2 /tmp/kinopap-db-setup.log

# NEXT_PUBLIC_API_URL инлайнится в бандл при билде. Пустое значение — намеренно:
# адрес API берётся из origin окна, поэтому один и тот же бандл работает и по
# http://<ip>, и по https://<имя>.
if ! NEXT_PUBLIC_API_URL="" INTERNAL_API_URL="$API_INTERNAL" \
     pnpm --filter @zal/web build > /tmp/kinopap-web-build.log 2>&1; then
  tail -40 /tmp/kinopap-web-build.log >&2
  fail "сборка web упала (полный лог: /tmp/kinopap-web-build.log)"
fi
tail -2 /tmp/kinopap-web-build.log
REMOTE

echo "==> 3/6: переключение current и последовательный перезапуск"
ssh "$SERVER" bash -s <<REMOTE
set -euo pipefail

RELEASE=$RELEASES_DIR/$TS
# readlink -f возвращает сам путь, если его нет, а не пустую строку: на первом
# деплое PREV оказался бы строкой «/opt/kinopap/current». Поэтому «не каталог»
# явно превращаем в «предыдущего релиза нет».
PREV=\$(readlink -f $CURRENT || true)
[ -d "\$PREV" ] || PREV=""

# Переключение атомарно: ln -sfn сначала удаляет старый симлинк, и в этот
# момент current не существует вовсе. mv -T поверх симлинка — одна операция.
if [ -n "\$PREV" ]; then
  ln -sfn "\$PREV" $PREVIOUS.tmp && mv -T $PREVIOUS.tmp $PREVIOUS
fi
ln -sfn "\$RELEASE" $CURRENT.tmp && mv -T $CURRENT.tmp $CURRENT
echo "  current -> \$(basename "\$RELEASE")"

# Приложения поднимаются по одному, API первым и с проверкой здоровья: если он
# не поднялся, остальные ещё работают на прежнем релизе, и откат стоит одного
# переключения симлинка.
if ! $APP_DIR/bin/restart-apps.sh; then
  echo "  ОШИБКА: релиз \$(basename "\$RELEASE") не поднялся" >&2
  if [ -n "\$PREV" ]; then
    echo "  откат на \$(basename "\$PREV")" >&2
    ln -sfn "\$PREV" $CURRENT.tmp && mv -T $CURRENT.tmp $CURRENT
    $APP_DIR/bin/restart-apps.sh || true
  else
    echo "  предыдущего релиза нет — откатывать некуда" >&2
    # Это бывает только на первом деплое: старый код ещё лежит в $APP_DIR вместе
    # со своим ecosystem-файлом (cwd = $APP_DIR). Он и есть путь назад.
    if [ -f "$APP_DIR/ecosystem.config.cjs" ]; then
      echo "  прежний код цел в $APP_DIR, вернуть так:" >&2
      echo "    pm2 delete kinopap-api kinopap-worker kinopap-web" >&2
      echo "    pm2 start $APP_DIR/ecosystem.config.cjs" >&2
    fi
  fi
  exit 1
fi

# --- первый деплой в раскладке releases/ ---
# До перехода код лежал прямо в $APP_DIR, и там же были .env/media/data/bin.
# Теперь код уезжает в релиз, а общее остаётся на месте.
#
# Убираем старый код только здесь — после того, как новый релиз поднялся и
# ответил. Раньше нельзя: файлы читают живые процессы (Next.js дочитывает чанки
# из .next, tsx компилирует модули на лету), и перенос из-под работающего сайта
# — это ровно тот случай, когда «просто mv» роняет прод, причём тихо.
#
# И ничего не удаляем: переносим целиком, чтобы переход можно было отыграть
# назад. 1.2 ГБ node_modules там уже мусор, но решать это не деплою.
if [ -d "$APP_DIR/apps" ]; then
  LEGACY=$APP_DIR/legacy-$TS
  mkdir -p "\$LEGACY"
  for p in apps packages node_modules docs .github .next pnpm-lock.yaml pnpm-workspace.yaml package.json ecosystem.config.cjs docker-compose.yml biome.json tsconfig.base.json turbo.json README.md AGENTS.md .env.example; do
    if [ -e "$APP_DIR/\$p" ]; then mv "$APP_DIR/\$p" "\$LEGACY/"; fi
  done
  echo "  старый код перенесён в \$LEGACY"
  echo "  выбросить, когда всё устоится: rm -rf \$LEGACY"
fi

# --- уборка старых релизов ---
# Держим три самых свежих. Считаем по mtime, а не по возрасту: релизы создаёт
# сам деплой, поэтому счётчик здесь не может спрятать сломанный конвейер —
# в отличие от бэкапов, где ротация по возрасту выбрана ровно из-за этого.
# current и previous не удаляем никогда, даже если они оказались самыми старыми:
# именно на них держится откат.
CURRENT_TARGET=\$(readlink -f $CURRENT || true)
PREV_TARGET=\$(readlink -f $PREVIOUS || true)
# readlink -f возвращает сам путь, если его нет, а не пустую строку — поэтому
# «не каталог» здесь и означает «такого релиза нет».
[ -d "\$CURRENT_TARGET" ] || CURRENT_TARGET=""
[ -d "\$PREV_TARGET" ] || PREV_TARGET=""
# tail -n +4, а не head -n -3: список идёт от свежих к старым, и «всё, кроме
# последних трёх» означало бы «всё, кроме самых старых» — то есть уборка
# удаляла бы свежие релизы и не трогала старьё. Проверено на пяти каталогах.
# 4 = три оставляемых релиза + 1.
for OLD in \$(ls -1dt $RELEASES_DIR/*/ 2>/dev/null | tail -n +4 || true); do
  OLD=\${OLD%/}
  if [ "\$OLD" = "\$CURRENT_TARGET" ] || [ "\$OLD" = "\$PREV_TARGET" ]; then continue; fi
  case "\$OLD" in
    $RELEASES_DIR/*)
      echo "  убираю релиз \$(basename "\$OLD")"
      rm -rf "\$OLD"
      ;;
    *)
      echo "  пропускаю \$OLD: не похоже на релиз" >&2
      ;;
  esac
done
echo "  релизов на диске: \$(ls -1d $RELEASES_DIR/*/ 2>/dev/null | wc -l)"
REMOTE

echo "==> 4/6: постеры сида: метаданные из TMDb (битые URL чинятся на месте)"
ssh "$SERVER" bash -s <<REMOTE
cd $CURRENT
set -a; . ./.env; set +a
cd packages/db
npx tsx src/seed-catalog.ts 2>&1 | tail -3
REMOTE

echo "==> 4b: TorrServer — дисковый кэш и быстрый старт"
ssh "$SERVER" "$APP_DIR/bin/torrserver-tune.sh" || echo "  ВНИМАНИЕ: TorrServer не настроен (не отвечает?)" >&2

echo "==> 5/6: смоук"
ssh "$SERVER" bash -s <<REMOTE
cd $CURRENT
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
echo -n "  cwd API:          "; pm2 jlist | python3 -c "
import json,sys
for a in json.load(sys.stdin):
    if a['name'] == 'kinopap-api':
        print(a['pm2_env']['pm_cwd'])
"
pm2 ls | grep kinopap
REMOTE

echo "==> 6/6: готово. Релиз $TS"
echo "Откат: ./bin/deploy.sh --rollback"
echo "Наполнить каталог: POST $HTTPS_URL/v1/discover (owner/admin, {\"pages\":2})"
