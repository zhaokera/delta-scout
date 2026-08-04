// @vitest-environment node

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../../src/server/db.js";
import {
  canTransitionPanzhiAutomationJob,
  isTerminalPanzhiAutomationState,
  PanzhiAutomationClaimResponseSchema,
  PanzhiAutomationJobSchema,
  PanzhiAutomationModeSchema,
  PanzhiAutomationStateSchema
} from "../../src/server/panzhiAutomation/contracts.js";
import {
  PanzhiAutomationRepository,
  PanzhiAutomationRepositoryError
} from "../../src/server/panzhiAutomation/repository.js";

const start = new Date("2026-08-04T02:00:00.000Z");

function plus(milliseconds: number): Date {
  return new Date(start.getTime() + milliseconds);
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function expectRepositoryError(
  operation: () => unknown,
  code: PanzhiAutomationRepositoryError["code"]
): PanzhiAutomationRepositoryError {
  let caught: unknown;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PanzhiAutomationRepositoryError);
  expect(caught).toMatchObject({ code });
  return caught as PanzhiAutomationRepositoryError;
}

function claimedRepository(mode: "quick" | "deep" = "quick") {
  const database = createDatabase(":memory:");
  const repository = new PanzhiAutomationRepository(database);
  const enqueued = repository.enqueue(mode, start);
  const claimed = repository.claim(start)!;
  return { database, repository, enqueued, claimed };
}

function insertPublishedPanzhiSourceResult(
  database: ReturnType<typeof createDatabase>,
  runId: number
): void {
  database.prepare(`
    INSERT INTO scan_source_results (
      run_id, source, state, pages_scanned,
      observed_item_count, eligible_count,
      balanced_candidate_count, global_candidate_count,
      published
    ) VALUES (?, 'panzhi', 'success', 1, 1, 1, 0, 0, 1)
  `).run(runId);
}

describe("Panzhi automation contracts", () => {
  it("publishes the approved modes, states, terminal helpers, and transitions", () => {
    expect(PanzhiAutomationModeSchema.options).toEqual(["quick", "deep"]);
    expect(PanzhiAutomationStateSchema.options).toEqual([
      "queued",
      "opening_page",
      "applying_filters",
      "collecting",
      "awaiting_user_verification",
      "submitting",
      "success",
      "failed",
      "cancelled"
    ]);
    expect(isTerminalPanzhiAutomationState("success")).toBe(true);
    expect(isTerminalPanzhiAutomationState("collecting")).toBe(false);
    expect(canTransitionPanzhiAutomationJob("queued", "opening_page")).toBe(true);
    expect(canTransitionPanzhiAutomationJob("opening_page", "success")).toBe(false);
    expect(canTransitionPanzhiAutomationJob(
      "opening_page",
      "awaiting_user_verification"
    )).toBe(true);
    expect(canTransitionPanzhiAutomationJob(
      "applying_filters",
      "awaiting_user_verification"
    )).toBe(true);
    expect(canTransitionPanzhiAutomationJob(
      "awaiting_user_verification",
      "applying_filters"
    )).toBe(true);
    expect(canTransitionPanzhiAutomationJob(
      "awaiting_user_verification",
      "collecting"
    )).toBe(false);
  });
});

