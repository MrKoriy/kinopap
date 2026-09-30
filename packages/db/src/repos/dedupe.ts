/**
 * Склейка дублей каталога: два item — одно и то же произведение.
 *
 * Дедуп при заливке ловит только точные совпадения (tmdbId, lower(title)+year),
 * а каталог из разных источников плодит вариации: «Умные дома» из сида и те же
 * «Умные дома» с другим tmdbId, опечатки (interstellar/intersteller), склонения.
 *
 * Пороги выведены из замеров на живых названиях:
 *  - similarity >= 0.6: «умные дома»/«умный дом» = 0.5 (не склеиваем вообще),
 *    «игры престолов»/«игра престолов» = 0.76 и опечатки = 0.62 (склеиваем);
 *  - окно годов ±3: главный щит — «Умные дома» 2018 vs «Умный дом» 2025
 *    отсекается разницей лет, даже при совпадении названия;
 *  - числа в названии обязаны совпадать: «Форсаж» vs «Форсаж 2» = 0.78 —
 *    разные фильмы с одинаковым окном лет;
 *  - префикс-пара (одно название — начало другого) не склеивается:
 *    «Мстители» vs «Мстители: Эра Альтрона», «Человек-паук» vs «…Нет пути домой».
 *
 * Выживший выбирается по контенту: у кого больше media, затем больше views,
 * затем старший (более ранний) id. Всё связанное с жертвой переносится в
 * выжившего (сезоны/эпизоды/media/жанры/страны/люди/прогресс/голоса/списки),
 * дубли связей отбрасываются, остатки подчищает каскад при удалении жертвы.
 */

import { sql } from "drizzle-orm";
import type { Db } from "../db";
import { items } from "../schema/index";

export interface MergeDuplicatesOptions {
  /** trgm-сходство названий. Дефолт 0.6 — см. шапку модуля. */
  similarity?: number;
  /** |год_A - год_B| максимум. Дефолт 3. */
  yearWindow?: number;
  /** Только найти пары, ничего не менять. */
  dryRun?: boolean;
}

export interface DuplicatePair {
  /** Тот, кого поглощают (менее полный item). */
  victimId: number;
  /** Тот, кто остаётся. */
  targetId: number;
  title: string;
  year: number | null;
  /** trgm-сходство пары (0..1) — тот же similarity, что фильтровал кандидата. */
  score: number;
}

export interface MergeDuplicatesReport {
  /** Сколько пар прошло все фильтры. */
  candidates: number;
  /** Сколько пар реально склеено. */
  merged: number;
  pairs: DuplicatePair[];
}

/** Цифры/римские из названия: «Форсаж 2», «Глава III» — сравниваем множества. */
function numericMarkers(title: string): string[] {
  const lower = title.toLowerCase();
  const arabic = lower.match(/\d+/g) ?? [];
  const roman = lower.match(/\b[ivxlcdm]{1,8}\b/g) ?? [];
  return [...arabic, ...roman].sort();
}

/** Один title — начало другого (сиквел/часть франшизы), склеивать нельзя. */
function isPrefixPair(a: string, b: string): boolean {
  const x = a.toLowerCase().trim();
  const y = b.toLowerCase().trim();
  if (x === y) return false;
  return x.startsWith(y) || y.startsWith(x);
}

/** Фильтры пары, которые дешёвле считать в JS, чем дублировать в SQL. */
function passesShields(titleA: string, titleB: string): boolean {
  const na = numericMarkers(titleA);
  const nb = numericMarkers(titleB);
  if (na.join("|") !== nb.join("|")) return false;
  return !isPrefixPair(titleA, titleB);
}

/**
 * Пары-кандидаты: обходом по годам, чтобы join упирался в items_year_idx,
 * а не в квадратичный перебор 20к×20к. На каждый год — один запрос с окном
 * ±yearWindow; предикаты длины/первой буквы срезают пары до вызова similarity.
 */
