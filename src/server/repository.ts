import type { DatabaseSync } from "node:sqlite";
import {
  ListingSchema,
  type Eligibility,
  type Listing,
  type SourceId
} from "../domain/listing.js";

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

    return rows.map(({ payload }) => ListingSchema.parse(JSON.parse(payload)));
  }

  getListing(key: string): Listing | null {
    const row = this.database
      .prepare("SELECT payload FROM listings WHERE listing_key = ?")
      .get(key) as unknown as ListingRow | undefined;
    return row ? ListingSchema.parse(JSON.parse(row.payload)) : null;
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