describe("PanzhiAutomationRepository", () => {
  it("keeps one non-terminal job and reuses its id for equal or lower priority enqueue", () => {
    const database = createDatabase(":memory:");
    const repository = new PanzhiAutomationRepository(database);

    const first = repository.enqueue("deep", start);
    const repeated = repository.enqueue("deep", plus(1));
    const lower = repository.enqueue("quick", plus(2));

    expect(repeated).toEqual({ job: first.job, created: false, upgraded: false });
    expect(lower).toEqual({ job: first.job, created: false, upgraded: false });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM panzhi_browser_jobs
      WHERE state NOT IN ('success', 'failed', 'cancelled')
    `).get()).toEqual({ count: 1 });
    expect(() => database.prepare(`
      INSERT INTO panzhi_browser_jobs (
        id, mode, state, normalized_request_digest, created_at, updated_at
      ) VALUES (?, 'quick', 'queued', ?, ?, ?)
    `).run(
      "00000000-0000-4000-8000-000000000000",
      digest("direct"),
      start.toISOString(),
      start.toISOString()
    )).toThrow();
  });

  it("upgrades a queued quick job to deep in place", () => {
    const database = createDatabase(":memory:");
    const repository = new PanzhiAutomationRepository(database);
    const quick = repository.enqueue("quick", start);

    const deep = repository.enqueue("deep", plus(1));

    expect(deep).toMatchObject({
      created: false,
      upgraded: true,
      job: { id: quick.job.id, mode: "deep", state: "queued" }
    });
    expect(deep.job.normalizedRequestDigest).toBeNull();
  });

  it.each(["collecting", "awaiting_user_verification", "submitting"] as const)(
    "does not upgrade a quick job while it is %s",
    (state) => {
      const { repository, claimed } = claimedRepository();
      repository.transition(
        claimed.job.id,
        claimed.bearerToken,
        "applying_filters",
        {},
        start
      );
      repository.transition(
        claimed.job.id,
        claimed.bearerToken,
        "collecting",
        {},
        start
      );
      if (state === "awaiting_user_verification") {
        repository.transition(
          claimed.job.id,
          claimed.bearerToken,
          state,
          {},
          start
        );
      } else if (state === "submitting") {
        repository.transition(
          claimed.job.id,
          claimed.bearerToken,
          state,
          {},
          start
        );
      }

      const result = repository.enqueue("deep", plus(1));

      expect(result).toMatchObject({
        created: false,
        upgraded: false,
        job: { id: claimed.job.id, mode: "quick", state }
      });
    }
  );

  it("reports extension heartbeat connected for exactly the two-minute window", () => {
    const database = createDatabase(":memory:");
    const repository = new PanzhiAutomationRepository(database);

    expect(repository.getStatus(start)).toEqual({
      connected: false,
      lastHeartbeatAt: null,
      currentJob: null
    });
    expect(repository.recordExtensionHeartbeat(start)).toEqual({
      connected: true,
      lastHeartbeatAt: start.toISOString()
    });
    expect(repository.getStatus(plus(120_000))).toMatchObject({
      connected: true,
      lastHeartbeatAt: start.toISOString()
    });
    expect(repository.getStatus(plus(120_001))).toMatchObject({
      connected: false,
      lastHeartbeatAt: start.toISOString()
    });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM panzhi_extension_status"
    ).get()).toEqual({ count: 1 });
  });

  it("claims with a 256-bit bearer, stores only its SHA-256 digest, and resumes it", () => {
    const { database, repository, claimed } = claimedRepository();
    const tokenBytes = Buffer.from(claimed.bearerToken, "base64url");

    expect(tokenBytes).toHaveLength(32);
    expect(PanzhiAutomationClaimResponseSchema.parse(claimed)).toEqual(claimed);
    expect(PanzhiAutomationJobSchema.parse(claimed.job)).toEqual(claimed.job);
    const row = database.prepare(`
      SELECT lease_token_digest, lease_expires_at
      FROM panzhi_browser_jobs WHERE id = ?
    `).get(claimed.job.id) as {
      lease_token_digest: string;
      lease_expires_at: string;
    };
    expect(row.lease_token_digest).toBe(digest(claimed.bearerToken));
    expect(row.lease_token_digest).not.toContain(claimed.bearerToken);
    expect(row.lease_expires_at).toBe(plus(120_000).toISOString());
    expect(JSON.stringify(database.prepare(
      "SELECT * FROM panzhi_browser_jobs WHERE id = ?"
    ).get(claimed.job.id))).not.toContain(claimed.bearerToken);

    const resumed = repository.resume(
      claimed.job.id,
      claimed.bearerToken,
      plus(60_000)
    );
    expect(resumed.job.leaseExpiresAt).toBe(plus(180_000).toISOString());
  });

  it("authenticates a job token without renewing or validating its lease", () => {
    const { database, repository, claimed } = claimedRepository();
    const before = database.prepare(`
      SELECT lease_expires_at, updated_at
      FROM panzhi_browser_jobs WHERE id = ?
    `).get(claimed.job.id);

    expect(repository.authenticateJobToken(
      claimed.job.id,
      claimed.bearerToken
    )).toMatchObject({ id: claimed.job.id, state: "opening_page" });
    expect(database.prepare(`
      SELECT lease_expires_at, updated_at
      FROM panzhi_browser_jobs WHERE id = ?
    `).get(claimed.job.id)).toEqual(before);
    expectRepositoryError(() => repository.authenticateJobToken(
      claimed.job.id,
      "wrong-token"
    ), "unauthorized");
    expectRepositoryError(() => repository.authenticateJobToken(
      "00000000-0000-4000-8000-000000000000",
      claimed.bearerToken
    ), "not_found");
  });

  it("requeues the same job after an expired lease and invalidates the old bearer", () => {
    const { database, repository, claimed } = claimedRepository();

    expect(repository.requeueExpiredLease(plus(120_001))).toBe(1);
    expect(repository.getJob(claimed.job.id)).toMatchObject({
      id: claimed.job.id,
      state: "queued",
      leaseExpiresAt: null
    });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM panzhi_browser_jobs"
    ).get()).toEqual({ count: 1 });
    expectRepositoryError(() => repository.heartbeat(
      claimed.job.id,
      claimed.bearerToken,
      plus(120_001)
    ), "unauthorized");

    const reclaimed = repository.claim(plus(120_001))!;
    expect(reclaimed.job.id).toBe(claimed.job.id);
    expect(reclaimed.bearerToken).not.toBe(claimed.bearerToken);
  });

  it("heartbeats only an active lease and rejects invalid or stale bearers", () => {
    const { repository, claimed } = claimedRepository();

    const heartbeat = repository.heartbeat(
      claimed.job.id,
      claimed.bearerToken,
      plus(30_000)
    );
    expect(heartbeat.leaseExpiresAt).toBe(plus(150_000).toISOString());
    expectRepositoryError(() => repository.heartbeat(
      claimed.job.id,
      "wrong-token",
      plus(31_000)
    ), "unauthorized");
  });

  it("fails closed on forbidden or stale state transitions", () => {
    const { repository, claimed } = claimedRepository();

    expectRepositoryError(() => repository.transition(
      claimed.job.id,
      claimed.bearerToken,
      "success",
      {},
      plus(1)
    ), "invalid_transition");
    expect(repository.getJob(claimed.job.id)?.state).toBe("opening_page");
    expectRepositoryError(() => repository.transition(
      claimed.job.id,
      "wrong-token",
      "applying_filters",
      {},
      plus(2)
    ), "unauthorized");
    expect(repository.getJob(claimed.job.id)?.state).toBe("opening_page");
  });

  it("cancels an active job, invalidates its bearer, and allows a new job", () => {
    const { repository, claimed } = claimedRepository();

    const cancelled = repository.cancel(
      claimed.job.id,
      claimed.bearerToken,
      start
    );
    expect(cancelled.job).toMatchObject({ state: "cancelled" });
    expectRepositoryError(() => repository.heartbeat(
      claimed.job.id,
      claimed.bearerToken,
      plus(1)
    ), "unauthorized");
    const next = repository.enqueue("quick", plus(1));
    expect(next.created).toBe(true);
    expect(next.job.id).not.toBe(claimed.job.id);
  });

  it("sets a 24-hour verification deadline and fails it when overdue", () => {
    const { repository, claimed } = claimedRepository();
    repository.transition(
      claimed.job.id,
      claimed.bearerToken,
      "applying_filters",
      {},
      start
    );
    repository.transition(
      claimed.job.id,
      claimed.bearerToken,
      "collecting",
      {},
      start
    );
    const awaiting = repository.transition(
      claimed.job.id,
      claimed.bearerToken,
      "awaiting_user_verification",
      {},
      start
    );

    expect(awaiting.job.verificationDeadlineAt).toBe(
      plus(24 * 60 * 60 * 1_000).toISOString()
    );
    expect(repository.failExpiredVerification(
      plus(24 * 60 * 60 * 1_000)
    )).toBe(0);
    expect(repository.failExpiredVerification(
      plus(24 * 60 * 60 * 1_000 + 1)
    )).toBe(1);
    expect(repository.getJob(claimed.job.id)).toMatchObject({
      state: "failed",
      error: "captcha_required"
    });
  });

  it.each(["resume", "heartbeat"] as const)(
    "persists an expired verification failure before rejecting %s",
    (operation) => {
      const { repository, claimed } = claimedRepository();
      repository.transition(
        claimed.job.id,
        claimed.bearerToken,
        "awaiting_user_verification",
        { verificationNotified: true },
        start
      );
      const afterDeadline = plus(24 * 60 * 60 * 1_000 + 1);

      expectRepositoryError(
        () => operation === "resume"
          ? repository.resume(
              claimed.job.id,
              claimed.bearerToken,
              afterDeadline
            )
          : repository.heartbeat(
              claimed.job.id,
              claimed.bearerToken,
              afterDeadline
            ),
        "expired"
      );

      expect(repository.getJob(claimed.job.id)).toMatchObject({
        state: "failed",
        error: "captcha_required",
        leaseExpiresAt: null
      });
      expectRepositoryError(() => repository.heartbeat(
        claimed.job.id,
        claimed.bearerToken,
        afterDeadline
      ), "unauthorized");
    }
  );

  it("persists an expired verification failure before rejecting recovery", () => {
    const { repository, claimed } = claimedRepository();
    repository.transition(
      claimed.job.id,
      claimed.bearerToken,
      "awaiting_user_verification",
      { verificationNotified: true },
      start
    );
    const afterDeadline = plus(24 * 60 * 60 * 1_000 + 1);

    expectRepositoryError(() => repository.transition(
      claimed.job.id,
      claimed.bearerToken,
      "applying_filters",
      {},
      afterDeadline
    ), "expired");

    expect(repository.getJob(claimed.job.id)).toMatchObject({
      state: "failed",
      error: "captcha_required",
      leaseExpiresAt: null
    });
    expectRepositoryError(() => repository.transition(
      claimed.job.id,
      claimed.bearerToken,
      "applying_filters",
      {},
      afterDeadline
    ), "unauthorized");
  });

  it.each(["opening_page", "applying_filters", "collecting"] as const)(
    "allows verification detection while the job is %s",
    (state) => {
      const { repository, claimed } = claimedRepository();
      if (state !== "opening_page") {
        repository.transition(
          claimed.job.id,
          claimed.bearerToken,
          "applying_filters",
          {},
          start
        );
      }
      if (state === "collecting") {
        repository.transition(
          claimed.job.id,
          claimed.bearerToken,
          "collecting",
          {},
          start
        );
      }

      const result = repository.transition(
        claimed.job.id,
        claimed.bearerToken,
        "awaiting_user_verification",
        {},
        start
      );

      expect(result.job.state).toBe("awaiting_user_verification");
    }
  );

  it("automatically clears verification fields when returning to filters", () => {
    const { repository, claimed } = claimedRepository();
    repository.transition(
      claimed.job.id,
      claimed.bearerToken,
      "applying_filters",
      {},
      start
    );
    repository.transition(
      claimed.job.id,
      claimed.bearerToken,
      "collecting",
      {},
      start
    );
    repository.transition(
      claimed.job.id,
      claimed.bearerToken,
      "awaiting_user_verification",
      { verificationNotified: true },
      start
    );

    const resumed = repository.transition(
      claimed.job.id,
      claimed.bearerToken,
      "applying_filters",
      { verificationNotified: true },
      plus(1)
    );

    expect(resumed.job).toMatchObject({
      state: "applying_filters",
      verificationDeadlineAt: null,
      verificationNotifiedAt: null
    });
  });

  it.each(["collecting", "submitting"] as const)(
    "rejects verification recovery that jumps directly to %s",
    (next) => {
      const { repository, claimed } = claimedRepository();
      repository.transition(
        claimed.job.id,
        claimed.bearerToken,
        "applying_filters",
        {},
        start
      );
      repository.transition(
        claimed.job.id,
        claimed.bearerToken,
        "collecting",
        {},
        start
      );
      repository.transition(
        claimed.job.id,
        claimed.bearerToken,
        "awaiting_user_verification",
        {},
        start
      );

      expectRepositoryError(() => repository.transition(
        claimed.job.id,
        claimed.bearerToken,
        next,
        { clearVerification: true },
        plus(1)
      ), "invalid_transition");
    }
  );

  it("enforces success scan linkage and supports exact completed snapshot replay only", () => {
    const { database, repository, claimed } = claimedRepository();
    repository.transition(
      claimed.job.id,
      claimed.bearerToken,
      "applying_filters",
      {},
      start
    );
    repository.transition(
      claimed.job.id,
      claimed.bearerToken,
      "collecting",
      {},
      start
    );
    repository.transition(
      claimed.job.id,
      claimed.bearerToken,
      "submitting",
      {},
      start
    );
    const bodyDigest = digest("canonical-body");
    const result = { accepted: 17, scanRunId: 1 };

    expect(() => database.prepare(`
      UPDATE panzhi_browser_jobs SET state = 'success' WHERE id = ?
    `).run(claimed.job.id)).toThrow();

    database.exec("BEGIN IMMEDIATE");
    const run = database.prepare(`
      INSERT INTO scan_runs (
        started_at, finished_at, state, is_baseline,
        scope, requested_source
      ) VALUES (?, ?, 'success', 0, 'single_source', 'panzhi')
    `).run(start.toISOString(), start.toISOString());
    const scanRunId = Number(run.lastInsertRowid);
    insertPublishedPanzhiSourceResult(database, scanRunId);
    const completed = repository.completePublished({
      jobId: claimed.job.id,
      bearerToken: claimed.bearerToken,
      canonicalBodyDigest: bodyDigest,
      result: { ...result, scanRunId },
      scanRunId,
      now: start
    });
    expect(database.isTransaction).toBe(true);
    database.exec("COMMIT");

    expect(completed.job).toMatchObject({
      state: "success",
      scanRunId,
      leaseExpiresAt: null
    });
    expectRepositoryError(() => repository.getAuthorizedJobForSnapshot(
      claimed.job.id,
      claimed.bearerToken,
      bodyDigest,
      plus(1)
    ), "unauthorized");
    expectRepositoryError(() => repository.heartbeat(
      claimed.job.id,
      claimed.bearerToken,
      plus(1)
    ), "unauthorized");
    expectRepositoryError(() => repository.transition(
      claimed.job.id,
      claimed.bearerToken,
      "failed",
      { error: "should_not_work" },
      plus(1)
    ), "unauthorized");
    expectRepositoryError(() => repository.cancel(
      claimed.job.id,
      claimed.bearerToken,
      plus(1)
    ), "unauthorized");
    expect(repository.findSuccessfulReplay(
      claimed.job.id,
      claimed.bearerToken,
      bodyDigest
    )).toEqual({ ...result, scanRunId });
    const conflictingBodyDigest = digest("different-body");
    const conflict = expectRepositoryError(() =>
      repository.findSuccessfulReplay(
      claimed.job.id,
      claimed.bearerToken,
      conflictingBodyDigest
      ),
      "conflict"
    );
    const wrongBearerToken = "wrong-token";
    const unauthorized = expectRepositoryError(() =>
      repository.findSuccessfulReplay(
      claimed.job.id,
      wrongBearerToken,
      bodyDigest
      ),
      "unauthorized"
    );
    const notFound = expectRepositoryError(() =>
      repository.findSuccessfulReplay(
      "00000000-0000-4000-8000-000000000000",
      claimed.bearerToken,
      bodyDigest
      ),
      "not_found"
    );
    for (const error of [conflict, unauthorized, notFound]) {
      for (const secret of [
        claimed.bearerToken,
        wrongBearerToken,
        bodyDigest,
        conflictingBodyDigest
      ]) {
        expect(error.message).not.toContain(secret);
      }
    }
  });

  it("returns no successful replay while a job is still active", () => {
    const { repository, claimed } = claimedRepository();

    expect(repository.findSuccessfulReplay(
      claimed.job.id,
      claimed.bearerToken,
      digest("active-request")
    )).toBeNull();
  });

  it("rejects repository completion without a published Panzhi source result", () => {
    const { database, repository, claimed } = claimedRepository();
    repository.transition(claimed.job.id, claimed.bearerToken, "applying_filters", {}, start);
    repository.transition(claimed.job.id, claimed.bearerToken, "collecting", {}, start);
    repository.transition(claimed.job.id, claimed.bearerToken, "submitting", {}, start);

    database.exec("BEGIN IMMEDIATE");
    try {
      const run = database.prepare(`
        INSERT INTO scan_runs (
          started_at, finished_at, state, is_baseline,
          scope, requested_source
        ) VALUES (?, ?, 'success', 0, 'single_source', 'panzhi')
      `).run(start.toISOString(), start.toISOString());
      expectRepositoryError(() => repository.completePublished({
        jobId: claimed.job.id,
        bearerToken: claimed.bearerToken,
        canonicalBodyDigest: digest("missing-source-result"),
        result: { ok: true },
        scanRunId: Number(run.lastInsertRowid),
        now: start
      }), "conflict");
    } finally {
      database.exec("ROLLBACK");
    }
  });

  it("rejects direct SQL success without a published Panzhi source result", () => {
    const { database, repository, claimed } = claimedRepository();
    repository.transition(claimed.job.id, claimed.bearerToken, "applying_filters", {}, start);
    repository.transition(claimed.job.id, claimed.bearerToken, "collecting", {}, start);
    repository.transition(claimed.job.id, claimed.bearerToken, "submitting", {}, start);

    database.exec("BEGIN IMMEDIATE");
    try {
      const run = database.prepare(`
        INSERT INTO scan_runs (
          started_at, finished_at, state, is_baseline,
          scope, requested_source
        ) VALUES (?, ?, 'success', 0, 'single_source', 'panzhi')
      `).run(start.toISOString(), start.toISOString());
      expect(() => database.prepare(`
        UPDATE panzhi_browser_jobs
        SET state = 'success',
            lease_token_digest = NULL,
            lease_expires_at = NULL,
            completed_bearer_digest = ?,
            normalized_request_digest = ?,
            result_json = '{}',
            scan_run_id = ?,
            finished_at = ?
        WHERE id = ?
      `).run(
        digest(claimed.bearerToken),
        digest("direct-sql-body"),
        Number(run.lastInsertRowid),
        start.toISOString(),
        claimed.job.id
      )).toThrow();
    } finally {
      database.exec("ROLLBACK");
    }
  });

  it.each(["unpublish", "delete", "replace"] as const)(
    "prevents %s of a source result linked to a successful job",
    (operation) => {
      const { database, repository, claimed } = claimedRepository();
      repository.transition(claimed.job.id, claimed.bearerToken, "applying_filters", {}, start);
      repository.transition(claimed.job.id, claimed.bearerToken, "collecting", {}, start);
      repository.transition(claimed.job.id, claimed.bearerToken, "submitting", {}, start);
      database.exec("BEGIN IMMEDIATE");
      const run = database.prepare(`
        INSERT INTO scan_runs (
          started_at, finished_at, state, is_baseline,
          scope, requested_source
        ) VALUES (?, ?, 'success', 0, 'single_source', 'panzhi')
      `).run(start.toISOString(), start.toISOString());
      const scanRunId = Number(run.lastInsertRowid);
      insertPublishedPanzhiSourceResult(database, scanRunId);
      repository.completePublished({
        jobId: claimed.job.id,
        bearerToken: claimed.bearerToken,
        canonicalBodyDigest: digest(`linked-source:${operation}`),
        result: { ok: true },
        scanRunId,
        now: start
      });
      database.exec("COMMIT");

      expect(() => {
        if (operation === "unpublish") {
          database.prepare(`
            UPDATE scan_source_results
            SET published = 0
            WHERE run_id = ? AND source = 'panzhi'
          `).run(scanRunId);
        } else if (operation === "delete") {
          database.prepare(`
            DELETE FROM scan_source_results
            WHERE run_id = ? AND source = 'panzhi'
          `).run(scanRunId);
        } else {
          database.prepare(`
            INSERT OR REPLACE INTO scan_source_results (
              run_id, source, state, pages_scanned,
              observed_item_count, eligible_count,
              balanced_candidate_count, global_candidate_count,
              published
            ) VALUES (?, 'panzhi', 'success', 1, 1, 1, 0, 0, 0)
          `).run(scanRunId);
        }
      }).toThrow();
    }
  );

  it("rolls back completion with its caller-owned transaction", () => {
    const { database, repository, claimed } = claimedRepository();
    repository.transition(claimed.job.id, claimed.bearerToken, "applying_filters", {}, start);
    repository.transition(claimed.job.id, claimed.bearerToken, "collecting", {}, start);
    repository.transition(claimed.job.id, claimed.bearerToken, "submitting", {}, start);

    database.exec("BEGIN IMMEDIATE");
    const run = database.prepare(`
      INSERT INTO scan_runs (
        started_at, finished_at, state, is_baseline,
        scope, requested_source
      ) VALUES (?, ?, 'success', 0, 'single_source', 'panzhi')
    `).run(start.toISOString(), start.toISOString());
    insertPublishedPanzhiSourceResult(database, Number(run.lastInsertRowid));
    repository.completePublished({
      jobId: claimed.job.id,
      bearerToken: claimed.bearerToken,
      canonicalBodyDigest: digest("rollback-body"),
      result: { ok: true },
      scanRunId: Number(run.lastInsertRowid),
      now: start
    });
    database.exec("ROLLBACK");

    expect(repository.getJob(claimed.job.id)).toMatchObject({
      state: "submitting",
      scanRunId: null
    });
  });

  it("records an unpublished failure inside the caller-owned transaction", () => {
    const { database, repository, claimed } = claimedRepository();
    repository.transition(claimed.job.id, claimed.bearerToken, "applying_filters", {}, start);
    repository.transition(claimed.job.id, claimed.bearerToken, "collecting", {}, start);
    repository.transition(claimed.job.id, claimed.bearerToken, "submitting", {}, start);

    database.exec("BEGIN IMMEDIATE");
    const failed = repository.completeUnpublished({
      jobId: claimed.job.id,
      bearerToken: claimed.bearerToken,
      error: "snapshot_rejected",
      now: start
    });
    expect(database.isTransaction).toBe(true);
    database.exec("COMMIT");

    expect(failed.job).toMatchObject({
      state: "failed",
      error: "snapshot_rejected",
      scanRunId: null
    });
  });

  it("uses savepoints without taking ownership of an outer transaction", () => {
    const database = createDatabase(":memory:");
    const repository = new PanzhiAutomationRepository(database);

    database.exec("BEGIN IMMEDIATE");
    repository.recordExtensionHeartbeat(start);
    const enqueued = repository.enqueue("quick", start);
    const claimed = repository.claim(start)!;
    expectRepositoryError(() => repository.transition(
      claimed.job.id,
      claimed.bearerToken,
      "success",
      {},
      start
    ), "invalid_transition");

    expect(database.isTransaction).toBe(true);
    expect(repository.getJob(enqueued.job.id)?.state).toBe("opening_page");
    database.exec("ROLLBACK");
    expect(repository.getJob(enqueued.job.id)).toBeNull();
    expect(repository.getStatus(start)).toEqual({
      connected: false,
      lastHeartbeatAt: null,
      currentJob: null
    });
  });

  it("reopens a file database with idempotent Panzhi migrations", () => {
    const directory = mkdtempSync(join(tmpdir(), "panzhi-automation-db-"));
    const databasePath = join(directory, "automation.sqlite");
    try {
      const first = createDatabase(databasePath);
      first.close();

      const second = createDatabase(databasePath);
      const repository = new PanzhiAutomationRepository(second);
      const enqueued = repository.enqueue("quick", start);
      second.close();

      const reopened = createDatabase(databasePath);
      try {
        expect(new PanzhiAutomationRepository(reopened).getJob(
          enqueued.job.id
        )).toMatchObject({ state: "queued", mode: "quick" });
        expect(reopened.prepare(`
          SELECT name
          FROM sqlite_master
          WHERE type = 'trigger' AND name LIKE 'panzhi_%'
          ORDER BY name
        `).all()).toHaveLength(5);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