export async function findDuplicatePairs(
  db: Db,
  opts: MergeDuplicatesOptions = {},
): Promise<DuplicatePair[]> {
  const similarity = opts.similarity ?? 0.6;
  const window = opts.yearWindow ?? 3;

  const yearRows = await db
    .selectDistinct({ year: items.year })
    .from(items)
    .where(sql`${items.year} is not null`);
  const years = yearRows.map((r) => r.year).filter((y): y is number => y != null);

  const found = new Map<number, DuplicatePair>();
  for (const year of years) {
    const rows = await db.execute<{
      a_id: number;
      b_id: number;
      title_a: string;
      title_b: string;
      year_b: number;
      score: number;
    }>(sql`
      select a.id as a_id, b.id as b_id,
             a.title as title_a, b.title as title_b, b.year as year_b,
             similarity(a.title, b.title) as score
      from items a
      join items b
        on b.id > a.id
       and b.type = a.type
       and b.year between ${year - window} and ${year + window}
       and left(lower(b.title), 1) = left(lower(a.title), 1)
       and abs(length(b.title) - length(a.title)) <= 8
      where a.year = ${year}
        and similarity(a.title, b.title) >= ${similarity}
    `);
    for (const row of rows.rows) {
      const aId = Number(row.a_id);
      const bId = Number(row.b_id);
      if (found.has(aId) || found.has(bId)) continue; // один item — одна склейка
      if (!passesShields(String(row.title_a), String(row.title_b))) continue;
      found.set(aId, {
        victimId: aId,
        targetId: bId,
        title: String(row.title_a),
        year: row.year_b ?? null,
        score: Number(row.score),
      });
    }
  }
  return [...found.values()];
}

/** Кто выживает: больше media → больше views → раньше создан. */
async function pickVictim(db: Db, aId: number, bId: number): Promise<number> {
  const counts = await db.execute<{ id: number; media_n: number; views: number }>(sql`
    select i.id,
           (select count(*) from media m where m.item_id = i.id) as media_n,
           coalesce(i.views, 0) as views
    from items i
    where i.id in (${aId}, ${bId})
    order by i.id
  `);
  const [a, b] = counts.rows;
  if (!a || !b) return Math.min(aId, bId);
  const mediaA = Number(a.media_n);
  const mediaB = Number(b.media_n);
  const viewsA = Number(a.views);
  const viewsB = Number(b.views);
  if (mediaA !== mediaB) return mediaA < mediaB ? Number(a.id) : Number(b.id);
  if (viewsA !== viewsB) return viewsA < viewsB ? Number(a.id) : Number(b.id);
  return Math.max(Number(a.id), Number(b.id)); // оба равны — забираем старший id, младший жертвует
}

/**
 * Склеивает одну пару внутри транзакции: связи жертвы переезжают к выжившему
 * (без дублей по уникальным ключам), затем жертва удаляется — каскад добивает
 * то, что переехать не должно. Потерянные ранее: favorites, пересчёт голосов,
 * media.episodeId (матч по season.number+episode.number).
 */
