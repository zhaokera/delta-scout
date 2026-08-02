import { describe, expect, it } from "vitest";
import { createDatabase } from "../../src/server/db.js";
import {
  RefreshScheduleRepository
} from "../../src/server/refreshScheduler.js";
import type { SourceStatus } from "../../src/server/repository.js";

const baseTime = new Date("2026-08-02T00:00:00.000Z");

function sourceStatus(
  source: SourceStatus["source"],
  lastSuccessAt: string,
  state: SourceStatus["state"] = "success",
  error: string | null = null
): SourceStatus {
  return {
    source,
    state,
    lastAttemptAt: lastSuccessAt,
    lastSuccessAt,
    itemCount: 100,
    pagesScanned: 10,
    stopReason: "end_of_pages",
    error,
    stale: false,
    anomaly: { state: "clear" }
  };
}

describe("RefreshScheduleRepository", () => {
  it("initializes independent default cadences", () => {
    const database = createDatabase(":memory:");
    const schedule = new RefreshScheduleRepository(database, baseTime);

    expect(schedule.list()).toEqual([
      expect.objectContaining({ source: "jiaoyimao", quickIntervalMinutes: 60 }),
      expect.objectContaining({ source: "panzhi", quickIntervalMinutes: 120 }),
      expect.objectContaining({ source: "pxb7", quickIntervalMinutes: 30 })
    ]);
  });

  it("marks Panzhi as requiring a browser snapshot instead of auto-running", () => {
    const database = createDatabase(":memory:");
    const schedule = new RefreshScheduleRepository(database, baseTime);

    schedule.markAttentionRequired("panzhi", "quick", baseTime);

    expect(schedule.list().find(({ source }) => source === "panzhi"))
      .toMatchObject({
        lastState: "attention_required",
        attentionRequired: true,
        lastError: "browser_snapshot_required"
      });
  });

  it("backs off CAPTCHA failures for two hours", () => {
    const database = createDatabase(":memory:");
    const schedule = new RefreshScheduleRepository(database, baseTime);

    schedule.markStarted("jiaoyimao", "quick", baseTime);
    schedule.markFinished(
      "jiaoyimao",
      "quick",
      "partial",
      "captcha_required",
      baseTime,
      () => 0.5
    );

    expect(schedule.list().find(({ source }) => source === "jiaoyimao"))
      .toMatchObject({
        lastState: "blocked",
        consecutiveFailures: 1,
        backoffUntil: "2026-08-02T02:00:00.000Z"
      });
  });

  it("moves the next quick run after an externally published snapshot", () => {
    const database = createDatabase(":memory:");
    const schedule = new RefreshScheduleRepository(database, baseTime);

    schedule.markAttentionRequired("panzhi", "quick", baseTime);
    schedule.synchronizeSourceStatuses([
      sourceStatus("panzhi", "2026-08-02T01:00:00.000Z")
    ]);

    expect(schedule.list().find(({ source }) => source === "panzhi"))
      .toMatchObject({
        lastState: "success",
        attentionRequired: false,
        nextQuickAt: "2026-08-02T03:00:00.000Z"
      });
  });

  it("preserves a partial source state when synchronizing a snapshot", () => {
    const database = createDatabase(":memory:");
    const schedule = new RefreshScheduleRepository(database, baseTime);

    schedule.synchronizeSourceStatuses([
      sourceStatus(
        "jiaoyimao",
        "2026-08-02T01:00:00.000Z",
        "partial",
        "detail_limit_reached"
      )
    ]);

    expect(schedule.list().find(({ source }) => source === "jiaoyimao"))
      .toMatchObject({
        lastState: "partial",
        lastFinishedAt: "2026-08-02T01:00:00.000Z",
        lastError: "detail_limit_reached"
      });
  });
});
