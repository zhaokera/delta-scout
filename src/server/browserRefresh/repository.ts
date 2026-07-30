import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual
} from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  BROWSER_REFRESH_LIMITS,
  BrowserDetailBatchSchema,
  BrowserFilterProofSchema,
  BrowserListBatchSchema,
  BrowserLoadEventSchema,
  BrowserRefreshJobStateSchema,
  type BrowserDetailBatch,
  type BrowserFilterProof,
  type BrowserListBatch,
  type BrowserLoadEvent,
  type BrowserRefreshJobState
} from "./contracts.js";

const JOB_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const TERMINAL_AUDIT_RETENTION_MS = 24 * 60 * 60 * 1_000;
const TERMINAL_STATES: readonly BrowserRefreshJobState[] = [
  "success",
  "quarantined",
  "failed",
  "cancelled",
  "expired"
];

export type BrowserRefreshRepositoryErrorCode =
  | "active_job_exists"
  | "job_not_found"
  | "job_terminal"
  | "invalid_claim_code"
  | "invalid_bridge_token"
  | "invalid_transition"
  | "batch_conflict"
  | "sequence_conflict"
  | "missing_list_item"
  | "invalid_load_event"
  | "invalid_action_permit"
  | "invalid_terminal_linkage"
  | "browser_refresh_corrupt_replay";

export class BrowserRefreshRepositoryError extends Error {
  constructor(
    readonly code: BrowserRefreshRepositoryErrorCode,
    message: string
  ) {
    super(message);
    this.name = "BrowserRefreshRepositoryError";
  }
}

export interface BrowserRefreshJobView {
  id: string;
  source: "jiaoyimao";
  state: BrowserRefreshJobState;
  stage: string;
  reason: string | null;
  claimedAt: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  expiresAt: string;
  listBatchCursor: number;
  detailCompletedCount: number;
  detailRequiredCount: number;
  uniqueItemCount: number;
  itemCount: number;
  loadActionCount: number;
  cooldownAttempt: number;
  cooldownUntil: string | null;
  nextActionAt: string | null;
  actionPermitExpiresAt: string | null;
  actionPermitConsumedAt: string | null;
  filterUrl: string | null;
  lastError: string | null;
  scanRunId: number | null;
  publishedRunId: number | null;
}

interface BrowserRefreshJobRecord extends BrowserRefreshJobView {
  claimCodeHash: string | null;
  bridgeTokenHash: string | null;
  actionPermitHash: string | null;
}

export interface CreatedBrowserRefreshJob extends BrowserRefreshJobView {
  claimCode: string;
}

export interface ClaimedBrowserRefreshJob extends BrowserRefreshJobView {
  bridgeToken: string;
}

export interface AcceptedBatchView {
  acceptedCount: number;
  uniqueItemCount: number;
  nextSequence: number;
}

export interface AcceptedLoadEventView {
  acceptedCount: number;
  loadActionCount: number;
  nextSequence: number;
}

export interface DetailProgressView {
  acceptedCount: number;
  detailCompletedCount: number;
  detailRequiredCount: number;
  nextSourceListingId: string | null;
  nextSequence: number;
}

const AcceptedBatchViewSchema = z.strictObject({
  acceptedCount: z.number().int().nonnegative()
    .max(BROWSER_REFRESH_LIMITS.maxListItemsPerBatch),
  uniqueItemCount: z.number().int().nonnegative()
    .max(BROWSER_REFRESH_LIMITS.maxUniqueItems),
  nextSequence: z.number().int().positive()
});

const AcceptedLoadEventViewSchema = z.strictObject({
  acceptedCount: z.literal(1),
  loadActionCount: z.number().int().nonnegative()
    .max(BROWSER_REFRESH_LIMITS.maxLoadEvents),
  nextSequence: z.number().int().positive()
});

const DetailProgressViewSchema = z.strictObject({
  acceptedCount: z.number().int().nonnegative()
    .max(BROWSER_REFRESH_LIMITS.maxDetailsPerBatch),
  detailCompletedCount: z.number().int().nonnegative()
    .max(BROWSER_REFRESH_LIMITS.maxUniqueItems),
  detailRequiredCount: z.number().int().nonnegative()
    .max(BROWSER_REFRESH_LIMITS.maxUniqueItems),
  nextSourceListingId: z.string().regex(/^\d+$/).nullable(),
  nextSequence: z.number().int().positive()
});