async function mergePair(db: Db, victimId: number, targetId: number): Promise<void> {
  await db.transaction(async (tx) => {
    // Жанры/страны/люди: только то, чего у выжившего ещё нет.
    await tx.execute(sql`
      insert into item_genres (item_id, genre_id)
      select ${targetId}, genre_id from item_genres where item_id = ${victimId}
      on conflict do nothing`);
    await tx.execute(sql`
      insert into item_countries (item_id, country_id)
      select ${targetId}, country_id from item_countries where item_id = ${victimId}
      on conflict do nothing`);
    await tx.execute(sql`
      insert into item_people (item_id, person_id, role)
      select ${targetId}, person_id, role from item_people where item_id = ${victimId}
      on conflict do nothing`);

    // favorites — раньше терялись полностью.
    await tx.execute(sql`
      insert into favorites (profile_id, item_id)
      select profile_id, ${targetId} from favorites where item_id = ${victimId}
      on conflict do nothing`);

    // Сезоны: свободные номера переезжают целиком.
    await tx.execute(sql`
      update seasons set item_id = ${targetId}
      where item_id = ${victimId}
        and number not in (select number from seasons where item_id = ${targetId})`);

    // Недостающие сезоны жертвы — создаём у выжившего, чтобы media нашёл куда маппиться.
    await tx.execute(sql`
      insert into seasons (item_id, number, title)
      select ${targetId}, number, title from seasons where item_id = ${victimId}
        and number not in (select number from seasons where item_id = ${targetId})
      on conflict do nothing`);
    // Недостающие эпизоды в уже слитых сезонах — тоже создаём.
    await tx.execute(sql`
      insert into episodes (season_id, number, title)
      select ts.id, e.number, e.title
      from episodes e
      join seasons vs on vs.id = e.season_id and vs.item_id = ${victimId}
      join seasons ts on ts.item_id = ${targetId} and ts.number = vs.number
      where not exists (select 1 from episodes te where te.season_id = ts.id and te.number = e.number)
      on conflict do nothing`);

    // media: переносим с ремапом episodeId по (season.number, episode.number),
    // иначе episodeId остаётся на удаляемый эпизод и каскад сносит media.
    // Сборка map в SQL: для каждой media жертвы находим target episode по номерам.
    await tx.execute(sql`
      update media m set
        item_id = ${targetId},
        episode_id = coalesce(
          (select te.id from episodes ve
           join seasons vs on vs.id = ve.season_id
           join seasons ts on ts.item_id = ${targetId} and ts.number = vs.number
           join episodes te on te.season_id = ts.id and te.number = ve.number
           where ve.id = m.episode_id limit 1),
          m.episode_id
        )
      where m.item_id = ${victimId}
        and (m.source_key is null or not exists (
          select 1 from media tm
          where tm.item_id = ${targetId} and tm.source_key = m.source_key))`);
    // Если после ремапа episode_id указывает на эпизод жертвы (нет аналога) — обнуляем,
    // чтобы каскад удаления эпизода не снёс media.
    await tx.execute(sql`
      update media m set episode_id = null
      where m.item_id = ${targetId}
        and m.episode_id is not null
        and not exists (
          select 1 from episodes e join seasons s on s.id = e.season_id
          where e.id = m.episode_id and s.item_id = ${targetId}
        )`);

    // Социальные связи: без уникальных коллизий — просто переносим.
    await tx.execute(sql`
      update watch_progress set item_id = ${targetId} where item_id = ${victimId}`);
    await tx.execute(sql`
      update comments set item_id = ${targetId} where item_id = ${victimId}`);

    // С уникалом по (профиль/item или список/item) — только недубли.
    await tx.execute(sql`
      update subscriptions s set item_id = ${targetId}
      where s.item_id = ${victimId}
        and not exists (
          select 1 from subscriptions x
          where x.profile_id = s.profile_id and x.item_id = ${targetId})`);
    // votes — переносим только недубли, затем пересчитываем агрегаты, не переносим дельты.
    await tx.execute(sql`
      update votes v set item_id = ${targetId}
      where v.item_id = ${victimId}
        and not exists (
          select 1 from votes x
          where x.profile_id = v.profile_id and x.item_id = ${targetId})`);
    await tx.execute(sql`
      update list_items li set item_id = ${targetId}
      where li.item_id = ${victimId}
        and not exists (
          select 1 from list_items x
          where x.list_id = li.list_id and x.item_id = ${targetId})`);

    // Кэш резолва: переносим только медиа, которых у выжившего ещё нет.
    await tx.execute(sql`
      update media_sources ms set item_id = ${targetId}
      where ms.item_id = ${victimId}
        and not exists (
          select 1 from media_sources x
          where x.item_id = ${targetId} and x.media_id = ms.media_id)`);

    // Метрики: views суммируем, голоса/рейтинг пересчитываем из votes.
    await tx.execute(sql`
      update items set views = views + (
        select coalesce(sum(views), 0) from items where id = ${victimId})
      where id = ${targetId}`);
    await tx.execute(sql`
      update items set
        votes_positive = (select count(*)::int from votes where item_id = ${targetId} and positive = true),
        votes_negative = (select count(*)::int from votes where item_id = ${targetId} and positive = false)
      where id = ${targetId}`);
    await tx.execute(sql`
      update items set rating = case when votes_positive + votes_negative > 0
        then round(10.0 * votes_positive / (votes_positive + votes_negative)::float * 10) / 10
        else 0 end
      where id = ${targetId}`);
    await tx.execute(sql`delete from items where id = ${victimId}`);
  });
}

/** Найти пары и склеить их (dryRun — только найти). */
export async function mergeCatalogDuplicates(
  db: Db,
  opts: MergeDuplicatesOptions = {},
): Promise<MergeDuplicatesReport> {
  const pairs = await findDuplicatePairs(db, opts);
  if (opts.dryRun) return { candidates: pairs.length, merged: 0, pairs };

  let merged = 0;
  for (const pair of pairs) {
    const victimId = await pickVictim(db, pair.victimId, pair.targetId);
    const targetId = victimId === pair.victimId ? pair.targetId : pair.victimId;
    try {
      await mergePair(db, victimId, targetId);
      merged += 1;
      console.log(
        `dedupe: #${victimId} "${pair.title}" (${pair.year ?? "?"}) -> #${targetId}`,
      );
    } catch (err) {
      // Гонка/уникальный конфликт: пара остаётся как есть, fill не роняем.
      console.warn(
        `dedupe: merge failed #${pair.victimId} ~ #${pair.targetId} "${pair.title}":`,
        String(err).slice(0, 200),
      );
    }
  }
  return { candidates: pairs.length, merged, pairs };
}
