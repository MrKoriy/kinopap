"use client";

import { useReportWebVitals } from "next/web-vitals";
import * as React from "react";
import { installErrorReporter } from "@/lib/errors";
import { type RumEvent, reportRum } from "@/lib/rum";

const TRACKED = new Set(["LCP", "TTFB", "FCP", "INP", "CLS"]);

/** Web Vitals каждой страницы → RUM (LCP, TTFB, FCP, INP, CLS); заодно ловим ошибки браузера. */
export function WebVitals() {
  React.useEffect(() => installErrorReporter(), []);
  useReportWebVitals((metric) => {
    if (!TRACKED.has(metric.name)) return;
    reportRum({
      name: metric.name as RumEvent["name"],
      value: metric.value,
      rating: metric.rating,
      meta: { nav: metric.navigationType ?? null },
    });
  });
  return null;
}
