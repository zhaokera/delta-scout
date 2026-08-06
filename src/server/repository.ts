import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { classifyListing } from "../domain/classify.js";
import { calculateConfidence } from "../domain/confidence.js";
import {
  selectBalancedCandidatePool,
  selectGlobalCandidatePool
} from "../domain/candidatePool.js";
import { markPossibleDuplicates } from "../domain/duplicates.js";
import { listingMaterialHash } from "../domain/listingFingerprint.js";
import {
  buildListingHistorySnapshot,
  diffListingSnapshots,
  normalizeListingHistorySnapshot,
  type ListingFieldChange,
  type ListingHistorySnapshot
} from "../domain/listingHistory.js";
import {
  evaluateSnapshotAnomaly,
  type SnapshotAnomalyGuard
} from "../domain/snapshotAnomaly.js";
import {
  type Eligibility,
  type Listing,
  type SourceId,
  SourceIdSchema
} from "../domain/listing.js";
import { ListingSchema } from "../domain/listing.js";
import {
  parseM7,
  parseRequiredRedSkins
} from "../domain/evidence.js";
import {
  ManualReviewReasonSchema,
  type ManualExclusionInput,
  type ManualListingReview,
  type ReviewedListing
} from "../domain/manualReview.js";
import { applyManualPreferenceFeedback } from "../domain/manualPreference.js";
import { scoreEligibleListings } from "../domain/score.js";
import { parseStoredListing } from "./storedListing.js";
import {
  detectRefreshEvents,
  type StoredRefreshEvent
} from "./refreshEvents.js";

export type SourceState =
  | "idle"
  | "success"
  | "partial"
  | "blocked"
  | "failed";

export interface SourceStatus {
  source: SourceId;
  state: SourceState;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  itemCount: number;
  pagesScanned: number;
  observedItemCount: number;
  latestPublished: boolean;
  stopReason: string | null;
  error: string | null;
  stale: boolean;
  anomaly: SourceAnomalyStatus;
}

export type SourceAnomalyStatus =
  | { state: "clear" }
  | {
      state: "suspect";
      baselineItemCount: number;
      baselinePagesScanned: number;
      observedItemCount: number;
      observedPagesScanned: number;
      confirmationCount: number;
      firstDetectedAt: string;
      lastDetectedAt: string;
      reason: string;
    };

interface ListingRow {
  payload: string;
}

interface ManualReviewRow {
  listing_key: string;
  action: "exclude" | "restore";
  reason_code: string | null;
  note: string | null;
  created_at: string;
}

interface SourceStatusRow {
  source: SourceId;
  state: SourceState;
  last_attempt_at: string | null;
  last_success_at: string | null;
  item_count: number;
  pages_scanned: number;
  stop_reason: string | null;
  error: string | null;
  anomaly_state: "clear" | "suspect";
  baseline_item_count: number | null;
  baseline_pages_scanned: number | null;
  observed_item_count: number | null;
  observed_pages_scanned: number | null;
  confirmation_count: number;
  first_detected_at: string | null;
  last_detected_at: string | null;
  anomaly_reason: string | null;
  latest_observed_item_count: number | null;
  latest_published: number | null;
}

export interface ScanMetadata {
  pagesScanned: number;
  stopReason: string | null;
  error?: string | null;
  observedItemCount?: number;
  coverage?: "full" | "incremental";
  observedListingKeys?: string[];
}

export type ScanState = "success" | "partial" | "failed";

export interface ScanHistorySource {
  source: SourceId;
  state: Exclude<SourceState, "idle">;
  pagesScanned: number;
  observedItemCount: number;
  eligibleCount: number;
  balancedCandidateCount: number;
  globalCandidateCount: number;
  stopReason: string | null;
  error: string | null;
  anomalyState: string;
  published: boolean;
}

export interface ScanHistoryRun {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  state: "running" | ScanState;
  error: string | null;
  scope: "all_sources" | "single_source";
  requestedSource: SourceId | null;
  sources: ScanHistorySource[];
}

export interface CommitBrowserSourceRefreshInput {
  jobId: string;
  source: "jiaoyimao";
  listings: Listing[];
  attemptedAt: Date;
  pagesScanned: number;
  stopReason: "end_of_pages" | "no_growth_twice";
}

export interface CommitBrowserSourceRefreshResult {
  state: "success" | "quarantined";
  scanRunId: number;
  publishedRunId: number | null;
}

export interface ListingHistoryObservation {
  runId: number;
  observedAt: string;
  availability: "active" | "removed";
  priceCny: number | null;
  snapshot: ListingHistorySnapshot;
  changes: ListingFieldChange[];
}

export interface ListingHistoryView {
  key: string;
  source: SourceId;
  availability: "active" | "removed" | "unknown";
  lastSeenAt: string | null;
  observations: ListingHistoryObservation[];
}

export type SourceRefreshStatusUpdate =
  | {
      source: SourceId;
      state: "success" | "partial";
      attemptedAt: Date;
      itemCount: number;
      metadata: ScanMetadata;
    }
  | {
      source: SourceId;
      state: "blocked" | "failed";
      attemptedAt: Date;
      error: string;
    };

export interface CommitScanRefreshContext {
  runId: number;
  state: ScanState;
  publishedSources: readonly SourceId[];
}

export type ManualListingReviewErrorCode =
  | "listing_not_found"
  | "listing_not_eligible";

export class ManualListingReviewError extends Error {
  constructor(readonly code: ManualListingReviewErrorCode) {
    super(code);
    this.name = "ManualListingReviewError";
  }
}

export type SynchronousTransactionTarget = "operation" | "before_commit";

export type SynchronousCallGuard<T> = [T] extends [never]
  ? []
  : [Extract<T, PromiseLike<unknown>>] extends [never]
    ? []
    : [never];

export class SynchronousTransactionError extends Error {
  readonly code = "synchronous_transaction_required" as const;

  constructor(readonly target: SynchronousTransactionTarget) {
    super(`${target} must be synchronous and limited to same-database writes`);
    this.name = "SynchronousTransactionError";
  }
}

function isNativeAsyncFunction(operation: unknown): boolean {
  if (typeof operation !== "function") return false;
  return (
    operation.constructor?.name === "AsyncFunction" ||
    Object.prototype.toString.call(operation) === "[object AsyncFunction]"
  );
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" && value !== null) ||
    typeof value === "function"
  ) && typeof (value as { then?: unknown }).then === "function";
}

const STALE_AFTER_MS = 24 * 60 * 60 * 1_000;

function countBySource(
  listings: Listing[]
): Map<SourceId, number> {
  const counts = new Map<SourceId, number>();
  for (const listing of listings) {
    counts.set(
      listing.source,
      (counts.get(listing.source) ?? 0) + 1
    );
  }
  return counts;
}

export class ListingRepository {
  private readonly savepointPrefix =
    randomBytes(8).toString("hex");
  private savepointSequence = 0;

  constructor(private readonly database: DatabaseSync) {}

  runInTransaction<T>(
    operation: () => T,
    ..._synchronousOnly: SynchronousCallGuard<T>
  ): T {
    // Only synchronous writes to this repository's SQLite connection can be
    // rolled back. Network calls, messages, and other external side effects
    // must never run inside this transaction boundary.
    if (isNativeAsyncFunction(operation)) {
      throw new SynchronousTransactionError("operation");
    }
    return this.runTransaction(operation);
  }

  private insertRefreshEvents(
    runId: number,
    before: Listing[],
    after: Listing[],
    refreshedSources: ReadonlySet<SourceId>,
    createdAt: Date,
    removalSources: ReadonlySet<SourceId> = refreshedSources
  ): void {
    const events = detectRefreshEvents({
      runId,
      before,
      after,
      refreshedSources,
      removalSources,
      createdAt
    });
    const insert = this.database.prepare(`
      INSERT OR IGNORE INTO refresh_events (
        run_id, source, listing_key, type, severity,
        title, message, details_json, created_at, acknowledged
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `);
    for (const event of events) {
      insert.run(
        event.runId,
        event.source,
        event.listingKey,
        event.type,
        event.severity,
        event.title,
        event.message,
        JSON.stringify(event.details),
        event.createdAt
      );
    }
  }

