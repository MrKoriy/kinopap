/**
 * Трекинг дочерних процессов execWithTimeout: add на spawn, remove на
 * завершение, остановка по сигналу при shutdown воркера.
 */
import { describe, expect, it } from "vitest";
import {
  activeChildProcesses,
  execWithTimeout,
  stopActiveChildren,
} from "../src";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("activeChildProcesses", () => {
  it("процесс добавляется на spawn и снимается по завершении", async () => {
    expect(activeChildProcesses.size).toBe(0);
    const p = execWithTimeout(
      process.execPath,
      ["-e", "setTimeout(() => {}, 200)"],
      10_000,
    );
    await tick(50);
    expect(activeChildProcesses.size).toBe(1);
    await p;
    expect(activeChildProcesses.size).toBe(0);
  });

  it("ошибочный процесс тоже снимается с трекинга", async () => {
    await expect(
      execWithTimeout(process.execPath, ["-e", "process.exit(3)"], 10_000),
    ).rejects.toThrow();
    expect(activeChildProcesses.size).toBe(0);
  });
});

describe("stopActiveChildren", () => {
  it("останавливает долгий процесс: promise завершается, джоба падает", async () => {
    const hanging = execWithTimeout(
      process.execPath,
      ["-e", "setTimeout(() => {}, 600_000)"],
      600_000,
    );
    await tick(50);
    expect(activeChildProcesses.size).toBe(1);

    const startedAt = Date.now();
    await stopActiveChildren(5_000);
    expect(Date.now() - startedAt).toBeLessThan(10_000);

    // Процесс остановлен сигналом — execFile отдаёт ошибку, воркер
    // видит падение джобы и отпускает слот.
    await expect(hanging).rejects.toThrow();
    expect(activeChildProcesses.size).toBe(0);
  }, 15_000);

  it("без активных процессов завершается мгновенно", async () => {
    const startedAt = Date.now();
    await stopActiveChildren(5_000);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });
});
