import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  canTransitionPanzhiAutomationJob,
  isTerminalPanzhiAutomationState,
  PanzhiAutomationDigestSchema,
  PanzhiAutomationModeSchema,
  PanzhiAutomationStateSchema,
  type PanzhiAutomationCancelResponse,
  type PanzhiAutomationClaimResponse,
  type PanzhiAutomationCompletionResponse,
  type PanzhiAutomationEnqueueResponse,
  type PanzhiAutomationExtensionHeartbeat,
  type PanzhiAutomationHeartbeatResponse,
  type PanzhiAutomationJob,
  type PanzhiAutomationMode,
  type PanzhiAutomationState,
  type PanzhiAutomationStateResponse,
  type PanzhiAutomationStatus
} from "./contracts.js";

const LEASE_MS = 2 * 60 * 1_000;
const EXTENSION_CONNECTED_MS = 2 * 60 * 1_000;
const VERIFICATION_DEADLINE_MS = 24 * 60 * 60 * 1_000;
const DUMMY_DIGEST = "0".repeat(64);

export type PanzhiAutomationRepositoryErrorCode =
  | "not_found"
  | "unauthorized"
  | "invalid_transition"
  | "conflict"
  | "expired";

export class PanzhiAutomationRepositoryError extends Error {
  constructor(
    readonly code: PanzhiAutomationRepositoryErrorCode,
    message: string
  ) {
    super(message);
    this.name = "PanzhiAutomationRepositoryError";
  }
}

export interface PanzhiAutomationTransitionPatch {
  error?: string | null;
  clearVerification?: boolean;
  verificationNotified?: boolean;
}

export interface CompletePublishedInput {
  jobId: string;
  bearerToken: string;
  canonicalBodyDigest: string;
  result: unknown;
  scanRunId: number;
  now?: Date;
}

export interface CompleteUnpublishedInput {
  jobId: string;
  bearerToken: string;
  error: string;
  now?: Date;
}

interface JobRow {
  id: string;
  mode: PanzhiAutomationMode;
  state: PanzhiAutomationState;
  lease_token_digest: string | null;
  lease_expires_at: string | null;
  completed_bearer_digest: string | null;
  verification_deadline_at: string | null;
  verification_notified_at: string | null;
  normalized_request_digest: string | null;
  result_json: string | null;
  error: string | null;
  scan_run_id: number | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function digestMatches(value: string, storedDigest: string | null): boolean {
  const actual = Buffer.from(sha256(value), "hex");
  let expected: Buffer;
  try {
    expected = Buffer.from(storedDigest ?? DUMMY_DIGEST, "hex");
  } catch {
    expected = Buffer.from(DUMMY_DIGEST, "hex");
  }
  if (expected.length !== actual.length) {
    expected = Buffer.from(DUMMY_DIGEST, "hex");
  }
  const matched = timingSafeEqual(actual, expected);
  return storedDigest !== null && matched;
}

function toJob(row: JobRow): PanzhiAutomationJob {
  return {
    id: row.id,
    mode: row.mode,
    state: row.state,
    leaseExpiresAt: row.lease_expires_at,
    verificationDeadlineAt: row.verification_deadline_at,
    verificationNotifiedAt: row.verification_notified_at,
    normalizedRequestDigest: row.normalized_request_digest,
    error: row.error,
    scanRunId: row.scan_run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at
  };
}

function leaseExpiry(now: Date): string {
  return new Date(now.getTime() + LEASE_MS).toISOString();
}

function assertCanonicalDigest(value: string): string {
  const parsed = PanzhiAutomationDigestSchema.safeParse(value);
  if (!parsed.success) {
    throw new PanzhiAutomationRepositoryError(
      "conflict",
      "Expected a canonical SHA-256 digest"
    );
  }
  return parsed.data;
}

export class PanzhiAutomationRepository {
  private readonly savepointPrefix = randomBytes(8).toString("hex");
  private savepointSequence = 0;

  constructor(private readonly database: DatabaseSync) {}

  enqueue(
    mode: PanzhiAutomationMode,
    now = new Date()
  ): PanzhiAutomationEnqueueResponse {
    const parsedMode = PanzhiAutomationModeSchema.parse(mode);
    return this.runTransaction(() => {
      const active = this.findActiveRow();
      if (active) {
        if (
          parsedMode === "deep" &&
          active.mode === "quick" &&
          active.state === "queued"
        ) {
          this.database.prepare(`
            UPDATE panzhi_browser_jobs
            SET mode = 'deep', updated_at = ?
            WHERE id = ? AND state = 'queued' AND mode = 'quick'
          `).run(now.toISOString(), active.id);
          return {
            job: toJob(this.requireRow(active.id)),
            created: false,
            upgraded: true
          };
        }
        return { job: toJob(active), created: false, upgraded: false };
      }

      const id = randomUUID();
      const timestamp = now.toISOString();
      this.database.prepare(`
        INSERT INTO panzhi_browser_jobs (
          id, mode, state, created_at, updated_at
        ) VALUES (?, ?, 'queued', ?, ?)
      `).run(id, parsedMode, timestamp, timestamp);
      return {
        job: toJob(this.requireRow(id)),
        created: true,
        upgraded: false
      };
    });
  }