export interface BrowserRefreshTransitionPatch {
  stage?: string;
  reason?: string | null;
  detailRequiredCount?: number;
  detailCompletedCount?: number;
  uniqueItemCount?: number;
  itemCount?: number;
  listBatchCursor?: number;
  loadActionCount?: number;
  cooldownAttempt?: number;
  cooldownUntil?: string | null;
  nextActionAt?: string | null;
  actionPermit?: string | null;
  actionPermitExpiresAt?: string | null;
  filterUrl?: string | null;
  lastError?: string | null;
  scanRunId?: number | null;
  publishedRunId?: number | null;
}

interface JobRow {
  id: string;
  source: "jiaoyimao";
  state: BrowserRefreshJobState;
  stage: string;
  reason: string | null;
  claim_code_hash: string | null;
  bridge_token_hash: string | null;
  claimed_at: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  expires_at: string;
  list_batch_cursor: number;
  detail_completed_count: number;
  detail_required_count: number;
  unique_item_count: number;
  item_count: number;
  load_action_count: number;
  cooldown_attempt: number;
  cooldown_until: string | null;
  next_action_at: string | null;
  action_permit_hash: string | null;
  action_permit_expires_at: string | null;
  action_permit_consumed_at: string | null;
  filter_url: string | null;
  last_error: string | null;
  scan_run_id: number | null;
  published_run_id: number | null;
}

function isTerminal(state: BrowserRefreshJobState): boolean {
  return TERMINAL_STATES.includes(state);
}