  getRefreshEvents(
    limit = 30,
    onlyUnacknowledged = false
  ): StoredRefreshEvent[] {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const rows = this.database.prepare(`
      SELECT id, run_id, source, listing_key, type, severity,
             title, message, details_json, created_at, acknowledged
      FROM refresh_events AS event
      WHERE NOT (
        event.type = 'removed'
        AND event.source IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM scan_source_results AS source_result
          WHERE source_result.run_id = event.run_id
            AND source_result.source = event.source
            AND source_result.state <> 'success'
        )
      )
      ${onlyUnacknowledged ? "AND event.acknowledged = 0" : ""}
      ORDER BY event.id DESC
      LIMIT ?
    `).all(safeLimit) as unknown as Array<{
      id: number;
      run_id: number;
      source: SourceId | null;
      listing_key: string | null;
      type: StoredRefreshEvent["type"];
      severity: StoredRefreshEvent["severity"];
      title: string;
      message: string;
      details_json: string;
      created_at: string;
      acknowledged: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      source: row.source,
      listingKey: row.listing_key,
      type: row.type,
      severity: row.severity,
      title: row.title,
      message: row.message,
      details: JSON.parse(row.details_json) as Record<string, unknown>,
      createdAt: row.created_at,
      acknowledged: row.acknowledged === 1
    }));
  }

  acknowledgeRefreshEvents(ids?: number[]): number {
    if (!ids || ids.length === 0) {
      return Number(
        this.database.prepare(`
          UPDATE refresh_events
          SET acknowledged = 1
          WHERE acknowledged = 0
        `).run().changes
      );
    }
    const normalized = [...new Set(ids)].filter(
      (id) => Number.isSafeInteger(id) && id > 0
    );
    if (normalized.length === 0) return 0;
    const placeholders = normalized.map(() => "?").join(", ");
    return Number(
      this.database.prepare(`
        UPDATE refresh_events
        SET acknowledged = 1
        WHERE acknowledged = 0 AND id IN (${placeholders})
      `).run(...normalized).changes
    );
  }

  replaceSourceSnapshot(
    source: SourceId,
    listings: Listing[],
    state: "success" | "partial",
    now = new Date(),
    metadata: ScanMetadata = { pagesScanned: 0, stopReason: null }
  ): void {
    const timestamp = now.toISOString();
    try {
      this.database.exec("BEGIN IMMEDIATE");
      this.database
        .prepare("DELETE FROM listings WHERE source = ?")
        .run(source);
      const insert = this.database.prepare(`
        INSERT INTO listings (listing_key, source, eligibility, payload)
        VALUES (?, ?, ?, ?)
      `);
      for (const listing of listings) {
        const parsed = ListingSchema.parse(listing);
        insert.run(
          parsed.key,
          parsed.source,
          parsed.eligibility,
          JSON.stringify(parsed)
        );
      }
      this.database
        .prepare(`
          UPDATE source_status
          SET state = ?,
              last_attempt_at = ?,
              last_success_at = ?,
              item_count = ?,
              pages_scanned = ?,
              stop_reason = ?,
              error = ?
          WHERE source = ?
        `)
        .run(
          state,
          timestamp,
          timestamp,
          listings.length,
          metadata.pagesScanned,
          metadata.stopReason,
          metadata.error ?? null,
          source
        );
      this.database.exec("COMMIT");
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // The original write error remains the actionable failure.
      }
      throw new Error(`无法保存 ${source} 快照`, { cause: error });
    }
  }

  markSourceFailure(
    source: SourceId,
    error: string,
    now = new Date(),
    state: "blocked" | "failed" = "failed"
  ): void {
    this.database
      .prepare(`
        UPDATE source_status
        SET state = ?,
            last_attempt_at = ?,
            pages_scanned = 0,
            stop_reason = 'error',
            error = ?
        WHERE source = ?
      `)
      .run(state, now.toISOString(), error, source);
  }

  commitRefresh(
    listings: Listing[],
    statusUpdates: SourceRefreshStatusUpdate[]
  ): void {
    try {
      this.database.exec("BEGIN IMMEDIATE");
      this.database.exec("DELETE FROM listings");
      const insert = this.database.prepare(`
        INSERT INTO listings (listing_key, source, eligibility, payload)
        VALUES (?, ?, ?, ?)
      `);
      for (const listing of listings) {
        const parsed = ListingSchema.parse(listing);
        insert.run(
          parsed.key,
          parsed.source,
          parsed.eligibility,
          JSON.stringify(parsed)
        );
      }

      const updateSuccess = this.database.prepare(`
        UPDATE source_status
        SET state = ?,
            last_attempt_at = ?,
            last_success_at = ?,
            item_count = ?,
            pages_scanned = ?,
            stop_reason = ?,
            error = ?
        WHERE source = ?
      `);
      const updateFailure = this.database.prepare(`
        UPDATE source_status
        SET state = ?,
            last_attempt_at = ?,
            pages_scanned = 0,
            stop_reason = 'error',
            error = ?
        WHERE source = ?
      `);
      for (const update of statusUpdates) {
        const timestamp = update.attemptedAt.toISOString();
        if ("metadata" in update) {
          updateSuccess.run(
            update.state,
            timestamp,
            timestamp,
            update.itemCount,
            update.metadata.pagesScanned,
            update.metadata.stopReason,
            update.metadata.error ?? null,
            update.source
          );
        } else {
          updateFailure.run(
            update.state,
            timestamp,
            update.error,
            update.source
          );
        }
      }
      this.database.exec("COMMIT");
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original validation or SQL error.
      }
      throw new Error("无法提交刷新快照", { cause: error });
    }
  }

  startScan(startedAt = new Date()): number {
    const result = this.database
      .prepare(`
        INSERT INTO scan_runs (
          started_at, finished_at, state, error, is_baseline
        ) VALUES (?, NULL, 'running', NULL, 0)
      `)
      .run(startedAt.toISOString());
    return Number(result.lastInsertRowid);
  }

  startScopedScan(
    source: SourceId,
    startedAt = new Date()
  ): number {
    const parsedSource = SourceIdSchema.parse(source);
    const result = this.database
      .prepare(`
        INSERT INTO scan_runs (
          started_at, finished_at, state, error, is_baseline,
          scope, requested_source
        ) VALUES (?, NULL, 'running', NULL, 0, 'single_source', ?)
      `)
      .run(startedAt.toISOString(), parsedSource);
    return Number(result.lastInsertRowid);
  }

  hasCompletePublishedSourceSnapshot(source: SourceId): boolean {
    const parsedSource = SourceIdSchema.parse(source);
    const row = this.database.prepare(`
      SELECT state
      FROM scan_source_results
      WHERE source = ?
        AND published = 1
        AND stop_reason <> 'quick_window'
      ORDER BY run_id DESC
      LIMIT 1
    `).get(parsedSource) as { state: SourceState } | undefined;
    return row?.state === "success";
  }

  failScan(
    runId: number,
    error: string,
    finishedAt = new Date()
  ): void {
    this.database
      .prepare(`
        UPDATE scan_runs
        SET state = 'failed', finished_at = ?, error = ?
        WHERE id = ? AND is_baseline = 0
      `)
      .run(finishedAt.toISOString(), error, runId);
    this.pruneScanHistory();
  }

  finalizeFailedScan(
    runId: number,
    statusUpdates: SourceRefreshStatusUpdate[],
    error: string,
    finishedAt = new Date()
  ): void {
    try {
      this.database.exec("BEGIN IMMEDIATE");
      const updateSource = this.database.prepare(`
        UPDATE source_status
        SET state = ?,
            last_attempt_at = ?,
            pages_scanned = 0,
            stop_reason = 'error',
            error = ?
        WHERE source = ?
      `);
      const insertResult = this.database.prepare(`
        INSERT INTO scan_source_results (
          run_id, source, state, pages_scanned,
          observed_item_count, eligible_count,
          balanced_candidate_count, global_candidate_count,
          stop_reason, error
        ) VALUES (?, ?, ?, 0, 0, 0, 0, 0, 'error', ?)
      `);
      for (const update of statusUpdates) {
        if ("metadata" in update) {
          throw new Error("失败轮次不能包含新鲜来源");
        }
        updateSource.run(
          update.state,
          update.attemptedAt.toISOString(),
          update.error,
          update.source
        );
        insertResult.run(
          runId,
          update.source,
          update.state,
          update.error
        );
      }
      this.database
        .prepare(`
          UPDATE scan_runs
          SET state = 'failed', finished_at = ?, error = ?
          WHERE id = ? AND is_baseline = 0
        `)
        .run(finishedAt.toISOString(), error, runId);
      this.pruneScanHistory();
      this.database.exec("COMMIT");
    } catch (cause) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original failure.
      }
      throw new Error("无法记录失败刷新", { cause });
    }
  }

  commitScanRefresh<HookResult = void>(
    runId: number,
    listings: Listing[],
    statusUpdates: SourceRefreshStatusUpdate[],
    finishedAt = new Date(),
    beforeCommit?: (context: CommitScanRefreshContext) => HookResult,
    ..._synchronousOnly: SynchronousCallGuard<HookResult>
  ): ScanState {
    if (beforeCommit && isNativeAsyncFunction(beforeCommit)) {
      throw new SynchronousTransactionError("before_commit");
    }
    type FreshUpdate = Extract<
      SourceRefreshStatusUpdate,
      { state: "success" | "partial" }
    >;
    type PreparedUpdate = {
      original: SourceRefreshStatusUpdate;
      state: Exclude<SourceState, "idle">;
      published: boolean;
      anomalyState: "none" | "suspect" | "confirmed" | "recovered";
      nextGuard: SnapshotAnomalyGuard | null | undefined;
      stopReason: string;
      error: string | null;
    };
    const oldListings = this.getListings();
    const sourceStatus = new Map(
      this.getSourceStatuses().map((status) => [status.source, status])
    );
    const latestCompleteVolume = this.database.prepare(`
      SELECT observed_item_count, pages_scanned
      FROM scan_source_results
      WHERE source = ?
        AND state = 'success'
        AND published = 1
        AND stop_reason <> 'quick_window'
        AND NOT EXISTS (
          SELECT 1
          FROM browser_refresh_jobs
          WHERE published_run_id = scan_source_results.run_id
        )
      ORDER BY run_id DESC
      LIMIT 1
    `);
    const trustedBaselines = new Map<
      SourceId,
      { itemCount: number; pagesScanned: number }
    >();
    for (const source of ["jiaoyimao", "panzhi", "pxb7"] as const) {
      const row = latestCompleteVolume.get(source) as
        | { observed_item_count: number; pages_scanned: number }
        | undefined;
      const current = sourceStatus.get(source);
      if (row) {
        trustedBaselines.set(source, {
          itemCount: row.observed_item_count,
          pagesScanned: row.pages_scanned
        });
      } else if (current?.state === "success") {
        trustedBaselines.set(source, {
          itemCount: current.itemCount,
          pagesScanned: current.pagesScanned
        });
      }
    }
    const preparedUpdates: PreparedUpdate[] = statusUpdates.map((update) => {
      const currentStatus = sourceStatus.get(update.source);
      const pending =
        currentStatus?.anomaly.state === "suspect"
          ? {
              baseline: {
                itemCount: currentStatus.anomaly.baselineItemCount,
                pagesScanned:
                  currentStatus.anomaly.baselinePagesScanned
              },
              observed: {
                itemCount: currentStatus.anomaly.observedItemCount,
                pagesScanned:
                  currentStatus.anomaly.observedPagesScanned
              },
              confirmationCount:
                currentStatus.anomaly.confirmationCount,
              firstDetectedAt:
                currentStatus.anomaly.firstDetectedAt,
              lastDetectedAt:
                currentStatus.anomaly.lastDetectedAt,
              reason: currentStatus.anomaly
                .reason as SnapshotAnomalyGuard["reason"]
            }
          : null;
      if (!("metadata" in update)) {
        return {
          original: update,
          state: update.state,
          published: false,
          anomalyState: pending ? "suspect" : "none",
          nextGuard: undefined,
          stopReason: "error",
          error: update.error
        };
      }
      if (update.metadata.coverage === "incremental") {
        return {
          original: update,
          state: update.state,
          published: true,
          anomalyState: pending ? "suspect" : "none",
          nextGuard: undefined,
          stopReason: update.metadata.stopReason ?? "quick_window",
          error: update.metadata.error ?? null
        };
      }
      if (update.state === "partial") {
        const partialDrop = evaluateSnapshotAnomaly({
          complete: true,
          baseline:
            pending?.baseline ??
            trustedBaselines.get(update.source) ?? {
              itemCount: 0,
              pagesScanned: 0
            },
          current: {
            itemCount: update.itemCount,
            pagesScanned: update.metadata.pagesScanned
          },
          pending: null,
          observedAt: update.attemptedAt.toISOString()
        });
        const recoveredPending =
          pending !== null && partialDrop.kind === "accept";
        return {
          original: update,
          state: "partial",
          published:
            recoveredPending ||
            (pending === null && partialDrop.kind !== "quarantine"),
          anomalyState: recoveredPending
            ? "recovered"
            : pending
              ? "suspect"
              : "none",
          nextGuard: recoveredPending ? null : undefined,
          stopReason: pending && !recoveredPending
            ? "anomaly_guard"
            : (update.metadata.stopReason ?? "error"),
          error: update.metadata.error ?? null
        };
      }
      const decision = evaluateSnapshotAnomaly({
        complete: true,
        baseline:
          pending?.baseline ??
          trustedBaselines.get(update.source) ?? {
            itemCount: 0,
            pagesScanned: 0
          },
        current: {
          itemCount: update.itemCount,
          pagesScanned: update.metadata.pagesScanned
        },
        pending,
        observedAt: update.attemptedAt.toISOString()
      });
      if (decision.kind === "quarantine") {
        return {
          original: update,
          state: "partial",
          published: false,
          anomalyState: "suspect",
          nextGuard: decision.nextGuard,
          stopReason: "anomaly_guard",
          error: `数据骤降待确认：观测 ${update.itemCount} 条`
        };
      }
      return {
        original: update,
        state: "success",
        published: true,
        anomalyState:
          decision.reason === "confirmed"
            ? "confirmed"
            : decision.reason === "recovered"
              ? "recovered"
              : "none",
        nextGuard: null,
        stopReason: update.metadata.stopReason ?? "end_of_pages",
        error: update.metadata.error ?? null
      };
    });
    const freshUpdates = preparedUpdates.filter(
      (prepared): prepared is PreparedUpdate & { original: FreshUpdate } =>
        "metadata" in prepared.original
    );
    const roundState: ScanState =
      freshUpdates.length === 0
        ? "failed"
        : preparedUpdates.every(
            ({ state, published }) => state === "success" && published
          )
          ? "success"
          : "partial";
    const successfulSources = new Set(
      freshUpdates
        .filter(
          ({ state, published }) => state === "success" && published
        )
        .map(({ original }) => original.source)
    );
    const partialSources = new Set(
      freshUpdates
        .filter(
          ({ state, published }) => state === "partial" && published
        )
        .map(({ original }) => original.source)
    );
    const incrementalObservedKeys = new Map<SourceId, Set<string>>(
      freshUpdates
        .filter(
          ({ original, published }) =>
            published && original.metadata.coverage === "incremental"
        )
        .map(({ original }) => [
          original.source,
          new Set(original.metadata.observedListingKeys ?? [])
        ])
    );
    const incomingBySource = new Map<SourceId, Listing[]>();
    const oldBySource = new Map<SourceId, Listing[]>();
    for (const source of ["jiaoyimao", "panzhi", "pxb7"] as const) {
      incomingBySource.set(
        source,
        listings.filter((listing) => listing.source === source)
      );
      oldBySource.set(
        source,
        oldListings.filter((listing) => listing.source === source)
      );
    }
    const preparedBySource = new Map(
      preparedUpdates.map((prepared) => [
        prepared.original.source,
        prepared
      ])
    );
    const effectiveListings = (
      ["jiaoyimao", "panzhi", "pxb7"] as const
    ).flatMap((source) => {
      const prepared = preparedBySource.get(source);
      return prepared?.published
        ? (incomingBySource.get(source) ?? [])
        : (oldBySource.get(source) ?? []);
    });
    const runScope = this.database.prepare(`
      SELECT COALESCE(scope, 'all_sources') AS scope
      FROM scan_runs
      WHERE id = ? AND is_baseline = 0
    `).get(runId) as
      | { scope: "all_sources" | "single_source" }
      | undefined;
    if (!runScope) throw new Error("刷新轮次不存在");
    const candidateSources = new Set<SourceId>([
      ...[...sourceStatus.values()]
        .filter(({ lastSuccessAt }) => lastSuccessAt !== null)
        .map(({ source }) => source),
      ...preparedUpdates
        .filter(
          ({ published, anomalyState }) =>
            published || anomalyState === "suspect"
        )
        .map(({ original }) => original.source)
    ]);
    if (runScope.scope === "single_source") {
      for (const status of sourceStatus.values()) {
        if (status.state === "success" || status.state === "partial") {
          candidateSources.add(status.source);
        }
      }
    }
    const markedCandidates = markPossibleDuplicates(
      effectiveListings
        .filter(({ source }) => candidateSources.has(source))
        .map((listing) => ({ ...listing, score: null }))
    );
    const scoredCandidates = scoreEligibleListings(
      markedCandidates,
      finishedAt
    );
    const markedByKey = new Map(
      markedCandidates.map((listing) => [listing.key, listing])
    );
    const scoreByKey = new Map(
      scoredCandidates.map((listing) => [listing.key, listing.score])
    );
    const normalizedListings = effectiveListings.map((listing) => {
      const marked = markedByKey.get(listing.key);
      if (!marked) {
        return {
          ...listing,
          score: null,
          possibleDuplicateKeys: []
        };
      }
      return {
        ...marked,
        score: scoreByKey.get(marked.key) ?? null
      };
    });
    const oldListingByKey = new Map(
      oldListings.map((listing) => [listing.key, listing] as const)
    );
    const derivedListings = normalizedListings.map((listing) => {
      const incrementalKeys = incrementalObservedKeys.get(listing.source);
      if (incrementalKeys) {
        const previous = oldListingByKey.get(listing.key);
        if (!incrementalKeys.has(listing.key)) {
          return previous
            ? {
                ...listing,
                scanStability: previous.scanStability,
                consecutiveUnchangedScans:
                  previous.consecutiveUnchangedScans
              }
            : listing;
        }
        if (!previous) {
          return {
            ...listing,
            scanStability: "new" as const,
            consecutiveUnchangedScans: 1
          };
        }
        if (listingMaterialHash(previous) !== listingMaterialHash(listing)) {
          return {
            ...listing,
            scanStability: "changed" as const,
            consecutiveUnchangedScans: 1
          };
        }
        return {
          ...listing,
          scanStability: "stable" as const,
          consecutiveUnchangedScans:
            previous.consecutiveUnchangedScans + 1
        };
      }
      if (partialSources.has(listing.source)) {
        return {
          ...listing,
          scanStability: "unknown" as const,
          consecutiveUnchangedScans: 0
        };
      }
      if (!successfulSources.has(listing.source)) {
        return listing;
      }
      const previousRun = this.database
        .prepare(`
          SELECT sr.run_id
          FROM scan_source_results sr
          JOIN scan_runs r ON r.id = sr.run_id
          WHERE sr.source = ?
            AND sr.state = 'success'
            AND sr.published = 1
            AND sr.stop_reason <> 'quick_window'
            AND sr.run_id < ?
          ORDER BY sr.run_id DESC
          LIMIT 1
        `)
        .get(listing.source, runId) as
        | { run_id: number }
        | undefined;
      if (!previousRun) {
        return {
          ...listing,
          scanStability: "new" as const,
          consecutiveUnchangedScans: 1
        };
      }
      const previous = this.database
        .prepare(`
          SELECT material_hash, consecutive_unchanged_scans
          FROM listing_observations
          WHERE run_id = ?
            AND listing_key = ?
            AND availability = 'active'
        `)
        .get(previousRun.run_id, listing.key) as
        | {
            material_hash: string;
            consecutive_unchanged_scans: number;
          }
        | undefined;
      if (!previous) {
        return {
          ...listing,
          scanStability: "new" as const,
          consecutiveUnchangedScans: 1
        };
      }
      if (previous.material_hash !== listingMaterialHash(listing)) {
        return {
          ...listing,
          scanStability: "changed" as const,
          consecutiveUnchangedScans: 1
        };
      }
      return {
        ...listing,
        scanStability: "stable" as const,
        consecutiveUnchangedScans:
          previous.consecutive_unchanged_scans + 1
      };
    });

    let beforeCommitFailed = false;
    let beforeCommitFailure: unknown;
    try {
      return this.runTransaction(() => {
      this.database.exec("DELETE FROM listings");
      const insertListing = this.database.prepare(`
        INSERT INTO listings (listing_key, source, eligibility, payload)
        VALUES (?, ?, ?, ?)
      `);
      for (const listing of derivedListings) {
        const parsed = ListingSchema.parse(listing);
        insertListing.run(
          parsed.key,
          parsed.source,
          parsed.eligibility,
          JSON.stringify(parsed)
        );
      }

      const balancedCounts = countBySource(
        selectBalancedCandidatePool(derivedListings)
      );
      const globalCounts = countBySource(
        selectGlobalCandidatePool(derivedListings)
      );
      const updateSuccess = this.database.prepare(`
        UPDATE source_status
        SET state = ?,
            last_attempt_at = ?,
            last_success_at = ?,
            item_count = ?,
            pages_scanned = ?,
            stop_reason = ?,
            error = ?
        WHERE source = ?
      `);
      const updateFailure = this.database.prepare(`
        UPDATE source_status
        SET state = ?,
            last_attempt_at = ?,
            pages_scanned = 0,
            stop_reason = 'error',
            error = ?
        WHERE source = ?
      `);
      const insertResult = this.database.prepare(`
        INSERT INTO scan_source_results (
          run_id, source, state, pages_scanned,
          observed_item_count, eligible_count,
          balanced_candidate_count, global_candidate_count,
          anomaly_state, published, stop_reason, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertObservation = this.database.prepare(`
        INSERT INTO listing_observations (
          run_id, listing_key, source, observed_at, eligibility,
          material_hash, stability, consecutive_unchanged_scans,
          snapshot_json, changes_json, availability, trusted
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const previousTrustedObservation = this.database.prepare(`
        SELECT snapshot_json, availability
        FROM listing_observations
        WHERE listing_key = ?
          AND trusted = 1
          AND snapshot_json IS NOT NULL
          AND run_id < ?
        ORDER BY run_id DESC
        LIMIT 1
      `);
      const previousTrustedRun = this.database.prepare(`
        SELECT run_id
        FROM scan_source_results
        WHERE source = ?
          AND state = 'success'
          AND published = 1
          AND stop_reason <> 'quick_window'
          AND run_id < ?
        ORDER BY run_id DESC
        LIMIT 1
      `);
      const previousActiveObservations = this.database.prepare(`
        SELECT listing_key, eligibility, material_hash, snapshot_json
        FROM listing_observations
        WHERE run_id = ?
          AND source = ?
          AND trusted = 1
          AND availability = 'active'
          AND snapshot_json IS NOT NULL
      `);

      const preserveStatus = this.database.prepare(`
        UPDATE source_status
        SET state = ?,
            last_attempt_at = ?,
            stop_reason = ?,
            error = ?
        WHERE source = ?
      `);
      const clearGuard = this.database.prepare(`
        UPDATE source_anomaly_guards
        SET state = 'clear',
            baseline_item_count = NULL,
            baseline_pages_scanned = NULL,
            observed_item_count = NULL,
            observed_pages_scanned = NULL,
            confirmation_count = 0,
            first_detected_at = NULL,
            last_detected_at = NULL,
            reason = NULL
        WHERE source = ?
      `);
      const saveGuard = this.database.prepare(`
        UPDATE source_anomaly_guards
        SET state = 'suspect',
            baseline_item_count = ?,
            baseline_pages_scanned = ?,
            observed_item_count = ?,
            observed_pages_scanned = ?,
            confirmation_count = ?,
            first_detected_at = ?,
            last_detected_at = ?,
            reason = ?
        WHERE source = ?
      `);

      for (const prepared of preparedUpdates) {
        const update = prepared.original;
        const timestamp = update.attemptedAt.toISOString();
        if (prepared.nextGuard === null) {
          clearGuard.run(update.source);
        } else if (prepared.nextGuard !== undefined) {
          saveGuard.run(
            prepared.nextGuard.baseline.itemCount,
            prepared.nextGuard.baseline.pagesScanned,
            prepared.nextGuard.observed.itemCount,
            prepared.nextGuard.observed.pagesScanned,
            prepared.nextGuard.confirmationCount,
            prepared.nextGuard.firstDetectedAt,
            prepared.nextGuard.lastDetectedAt,
            prepared.nextGuard.reason,
            update.source
          );
        }
        if ("metadata" in update) {
          if (prepared.published) {
            updateSuccess.run(
              prepared.state,
              timestamp,
              timestamp,
              update.itemCount,
              update.metadata.pagesScanned,
              prepared.stopReason,
              prepared.error,
              update.source
            );
          } else {
            preserveStatus.run(
              prepared.state,
              timestamp,
              prepared.stopReason,
              prepared.error,
              update.source
            );
          }
          const sourceListings = derivedListings.filter(
            ({ source }) => source === update.source
          );
          const incrementalKeys = incrementalObservedKeys.get(update.source);
          const observedListings = listings.filter(
            ({ source, key }) =>
              source === update.source &&
              (!incrementalKeys || incrementalKeys.has(key))
          );
          insertResult.run(
            runId,
            update.source,
            prepared.state,
            update.metadata.pagesScanned,
            update.metadata.observedItemCount ?? update.itemCount,
            observedListings.filter(
              ({ eligibility }) => eligibility === "eligible"
            ).length,
            balancedCounts.get(update.source) ?? 0,
            globalCounts.get(update.source) ?? 0,
            prepared.anomalyState,
            prepared.published ? 1 : 0,
            prepared.stopReason,
            prepared.error
          );
          if (prepared.published) {
            if (prepared.state === "success") {
              const historyListings = incrementalKeys
                ? sourceListings.filter(({ key }) =>
                    incrementalKeys.has(key)
                  )
                : sourceListings;
              const currentKeys = new Set(
                sourceListings.map(({ key }) => key)
              );
              for (const listing of historyListings) {
                const snapshot = buildListingHistorySnapshot(listing);
                const previous = previousTrustedObservation.get(
                  listing.key,
                  runId
                ) as
                  | {
                      snapshot_json: string;
                      availability: "active" | "removed";
                    }
                  | undefined;
                const changes: ListingFieldChange[] = previous
                  ? [
                      ...(previous.availability === "removed"
                        ? [
                            {
                              field: "availability" as const,
                              label: "在售状态",
                              before: "已下架",
                              after: "在售"
                            }
                          ]
                        : []),
                      ...diffListingSnapshots(
                        normalizeListingHistorySnapshot(
                          JSON.parse(previous.snapshot_json)
                        ),
                        snapshot
                      )
                    ]
                  : [
                      {
                        field: "availability",
                        label: "在售状态",
                        before: "未记录",
                        after: "在售"
                      }
                    ];
                insertObservation.run(
                  runId,
                  listing.key,
                  listing.source,
                  timestamp,
                  listing.eligibility,
                  listingMaterialHash(listing),
                  listing.scanStability,
                  listing.consecutiveUnchangedScans,
                  JSON.stringify(snapshot),
                  JSON.stringify(changes),
                  "active",
                  1
                );
              }
              if (!incrementalKeys) {
                const previousRun = previousTrustedRun.get(
                  update.source,
                  runId
                ) as { run_id: number } | undefined;
                const previousRows = previousRun
                  ? (previousActiveObservations.all(
                      previousRun.run_id,
                      update.source
                    ) as unknown as Array<{
                      listing_key: string;
                      eligibility: Eligibility;
                      material_hash: string;
                      snapshot_json: string;
                    }>)
                  : (oldBySource.get(update.source) ?? []).map(
                      (listing) => ({
                        listing_key: listing.key,
                        eligibility: listing.eligibility,
                        material_hash: listingMaterialHash(listing),
                        snapshot_json: JSON.stringify(
                          buildListingHistorySnapshot(listing)
                        )
                      })
                    );
                for (const previous of previousRows) {
                  if (currentKeys.has(previous.listing_key)) continue;
                  insertObservation.run(
                    runId,
                    previous.listing_key,
                    update.source,
                    timestamp,
                    previous.eligibility,
                    previous.material_hash,
                    "changed",
                    0,
                    previous.snapshot_json,
                    JSON.stringify([
                      {
                        field: "availability",
                        label: "在售状态",
                        before: "在售",
                        after: "已下架"
                      }
                    ]),
                    "removed",
                    1
                  );
                }
              }
            } else {
              for (const listing of sourceListings) {
                insertObservation.run(
                  runId,
                  listing.key,
                  listing.source,
                  timestamp,
                  listing.eligibility,
                  listingMaterialHash(listing),
                  listing.scanStability,
                  listing.consecutiveUnchangedScans,
                  null,
                  "[]",
                  "active",
                  0
                );
              }
            }
          }
        } else {
          updateFailure.run(
            update.state,
            timestamp,
            update.error,
            update.source
          );
          insertResult.run(
            runId,
            update.source,
            update.state,
            0,
            0,
            0,
            0,
            0,
            prepared.anomalyState,
            0,
            "error",
            update.error
          );
        }
      }

      this.insertRefreshEvents(
        runId,
        oldListings,
        derivedListings,
        new Set(
          preparedUpdates
            .filter(({ published }) => published)
            .map(({ original }) => original.source)
        ),
        finishedAt,
        successfulSources
      );
      this.database
        .prepare(`
          UPDATE scan_runs
          SET state = ?, finished_at = ?, error = NULL
          WHERE id = ? AND is_baseline = 0
        `)
        .run(roundState, finishedAt.toISOString(), runId);
      this.pruneScanHistory();
      try {
        const hookResult = beforeCommit?.({
          runId,
          state: roundState,
          publishedSources: preparedUpdates
            .filter(({ published }) => published)
            .map(({ original }) => original.source)
        });
        if (isThenable(hookResult)) {
          throw new SynchronousTransactionError("before_commit");
        }
      } catch (error) {
        beforeCommitFailed = true;
        beforeCommitFailure = error;
        throw error;
      }
      return roundState;
      });
    } catch (cause) {
      if (beforeCommitFailed) {
        throw beforeCommitFailure;
      }
      throw new Error("无法提交带历史的刷新快照", { cause });
    }
  }

  commitBrowserSourceRefresh(
    input: CommitBrowserSourceRefreshInput
  ): CommitBrowserSourceRefreshResult {
    if (
      input.source !== "jiaoyimao" ||
      !Number.isSafeInteger(input.pagesScanned) ||
      input.pagesScanned < 0 ||
      !["end_of_pages", "no_growth_twice"].includes(input.stopReason)
    ) {
      throw new Error("交易猫浏览器刷新参数无效");
    }
    const incoming = input.listings.map((listing) => {
      const parsed = ListingSchema.parse(listing);
      if (parsed.source !== input.source) {
        throw new Error("交易猫浏览器刷新包含其他来源");
      }
      return parsed;
    });
    const timestamp = input.attemptedAt.toISOString();

    try {
      return this.runTransaction(() => {
      const job = this.database.prepare(`
        SELECT state, filter_url
        FROM browser_refresh_jobs
        WHERE id = ? AND source = 'jiaoyimao'
      `).get(input.jobId) as
        | { state: string; filter_url: string | null }
        | undefined;
      if (!job || job.state !== "committing" || !job.filter_url) {
        throw new Error("浏览器刷新任务不在提交状态");
      }

      const run = this.database.prepare(`
        INSERT INTO scan_runs (
          started_at, finished_at, state, error, is_baseline,
          scope, requested_source
        ) VALUES (?, NULL, 'running', NULL, 0, 'single_source', ?)
      `).run(timestamp, input.source);
      const scanRunId = Number(run.lastInsertRowid);

      const status = this.getSourceStatuses(input.attemptedAt).find(
        ({ source }) => source === input.source
      );
      if (!status) throw new Error("交易猫来源状态不存在");
      const comparableBaseline = this.database.prepare(`
        SELECT
          browser_refresh_jobs.finished_at,
          scan_source_results.observed_item_count,
          scan_source_results.pages_scanned
        FROM browser_refresh_jobs
        JOIN scan_source_results
          ON scan_source_results.run_id = browser_refresh_jobs.published_run_id
         AND scan_source_results.source = browser_refresh_jobs.source
        WHERE browser_refresh_jobs.id <> ?
          AND browser_refresh_jobs.source = 'jiaoyimao'
          AND browser_refresh_jobs.state = 'success'
          AND browser_refresh_jobs.filter_url = ?
          AND browser_refresh_jobs.published_run_id IS NOT NULL
        ORDER BY browser_refresh_jobs.finished_at DESC
        LIMIT 1
      `).get(input.jobId, job.filter_url) as
        | {
            finished_at: string;
            observed_item_count: number;
            pages_scanned: number;
          }
        | undefined;
      const baseline = comparableBaseline
        ? {
            itemCount: comparableBaseline.observed_item_count,
            pagesScanned: comparableBaseline.pages_scanned
          }
        : { itemCount: 0, pagesScanned: 0 };
      const latestComparableQuarantine = comparableBaseline
        ? this.database.prepare(`
            SELECT
              browser_refresh_jobs.finished_at,
              scan_source_results.observed_item_count,
              scan_source_results.pages_scanned
            FROM browser_refresh_jobs
            JOIN scan_source_results
              ON scan_source_results.run_id = browser_refresh_jobs.scan_run_id
             AND scan_source_results.source = browser_refresh_jobs.source
            WHERE browser_refresh_jobs.id <> ?
              AND browser_refresh_jobs.source = 'jiaoyimao'
              AND browser_refresh_jobs.state = 'quarantined'
              AND browser_refresh_jobs.filter_url = ?
              AND browser_refresh_jobs.finished_at > ?
              AND browser_refresh_jobs.scan_run_id IS NOT NULL
            ORDER BY browser_refresh_jobs.finished_at DESC
            LIMIT 1
          `).get(
            input.jobId,
            job.filter_url,
            comparableBaseline.finished_at
          ) as
            | {
                finished_at: string;
                observed_item_count: number;
                pages_scanned: number;
              }
            | undefined
        : undefined;
      const previousBrowserDecision = latestComparableQuarantine
        ? evaluateSnapshotAnomaly({
            complete: true,
            baseline,
            current: {
              itemCount: latestComparableQuarantine.observed_item_count,
              pagesScanned: latestComparableQuarantine.pages_scanned
            },
            pending: null,
            observedAt: latestComparableQuarantine.finished_at
          })
        : null;
      const pending = previousBrowserDecision?.kind === "quarantine"
        ? previousBrowserDecision.nextGuard
        : null;
      const decision = comparableBaseline
        ? evaluateSnapshotAnomaly({
            complete: true,
            baseline,
            current: {
              itemCount: incoming.length,
              pagesScanned: input.pagesScanned
            },
            pending,
            observedAt: timestamp
          })
        : {
            kind: "accept" as const,
            reason: "normal" as const,
            nextGuard: null
          };
      if (decision.kind === "not_applicable") {
        throw new Error("完整浏览器快照不能跳过异常判定");
      }

      const insertResult = this.database.prepare(`
        INSERT INTO scan_source_results (
          run_id, source, state, pages_scanned,
          observed_item_count, eligible_count,
          balanced_candidate_count, global_candidate_count,
          anomaly_state, published, stop_reason, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const finishJob = (
        state: "success" | "quarantined",
        publishedRunId: number | null,
        reason: string | null
      ) => {
        this.database.prepare(`
          UPDATE browser_refresh_jobs
          SET state = ?,
              stage = ?,
              reason = ?,
              updated_at = ?,
              finished_at = ?,
              last_error = ?,
              scan_run_id = ?,
              published_run_id = ?,
              claim_code_hash = NULL,
              bridge_token_hash = NULL,
              action_permit_hash = NULL,
              action_permit_expires_at = NULL
          WHERE id = ? AND state = 'committing'
        `).run(
          state,
          state,
          reason,
          timestamp,
          timestamp,
          reason,
          scanRunId,
          publishedRunId,
          input.jobId
        );
      };

      if (decision.kind === "quarantine") {
        const error = `数据骤降待确认：观测 ${incoming.length} 条`;
        const existing = this.getListings();
        const balancedCounts = countBySource(
          selectBalancedCandidatePool(existing)
        );
        const globalCounts = countBySource(
          selectGlobalCandidatePool(existing)
        );
        this.database.prepare(`
          UPDATE source_anomaly_guards
          SET state = 'clear',
              baseline_item_count = NULL,
              baseline_pages_scanned = NULL,
              observed_item_count = NULL,
              observed_pages_scanned = NULL,
              confirmation_count = 0,
              first_detected_at = NULL,
              last_detected_at = NULL,
              reason = NULL
          WHERE source = ?
        `).run(input.source);
        this.database.prepare(`
          UPDATE source_status
          SET state = 'partial',
              last_attempt_at = ?,
              stop_reason = 'anomaly_guard',
              error = ?
          WHERE source = ?
        `).run(timestamp, error, input.source);
        insertResult.run(
          scanRunId,
          input.source,
          "partial",
          input.pagesScanned,
          incoming.length,
          incoming.filter(
            ({ eligibility }) => eligibility === "eligible"
          ).length,
          balancedCounts.get(input.source) ?? 0,
          globalCounts.get(input.source) ?? 0,
          "suspect",
          0,
          "anomaly_guard",
          error
        );
        this.database.prepare(`
          UPDATE scan_runs
          SET state = 'partial', finished_at = ?, error = NULL
          WHERE id = ?
        `).run(timestamp, scanRunId);
        finishJob(
          "quarantined",
          null,
          "anomaly_quarantined"
        );
        this.pruneScanHistory();
        return {
          state: "quarantined",
          scanRunId,
          publishedRunId: null
        };
      }

      const oldListings = this.getListings();
      const oldSourceListings = oldListings.filter(
        ({ source }) => source === input.source
      );
      const effective = [
        ...oldListings.filter(({ source }) => source !== input.source),
        ...incoming
      ];
      const activeSources = new Set(
        this.getSourceStatuses(input.attemptedAt)
          .filter(
            ({ source, state }) =>
              source === input.source ||
              state === "success" ||
              state === "partial"
          )
          .map(({ source }) => source)
      );
      const marked = markPossibleDuplicates(
        effective
          .filter(({ source }) => activeSources.has(source))
          .map((listing) => ({
            ...listing,
            score: null,
            possibleDuplicateKeys: []
          }))
      );
      const scored = scoreEligibleListings(marked, input.attemptedAt);
      const markedByKey = new Map(
        marked.map((listing) => [listing.key, listing])
      );
      const scoreByKey = new Map(
        scored.map((listing) => [listing.key, listing.score])
      );
      let normalized = effective.map((listing) => {
        const candidate = markedByKey.get(listing.key);
        return candidate
          ? {
              ...candidate,
              score: scoreByKey.get(candidate.key) ?? null
            }
          : {
              ...listing,
              score: null,
              possibleDuplicateKeys: []
            };
      });

      const previousRun = this.database.prepare(`
        SELECT run_id
        FROM scan_source_results
        WHERE source = ?
          AND state = 'success'
          AND published = 1
          AND run_id < ?
        ORDER BY run_id DESC
        LIMIT 1
      `).get(input.source, scanRunId) as
        | { run_id: number }
        | undefined;
      const previousStability = this.database.prepare(`
        SELECT material_hash, consecutive_unchanged_scans
        FROM listing_observations
        WHERE run_id = ?
          AND listing_key = ?
          AND availability = 'active'
      `);
      normalized = normalized.map((listing) => {
        if (listing.source !== input.source) return listing;
        if (!previousRun) {
          return {
            ...listing,
            scanStability: "new" as const,
            consecutiveUnchangedScans: 1
          };
        }
        const previous = previousStability.get(
          previousRun.run_id,
          listing.key
        ) as
          | {
              material_hash: string;
              consecutive_unchanged_scans: number;
            }
          | undefined;
        if (!previous) {
          return {
            ...listing,
            scanStability: "new" as const,
            consecutiveUnchangedScans: 1
          };
        }
        if (previous.material_hash !== listingMaterialHash(listing)) {
          return {
            ...listing,
            scanStability: "changed" as const,
            consecutiveUnchangedScans: 1
          };
        }
        return {
          ...listing,
          scanStability: "stable" as const,
          consecutiveUnchangedScans:
            previous.consecutive_unchanged_scans + 1
        };
      });

      const updateListing = this.database.prepare(`
        UPDATE listings
        SET eligibility = ?, payload = ?
        WHERE listing_key = ?
      `);
      for (const listing of normalized) {
        if (listing.source === input.source) continue;
        const parsed = ListingSchema.parse(listing);
        updateListing.run(
          parsed.eligibility,
          JSON.stringify(parsed),
          parsed.key
        );
      }
      this.database.prepare(
        "DELETE FROM listings WHERE source = ?"
      ).run(input.source);
      const insertListing = this.database.prepare(`
        INSERT INTO listings (listing_key, source, eligibility, payload)
        VALUES (?, ?, ?, ?)
      `);
      const publishedSourceListings = normalized.filter(
        ({ source }) => source === input.source
      );
      for (const listing of publishedSourceListings) {
        const parsed = ListingSchema.parse(listing);
        insertListing.run(
          parsed.key,
          parsed.source,
          parsed.eligibility,
          JSON.stringify(parsed)
        );
      }

      const balancedCounts = countBySource(
        selectBalancedCandidatePool(normalized)
      );
      const globalCounts = countBySource(
        selectGlobalCandidatePool(normalized)
      );
      this.database.prepare(`
        UPDATE source_status
        SET state = 'success',
            last_attempt_at = ?,
            last_success_at = ?,
            item_count = ?,
            pages_scanned = ?,
            stop_reason = ?,
            error = NULL
        WHERE source = ?
      `).run(
        timestamp,
        timestamp,
        incoming.length,
        input.pagesScanned,
        input.stopReason,
        input.source
      );
      this.database.prepare(`
        UPDATE source_anomaly_guards
        SET state = 'clear',
            baseline_item_count = NULL,
            baseline_pages_scanned = NULL,
            observed_item_count = NULL,
            observed_pages_scanned = NULL,
            confirmation_count = 0,
            first_detected_at = NULL,
            last_detected_at = NULL,
            reason = NULL
        WHERE source = ?
      `).run(input.source);
      insertResult.run(
        scanRunId,
        input.source,
        "success",
        input.pagesScanned,
        incoming.length,
        publishedSourceListings.filter(
          ({ eligibility }) => eligibility === "eligible"
        ).length,
        balancedCounts.get(input.source) ?? 0,
        globalCounts.get(input.source) ?? 0,
        decision.reason === "confirmed"
          ? "confirmed"
          : decision.reason === "recovered"
            ? "recovered"
            : "none",
        1,
        input.stopReason,
        null
      );

      const insertObservation = this.database.prepare(`
        INSERT INTO listing_observations (
          run_id, listing_key, source, observed_at, eligibility,
          material_hash, stability, consecutive_unchanged_scans,
          snapshot_json, changes_json, availability, trusted
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `);
      const previousTrustedObservation = this.database.prepare(`
        SELECT snapshot_json, availability
        FROM listing_observations
        WHERE listing_key = ?
          AND trusted = 1
          AND snapshot_json IS NOT NULL
          AND run_id < ?
        ORDER BY run_id DESC
        LIMIT 1
      `);
      const currentKeys = new Set(
        publishedSourceListings.map(({ key }) => key)
      );
      for (const listing of publishedSourceListings) {
        const snapshot = buildListingHistorySnapshot(listing);
        const previous = previousTrustedObservation.get(
          listing.key,
          scanRunId
        ) as
          | {
              snapshot_json: string;
              availability: "active" | "removed";
            }
          | undefined;
        const changes: ListingFieldChange[] = previous
          ? [
              ...(previous.availability === "removed"
                ? [{
                    field: "availability" as const,
                    label: "在售状态",
                    before: "已下架",
                    after: "在售"
                  }]
                : []),
              ...diffListingSnapshots(
                normalizeListingHistorySnapshot(
                  JSON.parse(previous.snapshot_json)
                ),
                snapshot
              )
            ]
          : [{
              field: "availability",
              label: "在售状态",
              before: "未记录",
              after: "在售"
            }];
        insertObservation.run(
          scanRunId,
          listing.key,
          listing.source,
          timestamp,
          listing.eligibility,
          listingMaterialHash(listing),
          listing.scanStability,
          listing.consecutiveUnchangedScans,
          JSON.stringify(snapshot),
          JSON.stringify(changes),
          "active"
        );
      }
      const previousTrustedRun = this.database.prepare(`
        SELECT run_id
        FROM scan_source_results
        WHERE source = ?
          AND state = 'success'
          AND published = 1
          AND run_id < ?
        ORDER BY run_id DESC
        LIMIT 1
      `).get(input.source, scanRunId) as
        | { run_id: number }
        | undefined;
      const previousRows = previousTrustedRun
        ? (this.database.prepare(`
            SELECT listing_key, eligibility, material_hash, snapshot_json
            FROM listing_observations
            WHERE run_id = ?
              AND source = ?
              AND trusted = 1
              AND availability = 'active'
              AND snapshot_json IS NOT NULL
          `).all(
            previousTrustedRun.run_id,
            input.source
          ) as unknown as Array<{
            listing_key: string;
            eligibility: Eligibility;
            material_hash: string;
            snapshot_json: string;
          }>)
        : oldSourceListings.map((listing) => ({
            listing_key: listing.key,
            eligibility: listing.eligibility,
            material_hash: listingMaterialHash(listing),
            snapshot_json: JSON.stringify(
              buildListingHistorySnapshot(listing)
            )
          }));
      for (const previous of previousRows) {
        if (currentKeys.has(previous.listing_key)) continue;
        insertObservation.run(
          scanRunId,
          previous.listing_key,
          input.source,
          timestamp,
          previous.eligibility,
          previous.material_hash,
          "changed",
          0,
          previous.snapshot_json,
          JSON.stringify([{
            field: "availability",
            label: "在售状态",
            before: "在售",
            after: "已下架"
          }]),
          "removed"
        );
      }

      this.insertRefreshEvents(
        scanRunId,
        oldListings,
        normalized,
        new Set([input.source]),
        input.attemptedAt
      );
      this.database.prepare(`
        UPDATE scan_runs
        SET state = 'success', finished_at = ?, error = NULL
        WHERE id = ?
      `).run(timestamp, scanRunId);
      finishJob("success", scanRunId, null);
      this.pruneScanHistory();
      return {
        state: "success",
        scanRunId,
        publishedRunId: scanRunId
      };
      });
    } catch (cause) {
      throw new Error("无法提交交易猫浏览器刷新", { cause });
    }
  }

  getScanHistory(limit: number): ScanHistoryRun[] {
    const rows = this.database
      .prepare(`
        SELECT id, started_at, finished_at, state, error,
               COALESCE(scope, 'all_sources') AS scope,
               requested_source
        FROM scan_runs
        WHERE is_baseline = 0
        ORDER BY id DESC
        LIMIT ?
      `)
      .all(limit) as unknown as Array<{
        id: number;
        started_at: string;
        finished_at: string | null;
        state: "running" | ScanState;
        error: string | null;
        scope: "all_sources" | "single_source";
        requested_source: SourceId | null;
      }>;
    const sourceQuery = this.database.prepare(`
      SELECT source, state, pages_scanned, observed_item_count,
             eligible_count, balanced_candidate_count,
             global_candidate_count, anomaly_state, published,
             stop_reason, error
      FROM scan_source_results
      WHERE run_id = ?
      ORDER BY source
    `);
    return rows.map((row) => ({
      id: row.id,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      state: row.state,
      error: row.error,
      scope: row.scope,
      requestedSource: row.requested_source,
      sources: (
        sourceQuery.all(row.id) as unknown as Array<{
          source: SourceId;
          state: Exclude<SourceState, "idle">;
          pages_scanned: number;
          observed_item_count: number;
          eligible_count: number;
          balanced_candidate_count: number;
          global_candidate_count: number;
          anomaly_state: string;
          published: number;
          stop_reason: string | null;
          error: string | null;
        }>
      ).map((source) => ({
        source: source.source,
        state: source.state,
        pagesScanned: source.pages_scanned,
        observedItemCount: source.observed_item_count,
        eligibleCount: source.eligible_count,
        balancedCandidateCount: source.balanced_candidate_count,
        globalCandidateCount: source.global_candidate_count,
        anomalyState: source.anomaly_state,
        published: source.published === 1,
        stopReason: source.stop_reason,
        error: source.error
      }))
    }));
  }

  getRefreshSnapshot(): {
    latestRun: ScanHistoryRun | null;
    lastSnapshotAt: string | null;
  } {
    const latestRun = this.getScanHistory(1)[0] ?? null;
    const published = this.database
      .prepare(`
        SELECT r.finished_at
        FROM scan_runs r
        WHERE r.is_baseline = 0
          AND r.state IN ('success', 'partial')
          AND r.finished_at IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM scan_source_results sr
            WHERE sr.run_id = r.id
              AND sr.published = 1
          )
        ORDER BY r.id DESC
        LIMIT 1
      `)
      .get() as { finished_at: string } | undefined;
    const fallback = this.database
      .prepare(`
        SELECT MAX(last_success_at) AS last_snapshot_at
        FROM source_status
      `)
      .get() as { last_snapshot_at: string | null };
    return {
      latestRun,
      lastSnapshotAt:
        published?.finished_at ?? fallback.last_snapshot_at
    };
  }

  getListingHistory(
    key: string,
    limit: number
  ): ListingHistoryView | null {
    const rows = this.database
      .prepare(`
        SELECT run_id, source, observed_at, availability,
               snapshot_json, changes_json
        FROM listing_observations
        WHERE listing_key = ?
          AND trusted = 1
          AND snapshot_json IS NOT NULL
        ORDER BY run_id DESC
        LIMIT ?
      `)
      .all(key, limit) as unknown as Array<{
      run_id: number;
      source: SourceId;
      observed_at: string;
      availability: "active" | "removed";
      snapshot_json: string;
      changes_json: string;
    }>;
    const current = this.getListing(key);
    if (!current && rows.length === 0) return null;

    const observations: ListingHistoryObservation[] = rows.map((row) => {
      const snapshot = normalizeListingHistorySnapshot(
        JSON.parse(row.snapshot_json)
      );
      return {
        runId: row.run_id,
        observedAt: row.observed_at,
        availability: row.availability,
        priceCny: snapshot.priceCny,
        snapshot,
        changes: JSON.parse(row.changes_json) as ListingFieldChange[]
      };
    });
    const source = current?.source ?? rows[0].source;
    const latest = observations[0];
    const availability: ListingHistoryView["availability"] = current
      ? "active"
      : latest?.availability === "removed"
        ? "removed"
        : "unknown";
    return {
      key,
      source,
      availability,
      lastSeenAt:
        observations.find(
          (observation) => observation.availability === "active"
        )?.observedAt ?? null,
      observations
    };
  }

  private pruneScanHistory(): void {
    this.database.exec(`
      DELETE FROM scan_runs
      WHERE is_baseline = 0
        AND id NOT IN (
          SELECT id
          FROM scan_runs
          WHERE is_baseline = 0
          ORDER BY id DESC
          LIMIT 50
        )
        AND id NOT IN (
          SELECT result.run_id
          FROM scan_source_results AS result
          WHERE result.published = 1
            AND result.stop_reason <> 'quick_window'
            AND result.run_id = (
              SELECT latest.run_id
              FROM scan_source_results AS latest
              WHERE latest.source = result.source
                AND latest.published = 1
                AND latest.stop_reason <> 'quick_window'
              ORDER BY latest.run_id DESC
              LIMIT 1
            )
        )
        AND id NOT IN (
          SELECT scan_run_id
          FROM panzhi_browser_jobs
          WHERE scan_run_id IS NOT NULL
        )
    `);
  }

  private runTransaction<T>(operation: () => T): T {
    const callerOwnsTransaction = this.database.isTransaction;
    const savepoint = callerOwnsTransaction
      ? `listing_repository_${this.savepointPrefix}_` +
        `${++this.savepointSequence}`
      : null;
    let started = false;
    try {
      this.database.exec(
        savepoint === null
          ? "BEGIN IMMEDIATE"
          : `SAVEPOINT ${savepoint}`
      );
      started = true;
      const result = operation();
      if (isThenable(result)) {
        throw new SynchronousTransactionError("operation");
      }
      this.database.exec(
        savepoint === null
          ? "COMMIT"
          : `RELEASE SAVEPOINT ${savepoint}`
      );
      started = false;
      return result;
    } catch (error) {
      if (started) {
        try {
          if (savepoint === null) {
            this.database.exec("ROLLBACK");
          } else {
            this.database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
            this.database.exec(`RELEASE SAVEPOINT ${savepoint}`);
          }
        } catch {
          // Preserve the original transaction failure.
        }
      }
      throw error;
    }
  }

  getListings(eligibility?: Eligibility): Listing[] {
    const rows = (
      eligibility
        ? this.database
            .prepare(
              "SELECT payload FROM listings WHERE eligibility = ? ORDER BY listing_key"
            )
            .all(eligibility)
        : this.database
            .prepare("SELECT payload FROM listings ORDER BY listing_key")
            .all()
    ) as unknown as ListingRow[];

    return rows.map(({ payload }) => parseStoredListing(payload));
  }

  getListing(key: string): Listing | null {
    const row = this.database
      .prepare("SELECT payload FROM listings WHERE listing_key = ?")
      .get(key) as unknown as ListingRow | undefined;
    return row ? parseStoredListing(row.payload) : null;
  }

  getReviewedListings(eligibility?: Eligibility): ReviewedListing[] {
    const latestReviews = this.getLatestManualReviewRows();
    const reviews = new Map(
      latestReviews.map((review) => [
        review.listing_key,
        review
      ])
    );
    const decorated = this.getListings(eligibility).map((listing) =>
      this.decorateListing(listing, reviews.get(listing.key))
    );
    const feedback =
      eligibility === undefined || eligibility === "eligible"
        ? decorated
        : this.getActiveFeedbackListings(latestReviews);
    return applyManualPreferenceFeedback(decorated, feedback);
  }

  getReviewedListing(key: string): ReviewedListing | null {
    const listing = this.getListing(key);
    if (listing === null) {
      return null;
    }
    const latestReviews = this.getLatestManualReviewRows();
    const reviews = new Map(
      latestReviews.map((review) => [review.listing_key, review])
    );
    const decorated = this.decorateListing(listing, reviews.get(key));
    return applyManualPreferenceFeedback(
      [decorated],
      this.getActiveFeedbackListings(latestReviews)
    )[0];
  }

  excludeListing(
    key: string,
    input: ManualExclusionInput,
    now = new Date()
  ): ReviewedListing {
    return this.runTransaction(() => {
      const listing = this.getListing(key);
      if (listing === null) {
        throw new ManualListingReviewError("listing_not_found");
      }
      if (listing.eligibility !== "eligible") {
        throw new ManualListingReviewError("listing_not_eligible");
      }

      const current = this.getLatestManualReviewRow(key);
      if (
        current?.action === "exclude" &&
        current.reason_code === input.reason &&
        current.note === input.note
      ) {
        return this.decorateListing(listing, current);
      }

      const createdAt = now.toISOString();
      this.database
        .prepare(`
          INSERT INTO manual_listing_reviews (
            listing_key, source, action, reason_code, note, created_at
          )
          VALUES (?, ?, 'exclude', ?, ?, ?)
        `)
        .run(
          listing.key,
          listing.source,
          input.reason,
          input.note,
          createdAt
        );

      return {
        ...listing,
        manualReview: {
          excluded: true,
          reason: input.reason,
          note: input.note,
          reviewedAt: createdAt
        }
      };
    });
  }

  restoreListing(key: string, now = new Date()): ReviewedListing {
    return this.runTransaction(() => {
      const listing = this.getListing(key);
      if (listing === null) {
        throw new ManualListingReviewError("listing_not_found");
      }

      const current = this.getLatestManualReviewRow(key);
      if (current?.action !== "exclude") {
        return {
          ...listing,
          manualReview: null
        };
      }

      this.database
        .prepare(`
          INSERT INTO manual_listing_reviews (
            listing_key, source, action, reason_code, note, created_at
          )
          VALUES (?, ?, 'restore', NULL, NULL, ?)
        `)
        .run(listing.key, listing.source, now.toISOString());

      return {
        ...listing,
        manualReview: null
      };
    });
  }

  private getLatestManualReviewRows(): ManualReviewRow[] {
    return this.database
      .prepare(`
        SELECT review.listing_key,
               review.action,
               review.reason_code,
               review.note,
               review.created_at
        FROM manual_listing_reviews AS review
        JOIN (
          SELECT listing_key, MAX(id) AS id
          FROM manual_listing_reviews
          GROUP BY listing_key
        ) AS latest ON latest.id = review.id
      `)
      .all() as unknown as ManualReviewRow[];
  }

  private getLatestManualReviewRow(
    key: string
  ): ManualReviewRow | undefined {
    return this.database
      .prepare(`
        SELECT listing_key, action, reason_code, note, created_at
        FROM manual_listing_reviews
        WHERE listing_key = ?
        ORDER BY id DESC
        LIMIT 1
      `)
      .get(key) as unknown as ManualReviewRow | undefined;
  }

  private getActiveFeedbackListings(
    latestReviews: readonly ManualReviewRow[]
  ): ReviewedListing[] {
    return latestReviews.flatMap((review) => {
      if (review.action !== "exclude") return [];
      const listing = this.getListing(review.listing_key);
      return listing === null
        ? []
        : [this.decorateListing(listing, review)];
    });
  }

  private decorateListing(
    listing: Listing,
    review: ManualReviewRow | undefined
  ): ReviewedListing {
    let manualReview: ManualListingReview | null = null;
    if (review?.action === "exclude") {
      manualReview = {
        excluded: true,
        reason: ManualReviewReasonSchema.parse(review.reason_code),
        note: review.note,
        reviewedAt: review.created_at
      };
    }
    return {
      ...listing,
      manualReview
    };
  }

  updateDerivedListings(listings: Listing[]): void {
    try {
      this.database.exec("BEGIN IMMEDIATE");
      const update = this.database.prepare(`
        UPDATE listings
        SET eligibility = ?, payload = ?
        WHERE listing_key = ?
      `);
      for (const listing of listings) {
        const parsed = ListingSchema.parse(listing);
        update.run(
          parsed.eligibility,
          JSON.stringify(parsed),
          parsed.key
        );
      }
      this.database.exec("COMMIT");
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original update error.
      }
      throw new Error("无法更新候选派生数据", { cause: error });
    }
  }

  recomputeDerivedListings(now = new Date()): void {
    try {
      this.database.exec("BEGIN IMMEDIATE");
      const rows = this.database
        .prepare("SELECT payload FROM listings ORDER BY listing_key")
        .all() as unknown as ListingRow[];
      const reparsed = rows.map(({ payload }) => {
        const listing = parseStoredListing(payload);
        const parsedM7 = parseM7(listing.m7Evidence);
        const m7PrismStatus = parsedM7.status;
        const m7PrismQuality = parsedM7.quality ?? null;
        const requiredRedSkins = parseRequiredRedSkins(listing.evidence);
        const rederived = {
          ...listing,
          m7PrismStatus,
          m7PrismQuality,
          requiredRedSkins: requiredRedSkins.names,
          requiredRedSkinStatus: requiredRedSkins.status,
          eligibility: classifyListing({
            loginPlatform: listing.loginPlatform,
            service: listing.service,
            priceCny: listing.priceCny,
            requiredRedSkinStatus: requiredRedSkins.status,
            secondRealNameAvailable: listing.secondRealNameAvailable
          }),
          score: null,
          possibleDuplicateKeys: []
        };
        return {
          ...rederived,
          confidence: calculateConfidence(rederived)
        };
      });
      const marked = markPossibleDuplicates(reparsed);
      const scored = scoreEligibleListings(marked, now);
      const scores = new Map(
        scored.map((listing) => [listing.key, listing.score])
      );
      const update = this.database.prepare(`
        UPDATE listings
        SET eligibility = ?, payload = ?
        WHERE listing_key = ?
      `);
      for (const listing of marked) {
        const parsed = ListingSchema.parse({
          ...listing,
          score: scores.get(listing.key) ?? null
        });
        update.run(
          parsed.eligibility,
          JSON.stringify(parsed),
          parsed.key
        );
      }
      this.database.exec("COMMIT");
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original rederivation error.
      }
      throw new Error("无法重算候选派生数据", { cause: error });
    }
  }

  getSourceStatuses(now = new Date()): SourceStatus[] {
    const rows = this.database
      .prepare(`
        SELECT s.*,
               g.state AS anomaly_state,
               g.baseline_item_count,
               g.baseline_pages_scanned,
               g.observed_item_count,
               g.observed_pages_scanned,
               g.confirmation_count,
               g.first_detected_at,
               g.last_detected_at,
               g.reason AS anomaly_reason,
               (
                 SELECT sr.observed_item_count
                 FROM scan_source_results sr
                 JOIN scan_runs r ON r.id = sr.run_id
                 WHERE sr.source = s.source
                   AND r.is_baseline = 0
                 ORDER BY sr.run_id DESC
                 LIMIT 1
               ) AS latest_observed_item_count,
               (
                 SELECT sr.published
                 FROM scan_source_results sr
                 JOIN scan_runs r ON r.id = sr.run_id
                 WHERE sr.source = s.source
                   AND r.is_baseline = 0
                 ORDER BY sr.run_id DESC
                 LIMIT 1
               ) AS latest_published
        FROM source_status s
        JOIN source_anomaly_guards g ON g.source = s.source
        ORDER BY s.source
      `)
      .all() as unknown as SourceStatusRow[];

    return rows.map((row) => {
      const anomaly: SourceAnomalyStatus =
        row.anomaly_state === "suspect" &&
        row.baseline_item_count !== null &&
        row.baseline_pages_scanned !== null &&
        row.observed_item_count !== null &&
        row.observed_pages_scanned !== null &&
        row.first_detected_at !== null &&
        row.last_detected_at !== null &&
        row.anomaly_reason !== null
          ? {
              state: "suspect",
              baselineItemCount: row.baseline_item_count,
              baselinePagesScanned: row.baseline_pages_scanned,
              observedItemCount: row.observed_item_count,
              observedPagesScanned: row.observed_pages_scanned,
              confirmationCount: row.confirmation_count,
              firstDetectedAt: row.first_detected_at,
              lastDetectedAt: row.last_detected_at,
              reason: row.anomaly_reason
            }
          : { state: "clear" };
      return {
        source: row.source,
        state: row.state,
        lastAttemptAt: row.last_attempt_at,
        lastSuccessAt: row.last_success_at,
        itemCount: row.item_count,
        pagesScanned: row.pages_scanned,
        observedItemCount:
          row.latest_observed_item_count ?? row.item_count,
        latestPublished: row.latest_published === null
          ? row.last_success_at !== null
          : row.latest_published === 1,
        stopReason: row.stop_reason,
        error: row.error,
        anomaly,
        stale:
          row.last_success_at !== null &&
          now.getTime() - Date.parse(row.last_success_at) > STALE_AFTER_MS
      };
    });
  }
}