  getCurrentJob(_now = new Date()): PanzhiAutomationJob | null {
    const row = this.database.prepare(`
      SELECT * FROM panzhi_browser_jobs
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `).get() as unknown as JobRow | undefined;
    return row ? toJob(row) : null;
  }

  getJob(id: string): PanzhiAutomationJob | null {
    const row = this.findRow(id);
    return row ? toJob(row) : null;
  }

  recordExtensionHeartbeat(
    now = new Date()
  ): PanzhiAutomationExtensionHeartbeat {
    return this.runTransaction(() => {
      const timestamp = now.toISOString();
      this.database.prepare(`
        UPDATE panzhi_extension_status
        SET last_heartbeat_at = ?
        WHERE singleton = 1
      `).run(timestamp);
      return { connected: true, lastHeartbeatAt: timestamp };
    });
  }

  getStatus(now = new Date()): PanzhiAutomationStatus {
    const heartbeat = this.database.prepare(`
      SELECT last_heartbeat_at
      FROM panzhi_extension_status
      WHERE singleton = 1
    `).get() as { last_heartbeat_at: string | null } | undefined;
    const lastHeartbeatAt = heartbeat?.last_heartbeat_at ?? null;
    const connected =
      lastHeartbeatAt !== null &&
      now.getTime() - Date.parse(lastHeartbeatAt) <=
        EXTENSION_CONNECTED_MS;
    return {
      connected,
      lastHeartbeatAt,
      currentJob: this.getCurrentJob(now)
    };
  }

  claim(now = new Date()): PanzhiAutomationClaimResponse | null {
    const bearerToken = randomBytes(32).toString("base64url");
    return this.runTransaction(() => {
      this.requeueExpiredLeaseInTransaction(now);
      this.failExpiredVerificationInTransaction(now);
      const row = this.database.prepare(`
        SELECT * FROM panzhi_browser_jobs
        WHERE state = 'queued'
        ORDER BY created_at, rowid
        LIMIT 1
      `).get() as unknown as JobRow | undefined;
      if (!row) return null;
      const timestamp = now.toISOString();
      this.database.prepare(`
        UPDATE panzhi_browser_jobs
        SET state = 'opening_page',
            lease_token_digest = ?,
            lease_expires_at = ?,
            error = NULL,
            finished_at = NULL,
            updated_at = ?
        WHERE id = ? AND state = 'queued'
      `).run(
        sha256(bearerToken),
        leaseExpiry(now),
        timestamp,
        row.id
      );
      return { job: toJob(this.requireRow(row.id)), bearerToken };
    });
  }

  resume(
    jobId: string,
    bearerToken: string,
    now = new Date()
  ): PanzhiAutomationClaimResponse {
    return this.runAuthorizedMutation(jobId, bearerToken, now, (row) => {
      this.extendLease(row.id, now);
      return {
        job: toJob(this.requireRow(row.id)),
        bearerToken
      };
    });
  }

  heartbeat(
    jobId: string,
    bearerToken: string,
    now = new Date()
  ): PanzhiAutomationHeartbeatResponse {
    return this.runAuthorizedMutation(jobId, bearerToken, now, (row) => {
      const expiresAt = this.extendLease(row.id, now);
      return {
        job: toJob(this.requireRow(row.id)),
        leaseExpiresAt: expiresAt
      };
    });
  }

