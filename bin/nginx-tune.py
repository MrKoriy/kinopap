#!/usr/bin/env python3
"""
Тюнинг nginx для «Зала» (вызывается из bin/deploy.sh на сервере, идемпотентно).

1. /etc/nginx/conf.d/kinopap-cache.conf — зоны proxy_cache (http-контекст):
   kinopap_api (микрокэш публичных GET API) и kinopap_img (оптимизированные
   постеры /_next/image). Кэш картинок лежит вне релизов и переживает деплой —
   раньше .next/cache жил внутри releases/<ts> и обнулялся каждым деплоем.
2. В vhost сайта — управляемый блок BEGIN/END kinopap-perf: gzip для JSON/HLS,
   микрокэш API (только запросы без Authorization), кэш /_next/image на 30 дней,
   immutable для /_next/static.
3. /torrents (админ-API TorrServer) наружу закрыт: им пользуется только API
   через 127.0.0.1:7002. Раньше любой мог добавлять и удалять раздачи.
4. HTTP/2 на 443: десятки постеров на странице идут по одному соединению.
"""
import os
import re
import sys

CACHE_CONF = "/etc/nginx/conf.d/kinopap-cache.conf"
CACHE_BODY = """# managed by kinopap bin/nginx-tune.py
proxy_cache_path /var/cache/nginx/kinopap_api levels=1:2 keys_zone=kinopap_api:20m max_size=512m inactive=1h use_temp_path=off;
proxy_cache_path /var/cache/nginx/kinopap_img levels=1:2 keys_zone=kinopap_img:50m max_size=4g inactive=60d use_temp_path=off;
# Нормализация Accept: варианты кэша постера — avif / webp / прочее.
map $http_accept $kinopap_img_fmt {
    default         "orig";
    "~image/avif"   "avif";
    "~image/webp"   "webp";
}
"""

PROXY_HEADERS = """        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;"""

BLOCK = f"""    # BEGIN kinopap-perf (managed by bin/nginx-tune.py)
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 5;
    gzip_min_length 1024;
    gzip_types text/plain text/css application/json application/javascript text/javascript image/svg+xml application/vnd.apple.mpegurl application/x-mpegurl text/vtt application/manifest+json;

    # Публичные ленты/карточки/справочники: 30 с микрокэша, протухшее
    # отдаём мгновенно и обновляем фоном. С токеном — мимо кэша.
    location ~ ^/v1/(items(/(fresh|hot|popular|summary|[0-9]+(/similar)?))?|genres|countries|types)$ {{
        proxy_pass http://127.0.0.1:7001;
{PROXY_HEADERS}
        proxy_cache kinopap_api;
        proxy_cache_key $scheme$host$request_uri;
        proxy_cache_valid 200 30s;
        proxy_cache_use_stale updating error timeout http_500 http_502 http_503 http_504;
        proxy_cache_background_update on;
        proxy_cache_lock on;
        proxy_cache_bypass $http_authorization;
        proxy_no_cache $http_authorization;
        add_header X-Cache $upstream_cache_status always;
    }}

    # Оптимизированные постеры: 30 дней на диске nginx, мимо Next.
    location /_next/image {{
        proxy_pass http://127.0.0.1:7000;
{PROXY_HEADERS}
        proxy_cache kinopap_img;
        proxy_cache_key $scheme$host$request_uri$kinopap_img_fmt;
        proxy_cache_valid 200 30d;
        proxy_cache_valid 404 1m;
        proxy_cache_use_stale updating error timeout http_500 http_502 http_503 http_504;
        proxy_cache_background_update on;
        proxy_cache_lock on;
        proxy_ignore_headers Cache-Control Expires Vary Set-Cookie;
        proxy_hide_header Cache-Control;
        add_header Cache-Control "public, max-age=2592000, stale-while-revalidate=86400" always;
        add_header Vary Accept always;
        add_header X-Cache $upstream_cache_status always;
    }}

    location /_next/static/ {{
        proxy_pass http://127.0.0.1:7000;
{PROXY_HEADERS}
        proxy_hide_header Cache-Control;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
    }}
    # END kinopap-perf
"""

TORRENTS_LOCKED = """    location /torrents {
        return 403;
    }"""


def tune(path: str) -> None:
    s = open(path).read()
    orig = s
    # Прежняя версия управляемого блока — заменяем целиком.
    s = re.sub(r"\n?[ \t]*# BEGIN kinopap-perf.*?# END kinopap-perf[^\n]*\n?", "\n", s, flags=re.S)
    # /torrents наружу — 403 (любая прежняя форма блока).
    s = re.sub(r"[ \t]*location /torrents \{[^}]*\}", TORRENTS_LOCKED, s)
    m = re.compile(r"^[ \t]+location\s[^{\n]*\{", re.M).search(s, max(s.find("server {"), 0))
    if not m:
        sys.exit(f"{path}: не найден ни один location")
    s = s[: m.start()] + BLOCK + "\n" + s[m.start():]
    s = s.replace("listen 443 ssl;", "listen 443 ssl http2;")
    s = s.replace("listen [::]:443 ssl;", "listen [::]:443 ssl http2;")
    if s != orig:
        # Бэкап — вне sites-enabled: nginx подключает оттуда всё подряд.
        os.makedirs("/var/backups/kinopap-nginx", exist_ok=True)
        with open(f"/var/backups/kinopap-nginx/{os.path.basename(path)}.bak", "w") as f:
            f.write(orig)
        with open(path, "w") as f:
            f.write(s)
        print(f"nginx: {os.path.basename(path)} — kinopap-perf применён")
    else:
        print(f"nginx: {os.path.basename(path)} — без изменений")


if __name__ == "__main__":
    os.makedirs("/var/cache/nginx", exist_ok=True)
    with open(CACHE_CONF, "w") as f:
        f.write(CACHE_BODY)
    for p in sys.argv[1:]:
        tune(p)