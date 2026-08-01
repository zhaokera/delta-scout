import type { SourceId } from "../domain/listing.js";
import type {
  RefreshProgressEvent
} from "./collector/coordinator.js";
import type {
  ScanHistoryRun,
  ScanState
} from "./repository.js";

export type RefreshPhase =
  | "discover"
  | "list"
  | "detail"
  | "score"
  | "commit";

export interface RefreshStatusView {
  runId: number | null;
  state: "idle" | "running" | ScanState;
  startedAt: string | null;
  finishedAt: string | null;
  source: SourceId | null;
  phase: RefreshPhase | null;
  page: number;
  summaries: number;
  details: number;
  message: string | null;
  error: string | null;
  lastSnapshotAt: string | null;
}

interface RefreshTrackerInitialState {
  latestRun: ScanHistoryRun | null;
  lastSnapshotAt: string | null;
}

export class RefreshTracker {
  private current: RefreshStatusView;

  constructor(initial: RefreshTrackerInitialState) {
    this.current = initial.latestRun
      ? {
          runId: initial.latestRun.id,
          state: initial.latestRun.state,
          startedAt: initial.latestRun.startedAt,
          finishedAt: initial.latestRun.finishedAt,
          source: null,
          phase: null,
          page: 0,
          summaries: 0,
          details: 0,
          message: null,
          error: initial.latestRun.error,
          lastSnapshotAt: initial.lastSnapshotAt
        }
      : {
          runId: null,
          state: "idle",
          startedAt: null,
          finishedAt: null,
          source: null,
          phase: null,
          page: 0,
          summaries: 0,
          details: 0,
          message: null,
          error: null,
          lastSnapshotAt: initial.lastSnapshotAt
        };
  }

  start(runId: number, startedAt: Date): void {
    if (this.current.state === "running") {
      throw new Error("refresh_in_progress");
    }
    this.current = {
      runId,
      state: "running",
      startedAt: startedAt.toISOString(),
      finishedAt: null,
      source: null,
      phase: null,
      page: 0,
      summaries: 0,
      details: 0,
      message: "刷新任务已启动",
      error: null,
      lastSnapshotAt: this.current.lastSnapshotAt
    };
  }

  update(runId: number, event: RefreshProgressEvent): void {
    if (
      this.current.runId !== runId ||
      this.current.state !== "running"
    ) {
      return;
    }
    this.current = {
      ...this.current,
      source: event.source,
      phase: event.phase,
      page: event.page,
      summaries: event.summaries,
      details: event.details,
      message: event.message
    };
  }

  finish(
    runId: number,
    state: ScanState,
    finishedAt: Date,
    error: string | null = null
  ): void {
    if (
      this.current.runId !== runId ||
      this.current.state !== "running"
    ) {
      return;
    }
    const timestamp = finishedAt.toISOString();
    this.current = {
      ...this.current,
      state,
      finishedAt: timestamp,
      source: null,
      phase: null,
      message:
        state === "success"
          ? "刷新完成"
          : state === "partial"
            ? "部分来源未完整刷新"
            : "刷新失败",
      error,
      lastSnapshotAt:
        state === "success" || state === "partial"
          ? timestamp
          : this.current.lastSnapshotAt
    };
  }

  snapshot(): RefreshStatusView {
    return { ...this.current };
  }

  synchronize(initial: RefreshTrackerInitialState): void {
    if (this.current.state === "running") return;
    const latestRun = initial.latestRun;
    if (
      latestRun === null ||
      (this.current.runId !== null && latestRun.id <= this.current.runId)
    ) {
      return;
    }
    this.current = {
      runId: latestRun.id,
      state: latestRun.state,
      startedAt: latestRun.startedAt,
      finishedAt: latestRun.finishedAt,
      source: null,
      phase: null,
      page: 0,
      summaries: 0,
      details: 0,
      message: null,
      error: latestRun.error,
      lastSnapshotAt: initial.lastSnapshotAt
    };
  }

  isRunning(): boolean {
    return this.current.state === "running";
  }
}