  transition(
    jobId: string,
    bearerToken: string,
    next: PanzhiAutomationState,
    patch: PanzhiAutomationTransitionPatch = {},
    now = new Date()
  ): PanzhiAutomationStateResponse {
    const parsedNext = PanzhiAutomationStateSchema.parse(next);
    return this.runAuthorizedMutation(jobId, bearerToken, now, (row) => {
      if (
        parsedNext === "success" ||
        parsedNext === "cancelled" ||
        !canTransitionPanzhiAutomationJob(row.state, parsedNext)
      ) {
        throw new PanzhiAutomationRepositoryError(
          "invalid_transition",
          `Cannot transition Panzhi job from ${row.state} to ${parsedNext}`
        );
      }

      const timestamp = now.toISOString();
      const terminal = parsedNext === "failed";
      const clearsVerification =
        patch.clearVerification === true ||
        (
          row.state === "awaiting_user_verification" &&
          parsedNext === "applying_filters"
        );
      const verificationDeadline =
        parsedNext === "awaiting_user_verification"
          ? row.verification_deadline_at ?? new Date(
              now.getTime() + VERIFICATION_DEADLINE_MS
            ).toISOString()
          : clearsVerification
            ? null
            : row.verification_deadline_at;
      const verificationNotified = clearsVerification
        ? null
        : patch.verificationNotified
          ? timestamp
          : row.verification_notified_at;
      this.database.prepare(`
        UPDATE panzhi_browser_jobs
        SET state = ?,
            lease_token_digest = ?,
            lease_expires_at = ?,
            verification_deadline_at = ?,
            verification_notified_at = ?,
            error = ?,
            updated_at = ?,
            finished_at = ?
        WHERE id = ?
      `).run(
        parsedNext,
        terminal ? null : row.lease_token_digest,
        terminal ? null : leaseExpiry(now),
        verificationDeadline,
        verificationNotified,
        terminal ? patch.error ?? "automation_failed" : patch.error ?? null,
        timestamp,
        terminal ? timestamp : null,
        row.id
      );
      return { job: toJob(this.requireRow(row.id)) };
    });
  }

  cancel(
    jobId: string,
    bearerToken: string,
    now = new Date()
  ): PanzhiAutomationCancelResponse {
    return this.runTransaction(() => {
      const row = this.requireAuthorizedActiveRow(jobId, bearerToken, now);
      const timestamp = now.toISOString();
      this.database.prepare(`
        UPDATE panzhi_browser_jobs
        SET state = 'cancelled',
            lease_token_digest = NULL,
            lease_expires_at = NULL,
            normalized_request_digest = NULL,
            error = NULL,
            updated_at = ?,
            finished_at = ?
        WHERE id = ?
      `).run(timestamp, timestamp, row.id);
      return { job: toJob(this.requireRow(row.id)) };
    });
  }

  requeueExpiredLease(now = new Date()): number {
    return this.runTransaction(() =>
      this.requeueExpiredLeaseInTransaction(now)
    );
  }

  failExpiredVerification(now = new Date()): number {
    return this.runTransaction(() =>
      this.failExpiredVerificationInTransaction(now)
    );
  }

  getAuthorizedJobForSnapshot(
    jobId: string,
    bearerToken: string,
    requestDigest: string,
    now = new Date()
  ): PanzhiAutomationJob {
    const canonicalDigest = assertCanonicalDigest(requestDigest);
    return this.runTransaction(() => {
      const row = this.requireAuthorizedActiveRow(jobId, bearerToken, now);
      if (row.state !== "submitting") {
        throw new PanzhiAutomationRepositoryError(
          "invalid_transition",
          "Only a submitting Panzhi job can publish a snapshot"
        );
      }
      if (
        row.normalized_request_digest !== null &&
        row.normalized_request_digest !== canonicalDigest
      ) {
        throw new PanzhiAutomationRepositoryError(
          "conflict",
          "The Panzhi job is already bound to a different request"
        );
      }
      this.database.prepare(`
        UPDATE panzhi_browser_jobs
        SET normalized_request_digest = ?,
            lease_expires_at = ?,
            updated_at = ?
        WHERE id = ?
      `).run(
        canonicalDigest,
        leaseExpiry(now),
        now.toISOString(),
        row.id
      );
      return toJob(this.requireRow(row.id));
    });
  }

  findSuccessfulReplay<T = unknown>(
    jobId: string,
    bearerToken: string,
    requestDigest: string
  ): T | null {
    const row = this.findRow(jobId);
    const tokenMatches = digestMatches(
      bearerToken,
      row?.completed_bearer_digest ?? null
    );
    if (!row) {
      throw new PanzhiAutomationRepositoryError(
        "not_found",
        "Panzhi automation job not found"
      );
    }
    if (row.state !== "success") return null;
    if (!tokenMatches) {
      throw new PanzhiAutomationRepositoryError(
        "unauthorized",
        "The completed bearer token is invalid"
      );
    }
    const canonicalDigest = assertCanonicalDigest(requestDigest);
    if (row.normalized_request_digest !== canonicalDigest) {
      throw new PanzhiAutomationRepositoryError(
        "conflict",
        "The completed request body does not match"
      );
    }
    if (row.result_json === null) {
      throw new PanzhiAutomationRepositoryError(
        "conflict",
        "Stored Panzhi snapshot result is missing"
      );
    }
    try {
      return JSON.parse(row.result_json) as T;
    } catch {
      throw new PanzhiAutomationRepositoryError(
        "conflict",
        "Stored Panzhi snapshot result is corrupt"
      );
    }
  }

