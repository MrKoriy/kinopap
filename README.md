# «Зал»

Клон kino.pub с улучшенным дизайном и архитектурой. Закрытый клуб: регистрация по инвайтам.

## Структура

```
apps/
  web/      Next.js 16 — веб-клиент (каталог, плеер, PWA)
  mobile/   Expo 57 — мобильный клиент (тот же API)
  api/      Fastify 5 — REST API (auth, каталог, ingest, OpenAPI)
  worker/   BullMQ — ingest: pull → ffprobe → ffmpeg HLS + ассеты
packages/
  db/          Drizzle ORM + Postgres 16: схема, миграции, репозитории, seed
  api-client/  Общие zod-схемы (контракт API) + типизированный клиент
  ingest/      SourceConnector + коннекторы (Local/URL/TMDb) + ffmpeg-пайплайн
  ui/          Дизайн-токены и UI-примитивы
```

## Границы

Ingest — source-agnostic: `SourceConnector` (`search / probe / pull`) поверх твоих файлов
и URL. Скрейперы чужих пираток/стримингов в проект не входят. Метаданные (постеры,
описания, рейтинги) — через официальный TMDb API.

## Ingest и транскод

`POST /v1/ingest` (owner/admin) ставит задачу в BullMQ-очередь: worker забирает
источник (LocalFolder или URL), снимает метаданные ffprobe'ом, транскодирует в
HLS-лестницу (480p/720p/1080p, h264/aac, без апскейла), делает постер, тумбы,
спрайт для скраббинга и WebVTT-субтитры (внешние и встроенные), публикует запись
в каталог и дозаполняет метаданные из TMDb. Статус задачи — `GET /v1/ingest/:id`.

Переменные worker'а: `MEDIA_ROOT`, `MEDIA_BASE_URL`, `LOCAL_SOURCE_ROOT`,
`TMDB_API_KEY` (опционально), `FFMPEG_PRESET` / `FFMPEG_CRF` / `FFMPEG_HLS_TIME`.

## Быстрый старт

```bash
pnpm install
docker compose up -d          # postgres 16, redis, minio (для dev)
cp .env.example .env
pnpm db:setup                 # миграции + seed (owner, инвайты, жанры, страны)
pnpm dev                      # web :3000, api :3001, worker
```

Тесты не требуют Docker: поднимают Postgres-совместимую БД в памяти (PGlite).

```bash
pnpm typecheck
pnpm test
```

## API

REST, философия API 1.3 kino.pub, но чище: cursor-пагинация, единые фильтры
(тип/жанры/страны/год-диапазон/актёры/режиссёр/буква/сортировка), поиск по
title/director/cast, media-links (лестница качеств http+hls, аудиодорожки с
метаданными дубляжа, субтитры со сдвигом), similar, fresh/hot/popular.

- `GET /openapi.json` — спецификация
- `GET /docs` — страница с описанием

Auth: JWT access (15 мин) + refresh (30 дней, ротация). Регистрация по инвайт-коду.

## Фазы

1. ✅ Монорепа, схема БД, auth, каркас API
2. ✅ Ingest + транскод + каталог (TMDb)
3. Веб: каталог, страницы, плеер
4. Прогресс, подписки, комментарии, поиск
5. Мобила (Expo, офлайн, пуш)
6. Полировка: дизайн, perf, рекомендации, статистика