function opaqueCredential(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

function encodeCredential(value: string): string {
  const salt = randomBytes(16);
  const digest = scryptSync(value, salt, 32);
  return `scrypt$${salt.toString("base64url")}$${digest.toString(
    "base64url"
  )}`;
}

function credentialMatches(value: string, encoded: string): boolean {
  const [algorithm, saltText, digestText, extra] = encoded.split("$");
  if (
    algorithm !== "scrypt" ||
    !saltText ||
    !digestText ||
    extra !== undefined
  ) {
    return false;
  }
  try {
    const salt = Buffer.from(saltText, "base64url");
    const expected = Buffer.from(digestText, "base64url");
    const actual = scryptSync(value, salt, expected.length);
    return (
      actual.length === expected.length &&
      timingSafeEqual(actual, expected)
    );
  } catch {
    return false;
  }
}

function payloadHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function toRecord(row: JobRow): BrowserRefreshJobRecord {
  return {
    id: row.id,
    source: row.source,
    state: row.state,
    stage: row.stage,
    reason: row.reason,
    claimCodeHash: row.claim_code_hash,
    bridgeTokenHash: row.bridge_token_hash,
    claimedAt: row.claimed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
    expiresAt: row.expires_at,
    listBatchCursor: row.list_batch_cursor,
    detailCompletedCount: row.detail_completed_count,
    detailRequiredCount: row.detail_required_count,
    uniqueItemCount: row.unique_item_count,
    itemCount: row.item_count,
    loadActionCount: row.load_action_count,
    cooldownAttempt: row.cooldown_attempt,
    cooldownUntil: row.cooldown_until,
    nextActionAt: row.next_action_at,
    actionPermitHash: row.action_permit_hash,
    actionPermitExpiresAt: row.action_permit_expires_at,
    actionPermitConsumedAt: row.action_permit_consumed_at,
    filterUrl: row.filter_url,
    lastError: row.last_error,
    scanRunId: row.scan_run_id,
    publishedRunId: row.published_run_id
  };
}

function toView(row: JobRow): BrowserRefreshJobView {
  const {
    claimCodeHash: _claimCodeHash,
    bridgeTokenHash: _bridgeTokenHash,
    actionPermitHash: _actionPermitHash,
    ...view
  } = toRecord(row);
  return view;
}

function parseStoredResult<T>(
  json: string,
  schema: z.ZodType<T>
): T {
  try {
    return schema.parse(JSON.parse(json));
  } catch {
    throw new BrowserRefreshRepositoryError(
      "browser_refresh_corrupt_replay",
      "Stored browser refresh replay result is corrupt"
    );
  }
}

function canonicalIsoTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

export class BrowserRefreshRepository {
  private readonly savepointPrefix =
    randomBytes(8).toString("hex");
  private savepointSequence = 0;

  constructor(private readonly database: DatabaseSync) {}

  createJob(now = new Date()): CreatedBrowserRefreshJob {
    this.expireJobs(now);
    const timestamp = now.toISOString();
    const id = randomUUID();
    const claimCode = opaqueCredential(12);
    const expiresAt = new Date(
      now.getTime() + JOB_LIFETIME_MS
    ).toISOString();
    try {
      this.runTransaction(() => {
        const active = this.database.prepare(`
          SELECT id FROM browser_refresh_jobs
          WHERE source = 'jiaoyimao'
            AND state NOT IN (
              'success', 'quarantined', 'failed', 'cancelled', 'expired'
            )
          LIMIT 1
        `).get();
        if (active) {
          throw new BrowserRefreshRepositoryError(
            "active_job_exists",
            "A browser refresh job is already active"
          );
        }
        this.database.prepare(`
          INSERT INTO browser_refresh_jobs (
            id, source, state, stage, claim_code_hash,
            created_at, updated_at, expires_at
          ) VALUES (?, 'jiaoyimao', 'awaiting_codex', 'awaiting_claim',
            ?, ?, ?, ?)
        `).run(
          id,
          encodeCredential(claimCode),
          timestamp,
          timestamp,
          expiresAt
        );
      });
    } catch (error) {
      if (error instanceof BrowserRefreshRepositoryError) throw error;
      if (
        error instanceof Error &&
        /browser_refresh_one_active_jiaoyimao/.test(error.message)
      ) {
        throw new BrowserRefreshRepositoryError(
          "active_job_exists",
          "A browser refresh job is already active"
        );
      }
      throw error;
    }
    const row = this.requireRow(id);
    return { ...toView(row), claimCode };
  }

  getCurrentJob(now = new Date()): BrowserRefreshJobView | null {
    this.expireJobs(now);
    const row = this.database.prepare(`
      SELECT * FROM browser_refresh_jobs
      WHERE source = 'jiaoyimao'
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `).get() as unknown as JobRow | undefined;
    return row ? toView(row) : null;
  }

  getJob(
    id: string,
    now = new Date()
  ): BrowserRefreshJobView | null {
    this.expireJobs(now);
    const row = this.findRow(id);
    return row ? toView(row) : null;
  }

  getJobRecord(
    id: string,
    now = new Date()
  ): BrowserRefreshJobView | null {
    this.expireJobs(now);
    const row = this.findRow(id);
    return row ? toView(row) : null;
  }

  claimJob(
    id: string,
    claimCode: string,
    now = new Date()
  ): ClaimedBrowserRefreshJob {
    this.expireJobs(now);
    const timestamp = now.toISOString();
    const bridgeToken = opaqueCredential();
    this.runTransaction(() => {
      const row = this.requireRow(id);
      if (
        row.state !== "awaiting_codex" ||
        row.claim_code_hash === null ||
        !credentialMatches(claimCode, row.claim_code_hash)
      ) {
        throw new BrowserRefreshRepositoryError(
          "invalid_claim_code",
          "The claim code is invalid or has already been consumed"
        );
      }
      this.database.prepare(`
        UPDATE browser_refresh_jobs
        SET state = 'collecting_list',
            stage = 'collecting_list',
            claim_code_hash = NULL,
            bridge_token_hash = ?,
            claimed_at = ?,
            updated_at = ?
        WHERE id = ?
      `).run(
        encodeCredential(bridgeToken),
        timestamp,
        timestamp,
        id
      );
    });
    return { ...toView(this.requireRow(id)), bridgeToken };
  }

  verifyBridgeToken(
    id: string,
    token: string,
    now = new Date()
  ): BrowserRefreshJobView {
    this.expireJobs(now);
    const row = this.requireRow(id);
    if (
      isTerminal(row.state) ||
      row.bridge_token_hash === null ||
      !credentialMatches(token, row.bridge_token_hash)
    ) {
      throw new BrowserRefreshRepositoryError(
        "invalid_bridge_token",
        "The bridge credential is invalid or the job is terminal"
      );
    }
    return toView(row);
  }

  saveFilterProof(
    id: string,
    proof: BrowserFilterProof,
    now = new Date()
  ): void {
    this.expireJobs(now);
    const parsed = BrowserFilterProofSchema.parse(proof);
    this.runTransaction(() => {
      this.requireActiveRow(id);
      this.database.prepare(`
        INSERT INTO browser_refresh_filter_proofs (
          job_id, current_url, game_label, platform_label,
          category_label, m7_filter_labels_json, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_id) DO UPDATE SET
          current_url = excluded.current_url,
          game_label = excluded.game_label,
          platform_label = excluded.platform_label,
          category_label = excluded.category_label,
          m7_filter_labels_json = excluded.m7_filter_labels_json,
          observed_at = excluded.observed_at
      `).run(
        id,
        parsed.currentUrl,
        parsed.gameLabel,
        parsed.platformLabel,
        parsed.categoryLabel,
        JSON.stringify(parsed.m7FilterLabels),
        parsed.observedAt
      );
      this.database.prepare(`
        UPDATE browser_refresh_jobs
        SET filter_url = ?, updated_at = ?
        WHERE id = ?
      `).run(parsed.currentUrl, now.toISOString(), id);
    });
  }

  acceptListBatch(
    id: string,
    batch: BrowserListBatch,
    now = new Date()
  ): AcceptedBatchView {
    this.expireJobs(now);
    const parsed = BrowserListBatchSchema.parse(batch);
    const hash = payloadHash(parsed);
    return this.runTransaction(() => {
      const job = this.requireActiveRow(id);
      const replay = this.findBatch(id, "list", parsed.sequence);
      if (replay) {
        if (replay.payload_hash !== hash) {
          throw new BrowserRefreshRepositoryError(
            "batch_conflict",
            "List batch sequence was already used with a different hash"
          );
        }
        return parseStoredResult<AcceptedBatchView>(
          replay.accepted_result_json,
          AcceptedBatchViewSchema
        );
      }
      if (parsed.sequence !== job.list_batch_cursor + 1) {
        throw new BrowserRefreshRepositoryError(
          "sequence_conflict",
          `Expected list batch sequence ${job.list_batch_cursor + 1}`
        );
      }
      const insertItem = this.database.prepare(`
        INSERT INTO browser_refresh_list_items (
          job_id, source_listing_id, url, title, raw_text,
          price_cny, last_batch_sequence, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_id, source_listing_id) DO UPDATE SET
          url = excluded.url,
          title = excluded.title,
          raw_text = excluded.raw_text,
          price_cny = excluded.price_cny,
          last_batch_sequence = excluded.last_batch_sequence,
          observed_at = excluded.observed_at
        WHERE excluded.last_batch_sequence >=
          browser_refresh_list_items.last_batch_sequence
      `);
      for (const item of parsed.items) {
        insertItem.run(
          id,
          item.sourceListingId,
          item.url,
          item.title,
          item.rawText,
          item.priceCny,
          parsed.sequence,
          parsed.observedAt
        );
      }
      const count = this.database.prepare(`
        SELECT COUNT(*) AS count
        FROM browser_refresh_list_items WHERE job_id = ?
      `).get(id) as { count: number };
      if (count.count > BROWSER_REFRESH_LIMITS.maxUniqueItems) {
        throw new BrowserRefreshRepositoryError(
          "invalid_load_event",
          "Unique item safety limit exceeded"
        );
      }
      const result: AcceptedBatchView = {
        acceptedCount: parsed.items.length,
        uniqueItemCount: count.count,
        nextSequence: parsed.sequence + 1
      };
      this.insertBatch(
        id,
        "list",
        parsed.sequence,
        hash,
        parsed.items.length,
        result,
        now
      );
      this.database.prepare(`
        UPDATE browser_refresh_jobs
        SET list_batch_cursor = ?,
            unique_item_count = ?,
            item_count = ?,
            updated_at = ?
        WHERE id = ?
      `).run(
        parsed.sequence,
        count.count,
        count.count,
        now.toISOString(),
        id
      );
      return result;
    });
  }

  acceptLoadEvent(
    id: string,
    event: BrowserLoadEvent,
    now = new Date()
  ): AcceptedLoadEventView {
    this.expireJobs(now);
    const parsed = BrowserLoadEventSchema.parse(event);
    const hash = payloadHash(parsed);
    return this.runTransaction(() => {
      const job = this.requireActiveRow(id);
      const existing = this.database.prepare(`
        SELECT payload_hash, accepted_result_json
        FROM browser_refresh_load_events
        WHERE job_id = ? AND sequence = ?
      `).get(id, parsed.sequence) as
        | {
            payload_hash: string;
            accepted_result_json: string | null;
          }
        | undefined;
      if (existing) {
        if (existing.payload_hash !== hash) {
          throw new BrowserRefreshRepositoryError(
            "batch_conflict",
            "Load event sequence was already used with a different hash"
          );
        }
        const result = existing.accepted_result_json === null
          ? {
              acceptedCount: 1,
              loadActionCount: parsed.sequence,
              nextSequence: parsed.sequence + 1
            }
          : parseStoredResult<AcceptedLoadEventView>(
              existing.accepted_result_json,
              AcceptedLoadEventViewSchema
            );
        return result;
      }
      const previous = this.database.prepare(`
        SELECT sequence, observed_unique_count
        FROM browser_refresh_load_events
        WHERE job_id = ?
        ORDER BY sequence DESC
        LIMIT 1
      `).get(id) as
        | { sequence: number; observed_unique_count: number }
        | undefined;
      const expectedSequence = (previous?.sequence ?? 0) + 1;
      if (parsed.sequence !== expectedSequence) {
        throw new BrowserRefreshRepositoryError(
          "sequence_conflict",
          `Expected load event sequence ${expectedSequence}`
        );
      }
      if (
        parsed.observedUniqueCount <
          (previous?.observed_unique_count ?? 0) ||
        parsed.newItemCount >
          parsed.observedUniqueCount -
            (previous?.observed_unique_count ?? 0) ||
        parsed.observedUniqueCount > job.unique_item_count ||
        (parsed.visibleTotalCount !== null &&
          parsed.visibleTotalCount < parsed.observedUniqueCount)
      ) {
        throw new BrowserRefreshRepositoryError(
          "invalid_load_event",
          "Load event unique counts are not monotonic or consistent"
        );
      }
      if (job.load_action_count >= BROWSER_REFRESH_LIMITS.maxLoadEvents) {
        throw new BrowserRefreshRepositoryError(
          "invalid_load_event",
          "Load event safety limit exceeded"
        );
      }
      this.consumeActionPermit(job, parsed.actionPermit, now);
      const loadActionCount = job.load_action_count + 1;
      const result: AcceptedLoadEventView = {
        acceptedCount: 1,
        loadActionCount,
        nextSequence: parsed.sequence + 1
      };
      this.database.prepare(`
        INSERT INTO browser_refresh_load_events (
          job_id, sequence, payload_hash, accepted_result_json,
          observed_unique_count, new_item_count, visible_total_count,
          end_marker_visible, loading_visible, blocking_state, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        parsed.sequence,
        hash,
        JSON.stringify(result),
        parsed.observedUniqueCount,
        parsed.newItemCount,
        parsed.visibleTotalCount,
        parsed.endMarkerVisible ? 1 : 0,
        parsed.loadingVisible ? 1 : 0,
        parsed.blockingState,
        parsed.observedAt
      );
      this.database.prepare(`
        UPDATE browser_refresh_jobs
        SET load_action_count = ?, updated_at = ?
        WHERE id = ?
      `).run(loadActionCount, now.toISOString(), id);
      return result;
    });
  }

  acceptDetailBatch(
    id: string,
    batch: BrowserDetailBatch,
    now = new Date()
  ): DetailProgressView {
    this.expireJobs(now);
    const parsed = BrowserDetailBatchSchema.parse(batch);
    const hash = payloadHash(parsed);
    return this.runTransaction(() => {
      const job = this.requireActiveRow(id);
      const replay = this.findBatch(id, "detail", parsed.sequence);
      if (replay) {
        if (replay.payload_hash !== hash) {
          throw new BrowserRefreshRepositoryError(
            "batch_conflict",
            "Detail batch sequence was already used with a different hash"
          );
        }
        return parseStoredResult<DetailProgressView>(
          replay.accepted_result_json,
          DetailProgressViewSchema
        );
      }
      const sequence = this.database.prepare(`
        SELECT COALESCE(MAX(sequence), 0) AS sequence
        FROM browser_refresh_batches
        WHERE job_id = ? AND kind = 'detail'
      `).get(id) as { sequence: number };
      if (parsed.sequence !== sequence.sequence + 1) {
        throw new BrowserRefreshRepositoryError(
          "sequence_conflict",
          `Expected detail batch sequence ${sequence.sequence + 1}`
        );
      }
      for (const item of parsed.items) {
        const staged = this.database.prepare(`
          SELECT 1 FROM browser_refresh_list_items
          WHERE job_id = ? AND source_listing_id = ?
        `).get(id, item.sourceListingId);
        if (!staged) {
          throw new BrowserRefreshRepositoryError(
            "missing_list_item",
            `Detail ${item.sourceListingId} has no staged list item`
          );
        }
      }
      this.consumeActionPermit(job, parsed.actionPermit, now);
      const insert = this.database.prepare(`
        INSERT INTO browser_refresh_details (
          job_id, source_listing_id, url, evidence_json, observed_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(job_id, source_listing_id) DO UPDATE SET
          url = excluded.url,
          evidence_json = excluded.evidence_json,
          observed_at = excluded.observed_at
      `);
      for (const item of parsed.items) {
        insert.run(
          id,
          item.sourceListingId,
          item.url,
          JSON.stringify(item.sections),
          item.observedAt
        );
      }
      const completed = this.database.prepare(`
        SELECT COUNT(*) AS count
        FROM browser_refresh_details WHERE job_id = ?
      `).get(id) as { count: number };
      const next = this.database.prepare(`
        SELECT li.source_listing_id
        FROM browser_refresh_list_items li
        LEFT JOIN browser_refresh_details d
          ON d.job_id = li.job_id
          AND d.source_listing_id = li.source_listing_id
        WHERE li.job_id = ? AND d.source_listing_id IS NULL
        ORDER BY li.last_batch_sequence, li.source_listing_id
        LIMIT 1
      `).get(id) as { source_listing_id: string } | undefined;
      const result: DetailProgressView = {
        acceptedCount: parsed.items.length,
        detailCompletedCount: completed.count,
        detailRequiredCount: job.detail_required_count,
        nextSourceListingId: next?.source_listing_id ?? null,
        nextSequence: parsed.sequence + 1
      };
      this.insertBatch(
        id,
        "detail",
        parsed.sequence,
        hash,
        parsed.items.length,
        result,
        now
      );
      this.database.prepare(`
        UPDATE browser_refresh_jobs
        SET detail_completed_count = ?, updated_at = ?
        WHERE id = ?
      `).run(completed.count, now.toISOString(), id);
      return result;
    });
  }

  transition(
    id: string,
    expected: readonly BrowserRefreshJobState[],
    next: BrowserRefreshJobState,
    patch: BrowserRefreshTransitionPatch,
    now = new Date()
  ): BrowserRefreshJobView {
    this.expireJobs(now);
    BrowserRefreshJobStateSchema.parse(next);
    if (expected.length === 0) {
      throw new BrowserRefreshRepositoryError(
        "invalid_transition",
        "At least one expected state is required"
      );
    }
    if (
      patch.actionPermitExpiresAt !== undefined &&
      patch.actionPermitExpiresAt !== null &&
      !canonicalIsoTimestamp(patch.actionPermitExpiresAt)
    ) {
      throw new BrowserRefreshRepositoryError(
        "invalid_transition",
        "Action permit expiry must be a canonical UTC timestamp"
      );
    }
    const timestamp = now.toISOString();
    return this.runTransaction(() => {
      const row = this.requireRow(id);
      if (!expected.includes(row.state)) {
        throw new BrowserRefreshRepositoryError(
          "invalid_transition",
          `Cannot transition from ${row.state} to ${next}`
        );
      }
      if (isTerminal(row.state)) {
        throw new BrowserRefreshRepositoryError(
          "job_terminal",
          "Terminal browser refresh jobs cannot transition"
        );
      }
      const values = {
        stage: patch.stage ?? next,
        reason:
          patch.reason === undefined ? row.reason : patch.reason,
        detailRequiredCount:
          patch.detailRequiredCount ?? row.detail_required_count,
        detailCompletedCount:
          patch.detailCompletedCount ?? row.detail_completed_count,
        uniqueItemCount:
          patch.uniqueItemCount ?? row.unique_item_count,
        itemCount: patch.itemCount ?? row.item_count,
        listBatchCursor:
          patch.listBatchCursor ?? row.list_batch_cursor,
        loadActionCount:
          patch.loadActionCount ?? row.load_action_count,
        cooldownAttempt:
          patch.cooldownAttempt ?? row.cooldown_attempt,
        cooldownUntil:
          patch.cooldownUntil === undefined
            ? row.cooldown_until
            : patch.cooldownUntil,
        nextActionAt:
          patch.nextActionAt === undefined
            ? row.next_action_at
            : patch.nextActionAt,
        actionPermitHash:
          patch.actionPermit === undefined
            ? row.action_permit_hash
            : patch.actionPermit === null
              ? null
              : encodeCredential(patch.actionPermit),
        actionPermitExpiresAt:
          patch.actionPermitExpiresAt === undefined
            ? row.action_permit_expires_at
            : patch.actionPermitExpiresAt,
        filterUrl:
          patch.filterUrl === undefined
            ? row.filter_url
            : patch.filterUrl,
        lastError:
          patch.lastError === undefined
            ? row.last_error
            : patch.lastError,
        scanRunId:
          patch.scanRunId === undefined
            ? row.scan_run_id
            : patch.scanRunId,
        publishedRunId:
          patch.publishedRunId === undefined
            ? row.published_run_id
            : patch.publishedRunId
      };
      for (const count of [
        values.detailRequiredCount,
        values.detailCompletedCount,
        values.uniqueItemCount,
        values.itemCount,
        values.listBatchCursor,
        values.loadActionCount,
        values.cooldownAttempt
      ]) {
        if (!Number.isSafeInteger(count) || count < 0) {
          throw new BrowserRefreshRepositoryError(
            "invalid_transition",
            "Transition counters must be non-negative integers"
          );
        }
      }
      if (
        next === "success" &&
        (
          values.scanRunId === null ||
          values.publishedRunId !== values.scanRunId
        )
      ) {
        throw new BrowserRefreshRepositoryError(
          "invalid_terminal_linkage",
          "A successful job requires matching scan and published run links"
        );
      }
      if (
        next === "quarantined" &&
        (
          values.scanRunId === null ||
          values.publishedRunId !== null
        )
      ) {
        throw new BrowserRefreshRepositoryError(
          "invalid_terminal_linkage",
          "A quarantined job requires a scan link and no published run"
        );
      }
      if (
        next !== "success" &&
        values.publishedRunId !== null
      ) {
        throw new BrowserRefreshRepositoryError(
          "invalid_terminal_linkage",
          "Only a successful job may have a published run link"
        );
      }
      const terminal = isTerminal(next);
      this.database.prepare(`
        UPDATE browser_refresh_jobs SET
          state = ?,
          stage = ?,
          reason = ?,
          updated_at = ?,
          finished_at = ?,
          detail_required_count = ?,
          detail_completed_count = ?,
          unique_item_count = ?,
          item_count = ?,
          list_batch_cursor = ?,
          load_action_count = ?,
          cooldown_attempt = ?,
          cooldown_until = ?,
          next_action_at = ?,
          action_permit_hash = ?,
          action_permit_expires_at = ?,
          action_permit_consumed_at = ?,
          filter_url = ?,
          last_error = ?,
          scan_run_id = ?,
          published_run_id = ?,
          claim_code_hash = ?,
          bridge_token_hash = ?
        WHERE id = ?
      `).run(
        next,
        values.stage,
        values.reason,
        timestamp,
        terminal ? timestamp : row.finished_at,
        values.detailRequiredCount,
        values.detailCompletedCount,
        values.uniqueItemCount,
        values.itemCount,
        values.listBatchCursor,
        values.loadActionCount,
        values.cooldownAttempt,
        values.cooldownUntil,
        values.nextActionAt,
        terminal ? null : values.actionPermitHash,
        terminal ? null : values.actionPermitExpiresAt,
        patch.actionPermit === undefined
          ? row.action_permit_consumed_at
          : null,
        values.filterUrl,
        values.lastError,
        values.scanRunId,
        values.publishedRunId,
        terminal ? null : row.claim_code_hash,
        terminal ? null : row.bridge_token_hash,
        id
      );
      return toView(this.requireRow(id));
    });
  }

  recoverInterruptedJobs(now = new Date()): void {
    this.expireJobs(now);
    const timestamp = now.toISOString();
    this.runTransaction(() => {
      this.database.prepare(`
        UPDATE browser_refresh_jobs
        SET state = 'failed',
            stage = 'failed',
            reason = 'process_interrupted',
            last_error = 'process_interrupted',
            updated_at = ?,
            finished_at = ?,
            claim_code_hash = NULL,
            bridge_token_hash = NULL,
            action_permit_hash = NULL,
            action_permit_expires_at = NULL
        WHERE state = 'committing'
      `).run(timestamp, timestamp);
      this.database.prepare(`
        UPDATE browser_refresh_jobs
        SET state = 'paused',
            stage = 'paused',
            reason = 'process_interrupted',
            last_error = 'process_interrupted',
            updated_at = ?,
            action_permit_hash = NULL,
            action_permit_expires_at = NULL,
            action_permit_consumed_at = NULL
        WHERE state NOT IN (
          'success', 'quarantined', 'failed', 'cancelled', 'expired',
          'committing'
        )
      `).run(timestamp);
    });
  }

  expireJobs(now = new Date()): number {
    const timestamp = now.toISOString();
    const result = this.database.prepare(`
      UPDATE browser_refresh_jobs
      SET state = 'expired',
          stage = 'expired',
          reason = 'expired',
          updated_at = ?,
          finished_at = ?,
          claim_code_hash = NULL,
          bridge_token_hash = NULL,
          action_permit_hash = NULL,
          action_permit_expires_at = NULL
      WHERE expires_at <= ?
        AND state NOT IN (
          'success', 'quarantined', 'failed', 'cancelled', 'expired'
        )
    `).run(timestamp, timestamp, timestamp);
    return Number(result.changes);
  }

  cleanupTerminalStaging(now = new Date()): number {
    this.expireJobs(now);
    let changes = 0;
    const cutoff = new Date(
      now.getTime() - TERMINAL_AUDIT_RETENTION_MS
    ).toISOString();
    return this.runTransaction(() => {
      const invalidTerminal = this.database.prepare(`
        SELECT id, state FROM browser_refresh_jobs
        WHERE (
          state = 'success'
          AND (
            scan_run_id IS NULL
            OR published_run_id IS NULL
            OR published_run_id <> scan_run_id
          )
        ) OR (
          state = 'quarantined'
          AND (
            scan_run_id IS NULL
            OR published_run_id IS NOT NULL
          )
        ) OR (
          state <> 'success'
          AND published_run_id IS NOT NULL
        )
        LIMIT 1
      `).get() as
        | { id: string; state: BrowserRefreshJobState }
        | undefined;
      if (invalidTerminal) {
        throw new BrowserRefreshRepositoryError(
          "invalid_terminal_linkage",
          `Cannot clean ${invalidTerminal.state} job ` +
            `${invalidTerminal.id} without valid scan linkage`
        );
      }
      for (const table of [
        "browser_refresh_details",
        "browser_refresh_list_items",
        "browser_refresh_batches"
      ]) {
        const result = this.database.prepare(`
          DELETE FROM ${table}
          WHERE job_id IN (
            SELECT id FROM browser_refresh_jobs
            WHERE state IN (
              'success', 'quarantined', 'failed', 'cancelled', 'expired'
            )
          )
        `).run();
        changes += Number(result.changes);
      }
      for (const table of [
        "browser_refresh_filter_proofs",
        "browser_refresh_load_events"
      ]) {
        const result = this.database.prepare(`
          DELETE FROM ${table}
          WHERE job_id IN (
            SELECT id FROM browser_refresh_jobs
            WHERE state IN ('failed', 'cancelled', 'expired')
          )
        `).run();
        changes += Number(result.changes);
      }
      const oldLoadEvents = this.database.prepare(`
        DELETE FROM browser_refresh_load_events
        WHERE job_id IN (
          SELECT id FROM browser_refresh_jobs
          WHERE state IN ('success', 'quarantined')
        )
          AND sequence NOT IN (
            SELECT kept.sequence
            FROM browser_refresh_load_events kept
            WHERE kept.job_id = browser_refresh_load_events.job_id
            ORDER BY kept.sequence DESC
            LIMIT 2
          )
      `).run();
      changes += Number(oldLoadEvents.changes);
      const aged = this.database.prepare(`
        DELETE FROM browser_refresh_jobs
        WHERE state IN ('failed', 'cancelled', 'expired')
          AND scan_run_id IS NULL
          AND COALESCE(finished_at, updated_at) <= ?
      `).run(cutoff);
      changes += Number(aged.changes);
      return changes;
    });
  }

  private runTransaction<T>(operation: () => T): T {
    const callerOwnsTransaction = this.database.isTransaction;
    const savepoint = callerOwnsTransaction
      ? `browser_refresh_${this.savepointPrefix}_` +
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

  private findRow(id: string): JobRow | undefined {
    return this.database.prepare(`
      SELECT * FROM browser_refresh_jobs WHERE id = ?
    `).get(id) as unknown as JobRow | undefined;
  }

  private requireRow(id: string): JobRow {
    const row = this.findRow(id);
    if (!row) {
      throw new BrowserRefreshRepositoryError(
        "job_not_found",
        "Browser refresh job not found"
      );
    }
    return row;
  }

  private requireActiveRow(id: string): JobRow {
    const row = this.requireRow(id);
    if (isTerminal(row.state)) {
      throw new BrowserRefreshRepositoryError(
        "job_terminal",
        "Browser refresh job is terminal"
      );
    }
    return row;
  }

  private findBatch(
    id: string,
    kind: "list" | "detail",
    sequence: number
  ):
    | { payload_hash: string; accepted_result_json: string }
    | undefined {
    return this.database.prepare(`
      SELECT payload_hash, accepted_result_json
      FROM browser_refresh_batches
      WHERE job_id = ? AND kind = ? AND sequence = ?
    `).get(id, kind, sequence) as
      | { payload_hash: string; accepted_result_json: string }
      | undefined;
  }

  private insertBatch(
    id: string,
    kind: "list" | "detail",
    sequence: number,
    hash: string,
    acceptedCount: number,
    result: AcceptedBatchView | DetailProgressView,
    now: Date
  ): void {
    this.database.prepare(`
      INSERT INTO browser_refresh_batches (
        job_id, kind, sequence, payload_hash, accepted_count,
        accepted_result_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      kind,
      sequence,
      hash,
      acceptedCount,
      JSON.stringify(result),
      now.toISOString()
    );
  }

  private consumeActionPermit(
    job: JobRow,
    supplied: string | undefined,
    now: Date
  ): void {
    if (job.action_permit_hash === null) {
      if (supplied !== undefined) {
        throw new BrowserRefreshRepositoryError(
          "invalid_action_permit",
          "No action permit is active"
        );
      }
      return;
    }
    if (
      supplied === undefined ||
      job.action_permit_consumed_at !== null ||
      job.action_permit_expires_at === null ||
      !Number.isFinite(Date.parse(job.action_permit_expires_at)) ||
      Date.parse(job.action_permit_expires_at) <= now.getTime() ||
      !credentialMatches(supplied, job.action_permit_hash)
    ) {
      throw new BrowserRefreshRepositoryError(
        "invalid_action_permit",
        "The action permit is invalid, expired, or consumed"
      );
    }
    this.database.prepare(`
      UPDATE browser_refresh_jobs
      SET action_permit_consumed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(now.toISOString(), now.toISOString(), job.id);
  }
}
