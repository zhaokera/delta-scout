import type { DatabaseSync } from "node:sqlite";
import {
  selectBalancedCandidatePool,
  selectGlobalCandidatePool
} from "../domain/candidatePool.js";
import { listingMaterialHash } from "../domain/listingFingerprint.js";
import {
  type Eligibility,
  type Listing,
  type SourceId
} from "../domain/listing.js";
import { ListingSchema } from "../domain/listing.js";
import { parseStoredListing } from "./storedListing.js";

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
  stopReason: string | null;
  error: string | null;
  stale: boolean;
}

interface ListingRow {
  payload: string;
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
}

export interface ScanMetadata {
  pagesScanned: number;
  stopReason: string | null;
  error?: string | null;
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
}

export interface ScanHistoryRun {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  state: "running" | ScanState;
  error: string | null;
  sources: ScanHistorySource[];
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
  constructor(private readonly database: DatabaseSync) {}

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

  commitScanRefresh(
    runId: number,
    listings: Listing[],
    statusUpdates: SourceRefreshStatusUpdate[],
    finishedAt = new Date()
  ): ScanState {
    const freshUpdates = statusUpdates.filter(
      (
        update
      ): update is Extract<
        SourceRefreshStatusUpdate,
        { state: "success" | "partial" }
      > => "metadata" in update
    );
    const roundState: ScanState =
      freshUpdates.length === 0
        ? "failed"
        : statusUpdates.every(({ state }) => state === "success")
          ? "success"
          : "partial";
    const successfulSources = new Set(
      freshUpdates
        .filter(({ state }) => state === "success")
        .map(({ source }) => source)
    );
    const partialSources = new Set(
      freshUpdates
        .filter(({ state }) => state === "partial")
        .map(({ source }) => source)
    );
    const derivedListings = listings.map((listing) => {
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
          WHERE run_id = ? AND listing_key = ?
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

    try {
      this.database.exec("BEGIN IMMEDIATE");
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
          stop_reason, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertObservation = this.database.prepare(`
        INSERT INTO listing_observations (
          run_id, listing_key, source, observed_at, eligibility,
          material_hash, stability, consecutive_unchanged_scans
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
          const sourceListings = derivedListings.filter(
            ({ source }) => source === update.source
          );
          insertResult.run(
            runId,
            update.source,
            update.state,
            update.metadata.pagesScanned,
            update.itemCount,
            sourceListings.filter(
              ({ eligibility }) => eligibility === "eligible"
            ).length,
            balancedCounts.get(update.source) ?? 0,
            globalCounts.get(update.source) ?? 0,
            update.metadata.stopReason,
            update.metadata.error ?? null
          );
          for (const listing of sourceListings) {
            insertObservation.run(
              runId,
              listing.key,
              listing.source,
              timestamp,
              listing.eligibility,
              listingMaterialHash(listing),
              listing.scanStability,
              listing.consecutiveUnchangedScans
            );
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
            "error",
            update.error
          );
        }
      }

      this.database
        .prepare(`
          UPDATE scan_runs
          SET state = ?, finished_at = ?, error = NULL
          WHERE id = ? AND is_baseline = 0
        `)
        .run(roundState, finishedAt.toISOString(), runId);
      this.pruneScanHistory();
      this.database.exec("COMMIT");
      return roundState;
    } catch (cause) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original failure.
      }
      throw new Error("无法提交带历史的刷新快照", { cause });
    }
  }

  getScanHistory(limit: number): ScanHistoryRun[] {
    const rows = this.database
      .prepare(`
        SELECT id, started_at, finished_at, state, error
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
      }>;
    const sourceQuery = this.database.prepare(`
      SELECT source, state, pages_scanned, observed_item_count,
             eligible_count, balanced_candidate_count,
             global_candidate_count, stop_reason, error
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
      sources: (
        sourceQuery.all(row.id) as unknown as Array<{
          source: SourceId;
          state: Exclude<SourceState, "idle">;
          pages_scanned: number;
          observed_item_count: number;
          eligible_count: number;
          balanced_candidate_count: number;
          global_candidate_count: number;
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
        SELECT finished_at
        FROM scan_runs
        WHERE is_baseline = 0
          AND state IN ('success', 'partial')
          AND finished_at IS NOT NULL
        ORDER BY id DESC
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
    `);
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

  getSourceStatuses(now = new Date()): SourceStatus[] {
    const rows = this.database
      .prepare("SELECT * FROM source_status ORDER BY source")
      .all() as unknown as SourceStatusRow[];

    return rows.map((row) => ({
      source: row.source,
      state: row.state,
      lastAttemptAt: row.last_attempt_at,
      lastSuccessAt: row.last_success_at,
      itemCount: row.item_count,
      pagesScanned: row.pages_scanned,
      stopReason: row.stop_reason,
      error: row.error,
      stale:
        row.last_success_at !== null &&
        now.getTime() - Date.parse(row.last_success_at) > STALE_AFTER_MS
    }));
  }
}
