#!/usr/bin/env bash
# Наполнение каталога «Зал»: один фоновый fill-джоб (годы + жанровая матрица
# + списки + страны + коллекции) с поллингом прогресса.
#
# Запуск на сервере: bash /opt/kinopap/bin/fill-catalog.sh
# Опции: FILL_YEARS_FROM=1950 FILL_YEARS_TO=2026 bash fill-catalog.sh
#
# --- Стоимость (TMDb-запросы ≈ время: воркер пейсит ~60 мс/запрос) -----------
#   годы      77 лет  × FILL_YEAR_PAGES    × 2 типа (movie+tv)
#   матрица   7 дес.  × 16 жанров × 2 типа × FILL_GENRE_PAGES
#   списки    5 стр.  × 6 лент
#   страны    |FILL_COUNTRIES| × FILL_COUNTRY_PAGES × 2 типа
#   коллекции ~92 имени × 2 запроса (поиск + состав) + детали только новым
#
# Дефолты ниже (10 / 5 / 5, 16 стран) ≈ 3.0к запросов к TMDb и потолок
# ~57к кандидатов до дедупа и minVotes — это и есть цель 15–20к тайтлов
# (см. шапку packages/ingest/src/catalog-fill.ts). Потолки схемы:
# yearPages ≤ 10, genrePages ≤ 5, countryPages ≤ 5 (packages/db/.../discovery.ts).
#
# Диалект стоимости:
#   дешевле:  FILL_YEAR_PAGES=5 FILL_GENRE_PAGES=2 FILL_COUNTRY_PAGES=3 \
#             FILL_COUNTRIES=KR,JP,IN,CN,FR,DE,ES,IT,BR,MX bash fill-catalog.sh
#   дороже:   FILL_YEAR_PAGES=10 FILL_GENRE_PAGES=5 FILL_COUNTRY_PAGES=5 \
#             FILL_MIN_VOTES=20 FILL_ANIME_LIMIT=5000 bash fill-catalog.sh
# ---------------------------------------------------------------------------
set -euo pipefail

API="${API:-http://127.0.0.1:7001}"
OWNER_EMAIL="${OWNER_EMAIL:-owner@zal.local}"
OWNER_PASSWORD="${OWNER_PASSWORD:-change-me-owner}"
YEARS_FROM="${FILL_YEARS_FROM:-1950}"
YEARS_TO="${FILL_YEARS_TO:-$(date +%Y)}"
POLL_SECONDS="${FILL_POLL_SECONDS:-15}"
# Глубина discover. Дефолты — на потолке схемы, опускаются через env.
YEAR_PAGES="${FILL_YEAR_PAGES:-10}"
GENRE_PAGES="${FILL_GENRE_PAGES:-5}"
COUNTRY_PAGES="${FILL_COUNTRY_PAGES:-5}"
# Страны происхождения: база + заметно «свои» каталоги (TR/PL/AR/SE/TH/AU).
COUNTRIES="${FILL_COUNTRIES:-KR,JP,IN,CN,FR,DE,ES,IT,BR,MX,TR,PL,AR,SE,TH,AU}"
# Порог голосов TMDb: ниже — уже не «кино», а случайные строки. TV-порог
# API выводит как 0.6× от этого (buildFillSpec).
MIN_VOTES="${FILL_MIN_VOTES:-30}"
# Сколько аниме-релизов AniLibria импортировать (потолок схемы 5000).
ANIME_LIMIT="${FILL_ANIME_LIMIT:-2000}"

TOKEN=$(curl -s -X POST "$API/v1/auth/login" -H "content-type: application/json" \
  -d "{\"email\":\"$OWNER_EMAIL\",\"password\":\"$OWNER_PASSWORD\"}" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['tokens']['accessToken'])")

python3 - "$API" "$TOKEN" "$YEARS_FROM" "$YEARS_TO" "$POLL_SECONDS" \
  "$YEAR_PAGES" "$GENRE_PAGES" "$COUNTRY_PAGES" "$COUNTRIES" "$MIN_VOTES" "$ANIME_LIMIT" <<'PY'
import json, sys, time, urllib.request

(api, token, year_from, year_to, poll,
 year_pages, genre_pages, country_pages, countries_csv, min_votes, anime_limit) = (
    sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]),
    int(sys.argv[6]), int(sys.argv[7]), int(sys.argv[8]), sys.argv[9],
    int(sys.argv[10]), int(sys.argv[11]),
)

