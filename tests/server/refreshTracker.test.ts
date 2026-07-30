// @vitest-environment node
import { RefreshTracker } from "../../src/server/refreshTracker.js";
import type { ScanHistoryRun } from "../../src/server/repository.js";

const startedAt = new Date("2026-07-29T10:00:00.000Z");

describe("RefreshTracker", () => {
  it("starts idle without persisted history", () => {
    expect(
      new RefreshTracker({
        latestRun: null,
        lastSnapshotAt: null
      }).snapshot()
    ).toMatchObject({
      runId: null,
      state: "idle",
      lastSnapshotAt: null
    });
  });

  it("hydrates the latest real terminal run", () => {
    const latestRun: ScanHistoryRun = {
      id: 12,
      startedAt: startedAt.toISOString(),
      finishedAt: "2026-07-29T10:05:00.000Z",
      state: "partial",
      error: null,
      scope: "all_sources",
      requestedSource: null,
      sources: []
    };

    expect(
      new RefreshTracker({
        latestRun,
        lastSnapshotAt: latestRun.finishedAt
      }).snapshot()
    ).toMatchObject({
      runId: 12,
      state: "partial",
      startedAt: latestRun.startedAt,
      finishedAt: latestRun.finishedAt,
      lastSnapshotAt: latestRun.finishedAt
    });
  });

  it("tracks only the active run and freezes it after terminal state", () => {
    const tracker = new RefreshTracker({
      latestRun: null,
      lastSnapshotAt: "2026-07-28T10:00:00.000Z"
    });
    tracker.start(20, startedAt);
    tracker.update(19, {
      type: "list_page",
      phase: "list",
      source: "panzhi",
      page: 99,
      summaries: 99,
      details: 99,
      message: "旧任务"
    });
    tracker.update(20, {
      type: "list_page",
      phase: "list",
      source: "panzhi",
      page: 2,
      summaries: 18,
      details: 4,
      message: "已解析第 2 页"
    });

    expect(tracker.snapshot()).toMatchObject({
      runId: 20,
      state: "running",
      source: "panzhi",
      phase: "list",
      page: 2,
      summaries: 18,
      details: 4,
      lastSnapshotAt: "2026-07-28T10:00:00.000Z"
    });

    const finishedAt = new Date("2026-07-29T10:06:00.000Z");
    tracker.finish(20, "success", finishedAt);
    tracker.update(20, {
      type: "list_page",
      phase: "list",
      source: "pxb7",
      page: 9,
      summaries: 100,
      details: 10,
      message: "不应生效"
    });

    expect(tracker.snapshot()).toMatchObject({
      state: "success",
      finishedAt: finishedAt.toISOString(),
      source: null,
      phase: null,
      page: 2,
      lastSnapshotAt: finishedAt.toISOString()
    });
  });

  it("allows a new run after a terminal run but not during running", () => {
    const tracker = new RefreshTracker({
      latestRun: null,
      lastSnapshotAt: null
    });
    tracker.start(1, startedAt);
    expect(() => tracker.start(2, startedAt)).toThrow(
      "refresh_in_progress"
    );
    tracker.finish(1, "failed", startedAt, "network_error");
    tracker.start(2, new Date("2026-07-29T11:00:00.000Z"));

    expect(tracker.snapshot()).toMatchObject({
      runId: 2,
      state: "running",
      error: null
    });
  });
});
