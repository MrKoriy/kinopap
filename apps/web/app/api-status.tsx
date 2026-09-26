"use client";

import { useEffect, useState } from "react";
import { createApiClient } from "@zal/api-client";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

/** Живой индикатор связи с API. */
export function ApiStatus() {
  const [state, setState] = useState<"loading" | "ok" | "fail">("loading");

  useEffect(() => {
    const client = createApiClient({ baseUrl: API_URL });
    client
      .health()
      .then(() => setState("ok"))
      .catch(() => setState("fail"));
  }, []);

  return (
    <span className={`status ${state === "ok" ? "ok" : state === "fail" ? "fail" : ""}`}>
      <span className="dot" />
      {state === "loading" && "подключаемся к API…"}
      {state === "ok" && `API онлайн · ${API_URL}`}
      {state === "fail" && "API недоступен"}
    </span>
  );
}
