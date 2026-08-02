import type { DatabaseSync } from "node:sqlite";
import type { SourceId } from "../domain/listing.js";
import type {
  CollectionCoordinator,
  RefreshMode
} from "./collector/coordinator.js";
import type { RefreshAdmissionController } from "./refreshAdmission.js";
import type {
  ListingRepository,
  ScanState,
  SourceStatus
} from "./repository.js";
import type { RefreshTracker } from "./refreshTracker.js";

export type ScheduledRefreshState =
  | "idle"
  | "running"
  | "success"
  | "partial"
  | "blocked"
  | "failed"
  | "attention_required";

export interface RefreshScheduleView {
  source: SourceId;
  enabled: boolean;
  quickIntervalMinutes: number;
  deepIntervalMinutes: number;
  nextQuickAt: string;
  nextDeepAt: string;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastMode: RefreshMode | null;
  lastState: ScheduledRefreshState;
  consecutiveFailures: number;
  backoffUntil: string | null;
  lastError: string | null;
  attentionRequired: boolean;
}

export type RefreshTriggerResult =
  | { kind: "running"; runId: number; source: SourceId; mode: RefreshMode }
  | { kind: "attention_required"; source: "panzhi" }
  | {
      kind: "conflict";
      activeKind: "all_sources" | "browser";
      jobId?: string;
    };

interface ScheduleRow {
  source: SourceId;
  enabled: number;
  quick_interval_minutes: number;
  deep_interval_minutes: number;
  next_quick_at: string;
  next_deep_at: string;
  last_started_at: string | null;
  last_finished_at: string | null;
  last_mode: RefreshMode | null;
  last_state: ScheduledRefreshState;
  consecutive_failures: number;
  backoff_until: string | null;
  last_error: string | null;
  attention_required: number;
  observed_source_success_at: string | null;
}

const DEFAULTS: Record<
  SourceId,
  { quickMinutes: number; deepMinutes: number }
> = {
  jiaoyimao: { quickMinutes: 60, deepMinutes: 24 * 60 },
  panzhi: { quickMinutes: 120, deepMinutes: 24 * 60 },
  pxb7: { quickMinutes: 30, deepMinutes: 24 * 60 }
};

function addMinutes(at: Date, minutes: number): Date {
  return new Date(at.getTime() + minutes * 60_000);
}

function asView(row: ScheduleRow): RefreshScheduleView {
  return {
    source: row.source,
    enabled: row.enabled === 1,
    quickIntervalMinutes: row.quick_interval_minutes,
    deepIntervalMinutes: row.deep_interval_minutes,
    nextQuickAt: row.next_quick_at,
    nextDeepAt: row.next_deep_at,
    lastStartedAt: row.last_started_at,
    lastFinishedAt: row.last_finished_at,
    lastMode: row.last_mode,
    lastState: row.last_state,
    consecutiveFailures: row.consecutive_failures,
    backoffUntil: row.backoff_until,
    lastError: row.last_error,
    attentionRequired: row.attention_required === 1
  };
}

export class RefreshScheduleRepository {
  constructor(
    private readonly database: DatabaseSync,
    now = new Date()
  ) {
    const insert = database.prepare(`
      INSERT OR IGNORE INTO refresh_schedule (
        source, enabled, quick_interval_minutes,
        deep_interval_minutes, next_quick_at, next_deep_at
      ) VALUES (?, 1, ?, ?, ?, ?)
    `);
    for (const source of ["jiaoyimao", "panzhi", "pxb7"] as const) {
      const defaults = DEFAULTS[source];
      insert.run(
        source,
        defaults.quickMinutes,
        defaults.deepMinutes,
        addMinutes(now, defaults.quickMinutes).toISOString(),
        addMinutes(now, defaults.deepMinutes).toISOString()
      );
    }
    database.prepare(`
      UPDATE refresh_schedule
      SET last_state = 'failed',
          last_finished_at = ?,
          last_error = 'scheduler_restarted',
          consecutive_failures = consecutive_failures + 1,
          backoff_until = ?
      WHERE last_state = 'running'
    `).run(
      now.toISOString(),
      addMinutes(now, 5).toISOString()
    );
  }

