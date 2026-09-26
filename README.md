# «Зал»

Клон kino.pub с улучшенным дизайном и архитектурой. Закрытый клуб: регистрация по инвайтам.

## Структура

```
apps/
  web/      Next.js 16 — веб-клиент (каталог, плеер, PWA)
  mobile/   Expo 57 — мобильный клиент (тот же API)
  api/      Fastify 5 — REST API (auth, каталог, OpenAPI)
  worker/   BullMQ — транскод ffmpeg → HLS, тумбы, спрайты
packages/
  db/          Drizzle ORM + Postgres 16: схема, миграции, репозитории, seed
  api-client/  Общие zod-схемы (контракт API) + типизированный клиент
  ui/          Дизайн-токены и UI-примитивы
```

## Границы

Ingest — source-agnostic: `SourceConnector` (`search / probe / pull`) поверх твоих файлов
и URL. Скрейперы чужих пираток/стримингов в проект не входят. Метаданные (постеры,
описания, рейтинги) — через официальный TMDb API (фаза 2).

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
2. Ingest + транскод + каталог (TMDb)
3. Веб: каталог, страницы, плеер
4. Прогресс, подписки, комментарии, поиск
5. Мобила (Expo, офлайн, пуш)
6. Полировка: дизайн, perf, рекомендации, статистика