  completePublished(
    input: CompletePublishedInput
  ): PanzhiAutomationCompletionResponse {
    this.requireCallerTransaction();
    const now = input.now ?? new Date();
    const canonicalDigest = assertCanonicalDigest(
      input.canonicalBodyDigest
    );
    const row = this.requireAuthorizedActiveRow(
      input.jobId,
      input.bearerToken,
      now
    );
    if (row.state !== "submitting") {
      throw new PanzhiAutomationRepositoryError(
        "invalid_transition",
        "Only a submitting Panzhi job can complete"
      );
    }
    if (
      row.normalized_request_digest !== null &&
      row.normalized_request_digest !== canonicalDigest
    ) {
      throw new PanzhiAutomationRepositoryError(
        "conflict",
        "The completed body differs from the authorized request"
      );
    }
    if (!Number.isSafeInteger(input.scanRunId) || input.scanRunId <= 0) {
      throw new PanzhiAutomationRepositoryError(
        "conflict",
        "A valid scan run is required for a successful Panzhi job"
      );
    }
    const publishedPanzhiResult = this.database.prepare(`
      SELECT 1
      FROM scan_source_results
      WHERE run_id = ?
        AND source = 'panzhi'
        AND published = 1
      LIMIT 1
    `).get(input.scanRunId);
    if (!publishedPanzhiResult) {
      throw new PanzhiAutomationRepositoryError(
        "conflict",
        "A published Panzhi source result is required for completion"
      );
    }
    const resultJson = JSON.stringify(input.result);
    if (resultJson === undefined) {
      throw new PanzhiAutomationRepositoryError(
        "conflict",
        "The published result must be JSON serializable"
      );
    }
    const timestamp = now.toISOString();
    this.database.prepare(`
      UPDATE panzhi_browser_jobs
      SET state = 'success',
          lease_token_digest = NULL,
          lease_expires_at = NULL,
          completed_bearer_digest = ?,
          normalized_request_digest = ?,
          result_json = ?,
          error = NULL,
          scan_run_id = ?,
          updated_at = ?,
          finished_at = ?
      WHERE id = ?
    `).run(
      sha256(input.bearerToken),
      canonicalDigest,
      resultJson,
      input.scanRunId,
      timestamp,
      timestamp,
      row.id
    );
    return { job: toJob(this.requireRow(row.id)) };
  }

  completeUnpublished(
    input: CompleteUnpublishedInput
  ): PanzhiAutomationCompletionResponse {
    this.requireCallerTransaction();
    const now = input.now ?? new Date();
    const row = this.requireAuthorizedActiveRow(
      input.jobId,
      input.bearerToken,
      now
    );
    if (row.state !== "submitting") {
      throw new PanzhiAutomationRepositoryError(
        "invalid_transition",
        "Only a submitting Panzhi job can complete unpublished"
      );
    }
    const timestamp = now.toISOString();
    this.database.prepare(`
      UPDATE panzhi_browser_jobs
      SET state = 'failed',
          lease_token_digest = NULL,
          lease_expires_at = NULL,
          normalized_request_digest = NULL,
          result_json = NULL,
          error = ?,
          scan_run_id = NULL,
          updated_at = ?,
          finished_at = ?
      WHERE id = ?
    `).run(input.error, timestamp, timestamp, row.id);
    return { job: toJob(this.requireRow(row.id)) };
  }

  private requeueExpiredLeaseInTransaction(now: Date): number {
    const result = this.database.prepare(`
      UPDATE panzhi_browser_jobs
      SET state = 'queued',
          lease_token_digest = NULL,
          lease_expires_at = NULL,
          normalized_request_digest = NULL,
          result_json = NULL,
          error = NULL,
          scan_run_id = NULL,
          updated_at = ?,
          finished_at = NULL
      WHERE state NOT IN ('queued', 'success', 'failed', 'cancelled')
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= ?
    `).run(now.toISOString(), now.toISOString());
    return Number(result.changes);
  }

  private failExpiredVerificationInTransaction(now: Date): number {
    const result = this.database.prepare(`
      UPDATE panzhi_browser_jobs
      SET state = 'failed',
          lease_token_digest = NULL,
          lease_expires_at = NULL,
          normalized_request_digest = NULL,
          result_json = NULL,
          error = 'captcha_required',
          scan_run_id = NULL,
          updated_at = ?,
          finished_at = ?
      WHERE state NOT IN ('success', 'failed', 'cancelled')
        AND verification_deadline_at IS NOT NULL
        AND verification_deadline_at < ?
    `).run(now.toISOString(), now.toISOString(), now.toISOString());
    return Number(result.changes);
  }