  list(): RefreshScheduleView[] {
    const rows = this.database.prepare(`
      SELECT * FROM refresh_schedule
      ORDER BY CASE source
        WHEN 'jiaoyimao' THEN 1
        WHEN 'panzhi' THEN 2
        ELSE 3
      END
    `).all() as unknown as ScheduleRow[];
    return rows.map(asView);
  }

  synchronizeSourceStatuses(statuses: SourceStatus[]): void {
    const update = this.database.prepare(`
      UPDATE refresh_schedule
      SET observed_source_success_at = ?,
          next_quick_at = ?,
          attention_required = 0,
          last_finished_at = CASE
            WHEN last_state = 'running' THEN last_finished_at
            ELSE ?
          END,
          last_state = CASE
            WHEN last_state = 'running' THEN last_state
            ELSE ?
          END,
          last_error = CASE
            WHEN last_state = 'running' THEN last_error
            ELSE ?
          END
      WHERE source = ?
        AND (
          observed_source_success_at IS NULL OR
          observed_source_success_at < ? OR
          (last_state = 'success' AND ? = 'partial')
        )
    `);
    const scheduleBySource = new Map(
      this.list().map((schedule) => [schedule.source, schedule])
    );
    for (const status of statuses) {
      if (!status.lastSuccessAt) continue;
      const schedule = scheduleBySource.get(status.source);
      if (!schedule) continue;
      update.run(
        status.lastSuccessAt,
        addMinutes(
          new Date(status.lastSuccessAt),
          schedule.quickIntervalMinutes
        ).toISOString(),
        status.lastAttemptAt ?? status.lastSuccessAt,
        status.state,
        status.error,
        status.source,
        status.lastSuccessAt,
        status.state
      );
    }
  }

  nextDue(now: Date): { source: SourceId; mode: RefreshMode } | null {
    const row = this.database.prepare(`
      SELECT source,
             CASE
               WHEN next_deep_at <= ? THEN 'deep'
               ELSE 'quick'
             END AS mode
      FROM refresh_schedule
      WHERE enabled = 1
        AND last_state <> 'running'
        AND (backoff_until IS NULL OR backoff_until <= ?)
        AND (next_quick_at <= ? OR next_deep_at <= ?)
      ORDER BY
        CASE WHEN next_deep_at <= ? THEN next_deep_at ELSE next_quick_at END,
        source
      LIMIT 1
    `).get(
      now.toISOString(),
      now.toISOString(),
      now.toISOString(),
      now.toISOString(),
      now.toISOString()
    ) as { source: SourceId; mode: RefreshMode } | undefined;
    return row ?? null;
  }

  markStarted(source: SourceId, mode: RefreshMode, at: Date): void {
    this.database.prepare(`
      UPDATE refresh_schedule
      SET last_started_at = ?, last_mode = ?, last_state = 'running',
          last_error = NULL, attention_required = 0
      WHERE source = ?
    `).run(at.toISOString(), mode, source);
  }

  markAttentionRequired(source: "panzhi", mode: RefreshMode, at: Date): void {
    const defaults = DEFAULTS[source];
    this.database.prepare(`
      UPDATE refresh_schedule
      SET last_mode = ?, last_state = 'attention_required',
          attention_required = 1,
          last_error = 'browser_snapshot_required',
          next_quick_at = ?,
          next_deep_at = CASE WHEN ? = 'deep' THEN ? ELSE next_deep_at END
      WHERE source = ?
    `).run(
      mode,
      addMinutes(at, defaults.quickMinutes).toISOString(),
      mode,
      addMinutes(at, defaults.deepMinutes).toISOString(),
      source
    );
  }

