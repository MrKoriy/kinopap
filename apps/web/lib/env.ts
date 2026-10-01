/**
 * Валидация окружения веба: ловит битые URL на билде, а не 500-ми в
 * рантайме без понятной причины. Без zod — веб его не тянет.
 */
const URL_KEYS = ["NEXT_PUBLIC_API_URL", "INTERNAL_API_URL"] as const;

function isUrl(v: string | undefined): boolean {
  if (!v) return true; // пусто — валидно (не задано), warn отдельно.
  try {
    new URL(v);
    return true;
  } catch {
    return false;
  }
}

const bad = URL_KEYS.filter((k) => !isUrl(process.env[k]));
if (bad.length > 0) {
  const msg = bad.map((k) => `${k}: не URL («${process.env[k]}»)`).join("; ");
  if (process.env.NODE_ENV === "production") {
    throw new Error(`[env] битое окружение веба: ${msg}`);
  }
  console.warn(`[env] ${msg}`);
}

if (process.env.NODE_ENV === "production") {
  const hasPublic = Boolean(process.env.NEXT_PUBLIC_API_URL);
  const hasInternal = Boolean(process.env.INTERNAL_API_URL);
  if (!hasPublic && !hasInternal) {
    // Не бросаем: ISR-билд без API легитимен (softOnBuildPhase), но кричим.
    console.warn("[env] NEXT_PUBLIC_API_URL/INTERNAL_API_URL не заданы — API-вызовы упадут в рантайме");
  }
}