countries = [c.strip().upper() for c in countries_csv.split(",") if c.strip()]

COLLECTIONS = [
    "Форсаж", "Миньоны", "Гадкий я", "Мадагаскар", "Как приручить дракона",
    "Кунг-фу Панда", "Тачки", "История игрушек", "В поисках Немо", "Вверх",
    "Рататуй", "ВАЛЛ·И", "Головоломка", "Зверополис", "Моана",
    "Холодное сердце", "Король Лев", "Аладдин", "Красавица и чудовище",
    "Мулан", "Геркулес", "Шрек", "Смурфики",
    "Мстители", "Железный человек", "Капитан Америка", "Тор", "Человек-паук",
    "Халк", "Чёрная пантера", "Стражи Галактики", "Люди Икс", "Дэдпул",
    "Логан", "Бэтмен", "Супермен", "Джокер", "Аквамен", "Чудо-женщина",
    "Флэш", "Отряд самоубийц", "Черепашки-ниндзя", "Трансформеры",
    "Звёздные войны", "Гарри Поттер", "Фантастические твари", "Властелин колец",
    "Хоббит", "Пираты Карибского моря", "Индиана Джонс", "Терминатор",
    "Чужой", "Хищник", "Рэмбо", "Крепкий орешек", "Матрица",
    "Джон Уик", "Неудержимые", "Рокки", "Крид", "Миссия невыполнима",
    "Агент 007", "Кингсман", "Один дома",
    "Одиннадцать друзей Оушена", "Пиксели",
    "Сумерки", "Голодные игры", "Дивергент", "Лабиринт",
    "Годзилла", "Конг", "Мумия",
    "Челюсти", "Парк Юрского периода", "Мир Юрского периода", "Аватар",
    "Хроники Нарнии", "Перси Джексон", "Пила",
    "Оно", "Пятница 13-е", "Хэллоуин", "Крик",
    "Шерлок Холмс", "Побег из Шоушенка", "Военный", "Планета обезьян",
    "Робот-трансформер", "Царство ночи", "Тёмный рыцарь", "Большой куш",
]

def call(path, payload=None, method="GET"):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        api + path,
        data=data,
        method=method,
        headers={
            "authorization": f"Bearer {token}",
            "content-type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)

spec = {
    "years": list(range(year_from, year_to + 1)),
    "yearPages": year_pages,
    "genreMatrix": True,
    "genrePages": genre_pages,
    "lists": True,
    "countries": countries,
    "countryPages": country_pages,
    "collections": COLLECTIONS,
    "minVotes": min_votes,
    "animeLimit": anime_limit,
}

print(f"==> Ставим fill: годы {year_from}-{year_to} (по {year_pages} стр.), "
      f"жанры (по {genre_pages}), списки, страны {','.join(countries)} "
      f"(по {country_pages}), {len(COLLECTIONS)} коллекций, minVotes={min_votes}, "
      f"animeLimit={anime_limit}")
resp = call("/v1/discover", spec, method="POST")

if not resp.get("queued"):
    # Без Redis fill выполнился прямо в запросе.
    s = resp.get("summary") or {}
    print(f"  inline: added={s.get('added')} skipped={s.get('skipped')} total={s.get('total')}")
    sys.exit(0)

job = resp["jobId"]
print(f"==> job={job}, поллим прогресс")

last = ""
while True:
    st = call(f"/v1/discover/status?job={job}")
    p = st.get("progress") or {}
    line = (
        f"    {st['state']}: phase={p.get('phase')} fetched={p.get('fetched')} "
        f"added={p.get('added')} skipped={p.get('skipped')} total={p.get('total')}"
    )
    if line != last:
        print(line, flush=True)
        last = line
    if st["state"] in ("completed", "failed"):
        if st["state"] == "failed":
            print("  FAILED:", st.get("error"))
            sys.exit(1)
        res = st.get("result") or {}
        print(
            f"  Готово: added={res.get('added')} skipped={res.get('skipped')} "
            f"total={res.get('total')} за {round((res.get('durationMs') or 0) / 1000)}с"
        )
        break
    time.sleep(poll)

print("==> Итоговый размер каталога:")
n, cursor = 0, None
while True:
    url = f"{api}/v1/items?limit=100" + (f"&cursor={cursor}" if cursor else "")
    with urllib.request.urlopen(url, timeout=30) as r:
        d = json.load(r)
    n += len(d["items"])
    cursor = d.get("nextCursor")
    if not cursor or not d["items"]:
        break
print(f"items: {n}")
PY