  markFinished(
    source: SourceId,
    mode: RefreshMode,
    state: ScanState,
    error: string | null,
    at: Date,
    random: () => number
  ): void {
    const row = this.list().find((entry) => entry.source === source)!;
    const blocked = error === "captcha_required" ||
      error === "rate_limited";
    const failed = state === "failed" || blocked;
    const failures = failed ? row.consecutiveFailures + 1 : 0;
    const baseBackoffMinutes = error === "captcha_required"
      ? 120
      : error === "rate_limited"
        ? Math.min(360, 30 * 2 ** Math.max(0, failures - 1))
        : Math.min(120, [5, 15, 60, 120][Math.min(3, failures - 1)] ?? 5);
    const jitter = (minutes: number): number => {
      const factor = 0.9 + random() * 0.2;
      return Math.max(1, Math.round(minutes * factor));
    };
    const nextQuick = addMinutes(
      at,
      jitter(row.quickIntervalMinutes)
    ).toISOString();
    const nextDeep = mode === "deep"
      ? addMinutes(at, jitter(row.deepIntervalMinutes)).toISOString()
      : row.nextDeepAt;
    this.database.prepare(`
      UPDATE refresh_schedule
      SET last_finished_at = ?,
          last_state = ?,
          consecutive_failures = ?,
          backoff_until = ?,
          last_error = ?,
          attention_required = 0,
          next_quick_at = ?,
          next_deep_at = ?
      WHERE source = ?
    `).run(
      at.toISOString(),
      blocked ? "blocked" : state,
      failures,
      failed
        ? addMinutes(at, baseBackoffMinutes).toISOString()
        : null,
      error,
      nextQuick,
      nextDeep,
      source
    );
  }
}

export class RefreshScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(
    private readonly schedule: RefreshScheduleRepository,
    private readonly listings: ListingRepository,
    private readonly coordinator: CollectionCoordinator,
    private readonly tracker: RefreshTracker,
    private readonly admission: RefreshAdmissionController,
    private readonly options: {
      now?: () => Date;
      random?: () => number;
      tickIntervalMs?: number;
    } = {}
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private random(): number {
    return this.options.random?.() ?? Math.random();
  }

  snapshot(): RefreshScheduleView[] {
    this.schedule.synchronizeSourceStatuses(
      this.listings.getSourceStatuses(this.now())
    );
    return this.schedule.list();
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.tickIntervalMs ?? 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.schedule.synchronizeSourceStatuses(
        this.listings.getSourceStatuses(this.now())
      );
      const due = this.schedule.nextDue(this.now());
      if (due) this.trigger(due.source, due.mode);
    } finally {
      this.ticking = false;
    }
  }

  trigger(
    source: SourceId,
    mode: RefreshMode = "quick"
  ): RefreshTriggerResult {
    const startedAt = this.now();
    if (source === "panzhi") {
      this.schedule.markAttentionRequired(source, mode, startedAt);
      return { kind: "attention_required", source };
    }
    const acquired = this.admission.withAllSourcesLease(() => {
      const runId = this.listings.startScopedScan(source, startedAt);
      this.tracker.start(runId, startedAt);
      this.schedule.markStarted(source, mode, startedAt);
      return runId;
    });
    if (acquired.kind === "conflict") return acquired;

    const runId = acquired.value;
    const run = async (): Promise<void> => {
      try {
        const state = await this.coordinator.refreshSource(
          source,
          runId,
          mode,
          (event) => this.tracker.update(runId, event)
        );
        const finishedAt = this.now();
        const status = this.listings.getSourceStatuses(finishedAt).find(
          (entry) => entry.source === source
        );
        this.schedule.markFinished(
          source,
          mode,
          state,
          status?.error ?? null,
          finishedAt,
          () => this.random()
        );
        this.tracker.finish(runId, state, finishedAt);
      } catch (error) {
        const finishedAt = this.now();
        const message = error instanceof Error
          ? error.message
          : "scheduled_refresh_failed";
        this.schedule.markFinished(
          source,
          mode,
          "failed",
          message,
          finishedAt,
          () => this.random()
        );
        this.tracker.finish(runId, "failed", finishedAt, message);
      } finally {
        acquired.lease.release();
      }
    };
    void run().catch(() => {
      // Detached scheduled work must not create an unhandled rejection.
    });
    return { kind: "running", runId, source, mode };
  }
}