  private extendLease(jobId: string, now: Date): string {
    const expiresAt = leaseExpiry(now);
    this.database.prepare(`
      UPDATE panzhi_browser_jobs
      SET lease_expires_at = ?, updated_at = ?
      WHERE id = ?
    `).run(expiresAt, now.toISOString(), jobId);
    return expiresAt;
  }

  private runAuthorizedMutation<T>(
    jobId: string,
    bearerToken: string,
    now: Date,
    operation: (row: JobRow) => T
  ): T {
    const outcome = this.runTransaction(() => {
      const row = this.findRow(jobId);
      const matched = digestMatches(
        bearerToken,
        row?.lease_token_digest ?? null
      );
      if (
        !row ||
        !matched ||
        isTerminalPanzhiAutomationState(row.state) ||
        row.lease_token_digest === null
      ) {
        throw new PanzhiAutomationRepositoryError(
          "unauthorized",
          "The bearer token is invalid, expired, or no longer active"
        );
      }

      const verificationDeadline = row.verification_deadline_at === null
        ? Number.POSITIVE_INFINITY
        : Date.parse(row.verification_deadline_at);
      if (verificationDeadline < now.getTime()) {
        const timestamp = now.toISOString();
        this.database.prepare(`
          UPDATE panzhi_browser_jobs
          SET state = 'failed',
              lease_token_digest = NULL,
              lease_expires_at = NULL,
              normalized_request_digest = NULL,
              result_json = NULL,
              error = 'captcha_required',
              scan_run_id = NULL,
              updated_at = ?,
              finished_at = ?
          WHERE id = ?
        `).run(timestamp, timestamp, row.id);
        return { kind: "verification_expired" } as const;
      }

      const leaseExpiresAt = row.lease_expires_at
        ? Date.parse(row.lease_expires_at)
        : Number.NEGATIVE_INFINITY;
      if (leaseExpiresAt <= now.getTime()) {
        throw new PanzhiAutomationRepositoryError(
          "unauthorized",
          "The bearer token is invalid, expired, or no longer active"
        );
      }
      return { kind: "completed", value: operation(row) } as const;
    });
    if (outcome.kind === "verification_expired") {
      throw new PanzhiAutomationRepositoryError(
        "expired",
        "Panzhi user verification expired"
      );
    }
    return outcome.value;
  }

  private requireAuthorizedActiveRow(
    jobId: string,
    bearerToken: string,
    now: Date
  ): JobRow {
    const row = this.findRow(jobId);
    const matched = digestMatches(
      bearerToken,
      row?.lease_token_digest ?? null
    );
    const leaseExpiresAt = row?.lease_expires_at
      ? Date.parse(row.lease_expires_at)
      : Number.NEGATIVE_INFINITY;
    if (
      !row ||
      !matched ||
      isTerminalPanzhiAutomationState(row.state) ||
      row.lease_token_digest === null ||
      leaseExpiresAt <= now.getTime()
    ) {
      throw new PanzhiAutomationRepositoryError(
        "unauthorized",
        "The bearer token is invalid, expired, or no longer active"
      );
    }
    return row;
  }

  private findActiveRow(): JobRow | undefined {
    return this.database.prepare(`
      SELECT * FROM panzhi_browser_jobs
      WHERE state NOT IN ('success', 'failed', 'cancelled')
      LIMIT 1
    `).get() as unknown as JobRow | undefined;
  }

  private findRow(id: string): JobRow | undefined {
    return this.database.prepare(`
      SELECT * FROM panzhi_browser_jobs WHERE id = ?
    `).get(id) as unknown as JobRow | undefined;
  }

  private requireRow(id: string): JobRow {
    const row = this.findRow(id);
    if (!row) {
      throw new PanzhiAutomationRepositoryError(
        "not_found",
        "Panzhi automation job not found"
      );
    }
    return row;
  }

  private requireCallerTransaction(): void {
    if (!this.database.isTransaction) {
      throw new PanzhiAutomationRepositoryError(
        "conflict",
        "Panzhi completion requires a caller-owned transaction"
      );
    }
  }

  private runTransaction<T>(operation: () => T): T {
    const callerOwnsTransaction = this.database.isTransaction;
    const savepoint = callerOwnsTransaction
      ? `panzhi_automation_${this.savepointPrefix}_${
          ++this.savepointSequence
        }`
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
}
