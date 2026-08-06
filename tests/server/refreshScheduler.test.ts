import { describe, expect, it, vi } from "vitest";
import {
  BrowserRefreshRepository
} from "../../src/server/browserRefresh/repository.js";
import { createDatabase } from "../../src/server/db.js";
import {
  PanzhiAutomationRepository
} from "../../src/server/panzhiAutomation/repository.js";
import {
  PanzhiSnapshotPublisher
} from "../../src/server/panzhiAutomation/publisher.js";
import {
  PanzhiAutomationService
} from "../../src/server/panzhiAutomation/service.js";
import {
  RefreshAdmissionController
} from "../../src/server/refreshAdmission.js";
import {
  RefreshScheduleRepository,
  RefreshScheduler
} from "../../src/server/refreshScheduler.js";
import { RefreshTracker } from "../../src/server/refreshTracker.js";
import {
  ListingRepository,
  type SourceStatus
} from "../../src/server/repository.js";

const baseTime = new Date("2026-08-02T00:00:00.000Z");

function schedulerFixture() {
  let current = new Date(baseTime);
  const database = createDatabase(":memory:");
  const listings = new ListingRepository(database);
  const schedule = new RefreshScheduleRepository(database, current);
  database.prepare(`
    UPDATE refresh_schedule SET enabled = 0 WHERE source <> 'panzhi'
  `).run();
  const tracker = new RefreshTracker(listings.getRefreshSnapshot());
  const browserRepository = new BrowserRefreshRepository(database);
  const admission = new RefreshAdmissionController({
    browserRepository,
    tracker,
    now: () => current
  });
  const automationRepository = new PanzhiAutomationRepository(database);
  const automation = new PanzhiAutomationService({
    repository: automationRepository,
    publisher: new PanzhiSnapshotPublisher(listings),
    listings,
    schedule,
    admission,
    tracker,
    now: () => current,
    random: () => 0.5
  });
  const coordinator = {
    refreshSource: vi.fn(async () => "success" as const)
  };
  const scheduler = new RefreshScheduler(
    schedule,
    listings,
    coordinator,
    tracker,
    admission,
    automation,
    {
      now: () => current,
      random: () => 0.5
    }
  );
  return {
    database,
    listings,
    schedule,
    automationRepository,
    automation,
    admission,
    coordinator,
    tracker,
    scheduler,
    setNow: (next: Date) => {
      current = new Date(next);
    }
  };
}

function seedCompletePanzhiBaseline(
  fixture: ReturnType<typeof schedulerFixture>
): void {
  const runId = fixture.listings.startScopedScan("panzhi", baseTime);
  fixture.listings.commitScanRefresh(runId, [], [{
    source: "panzhi",
    state: "success",
    attemptedAt: baseTime,
    itemCount: 0,
    metadata: {
      pagesScanned: 1,
      stopReason: "end_of_pages",
      observedItemCount: 0,
      coverage: "full",
      observedListingKeys: []
    }
  }], baseTime);
}

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
    observedItemCount: 100,
    latestPublished: true,
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
        lastError: "detail_limit_reached",
        nextQuickAt: "2026-08-02T01:05:00.000Z"
      });
  });

  it("schedules a five-minute top-up after reaching the detail budget", () => {
    const database = createDatabase(":memory:");
    const schedule = new RefreshScheduleRepository(database, baseTime);

    schedule.markStarted("jiaoyimao", "quick", baseTime);
    schedule.markFinished(
      "jiaoyimao",
      "quick",
      "partial",
      "detail_limit_reached",
      baseTime,
      () => 0.5
    );

    expect(schedule.list().find(({ source }) => source === "jiaoyimao"))
      .toMatchObject({
        lastState: "partial",
        consecutiveFailures: 0,
        backoffUntil: null,
        nextQuickAt: "2026-08-02T00:05:00.000Z"
      });
  });

  it("keeps the original start time when a queued quick job upgrades to deep", () => {
    const fixture = schedulerFixture();
    seedCompletePanzhiBaseline(fixture);
    const quick = fixture.scheduler.trigger("panzhi", "quick");
    expect(quick.kind).toBe("queued");
    const startedAt = fixture.schedule.list().find(
      ({ source }) => source === "panzhi"
    )!.lastStartedAt;
    fixture.setNow(new Date("2026-08-02T00:05:00.000Z"));

    const upgraded = fixture.scheduler.trigger("panzhi", "deep");

    expect(upgraded).toEqual({
      kind: "queued",
      jobId: quick.kind === "queued" ? quick.jobId : "unreachable",
      source: "panzhi",
      mode: "deep"
    });
    expect(fixture.schedule.list().find(({ source }) => source === "panzhi"))
      .toMatchObject({
        lastStartedAt: startedAt,
        lastMode: "deep",
        lastState: "running"
      });
  });

  it("queues a due initial quick refresh as one deep job and coalesces later ticks", async () => {
    const fixture = schedulerFixture();
    fixture.setNow(new Date("2026-08-02T02:00:00.000Z"));
    const before = fixture.schedule.list().find(
      ({ source }) => source === "panzhi"
    )!;

    await fixture.scheduler.tick();
    const first = fixture.automationRepository.getCurrentJob();
    await fixture.scheduler.tick();

    expect(first).toMatchObject({ mode: "deep", state: "queued" });
    expect(fixture.automationRepository.getCurrentJob()).toMatchObject({
      id: first!.id,
      mode: "deep",
      state: "queued"
    });
    expect(fixture.database.prepare(`
      SELECT COUNT(*) AS count FROM panzhi_browser_jobs
    `).get()).toEqual({ count: 1 });
    expect(fixture.schedule.list().find(({ source }) => source === "panzhi"))
      .toMatchObject({
        lastState: "running",
        nextQuickAt: before.nextQuickAt,
        nextDeepAt: before.nextDeepAt
      });
  });

  it("keeps a due deep cadence pending while an active quick job collects", () => {
    const fixture = schedulerFixture();
    seedCompletePanzhiBaseline(fixture);
    const queued = fixture.scheduler.trigger("panzhi", "quick");
    expect(queued.kind).toBe("queued");
    const claimed = fixture.automation.claim()!;
    fixture.automation.updateState(
      claimed.job.id,
      claimed.bearerToken,
      { state: "applying_filters" }
    );
    fixture.automation.updateState(
      claimed.job.id,
      claimed.bearerToken,
      { state: "collecting" }
    );
    const dueAt = new Date("2026-08-03T00:00:00.000Z");
    fixture.setNow(dueAt);
    fixture.database.prepare(`
      UPDATE refresh_schedule
      SET next_deep_at = ?, last_state = 'idle'
      WHERE source = 'panzhi'
    `).run(dueAt.toISOString());

    expect(fixture.schedule.nextDue(dueAt)).toBeNull();

    fixture.database.prepare(`
      UPDATE panzhi_browser_jobs
      SET state = 'cancelled', lease_token_digest = NULL,
          lease_expires_at = NULL, finished_at = ?, updated_at = ?
      WHERE id = ?
    `).run(dueAt.toISOString(), dueAt.toISOString(), claimed.job.id);

    expect(fixture.schedule.nextDue(dueAt)).toEqual({
      source: "panzhi",
      mode: "deep"
    });
  });

  it("persists an early manual deep request while a quick job collects", () => {
    const fixture = schedulerFixture();
    seedCompletePanzhiBaseline(fixture);
    const queued = fixture.scheduler.trigger("panzhi", "quick");
    expect(queued.kind).toBe("queued");
    const claimed = fixture.automation.claim()!;
    fixture.automation.updateState(
      claimed.job.id,
      claimed.bearerToken,
      { state: "applying_filters" }
    );
    fixture.automation.updateState(
      claimed.job.id,
      claimed.bearerToken,
      { state: "collecting" }
    );
    const before = fixture.schedule.list().find(
      ({ source }) => source === "panzhi"
    )!;
    const requestedAt = new Date("2026-08-02T00:01:00.000Z");
    fixture.setNow(requestedAt);

    const deferred = fixture.scheduler.trigger("panzhi", "deep");

    expect(deferred).toEqual({
      kind: "queued",
      jobId: claimed.job.id,
      source: "panzhi",
      mode: "quick"
    });
    expect(fixture.schedule.list().find(({ source }) => source === "panzhi"))
      .toMatchObject({
        lastStartedAt: before.lastStartedAt,
        lastMode: "quick",
        nextQuickAt: before.nextQuickAt,
        nextDeepAt: requestedAt.toISOString()
      });

    const completedAt = new Date("2026-08-02T00:01:01.000Z");
    fixture.database.prepare(`
      UPDATE panzhi_browser_jobs
      SET state = 'cancelled', lease_token_digest = NULL,
          lease_expires_at = NULL, finished_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      completedAt.toISOString(),
      completedAt.toISOString(),
      claimed.job.id
    );
    fixture.schedule.markAutomationFinished(
      "panzhi",
      "quick",
      "success",
      null,
      completedAt,
      () => 0.5
    );

    expect(fixture.schedule.nextDue(completedAt)).toEqual({
      source: "panzhi",
      mode: "deep"
    });
  });

  it("reconciles a persisted nonterminal Panzhi job as running on restart", () => {
    const fixture = schedulerFixture();
    const queued = fixture.automation.enqueue("deep");
    const before = fixture.schedule.list().find(
      ({ source }) => source === "panzhi"
    )!;
    fixture.database.prepare(`
      UPDATE refresh_schedule
      SET last_state = 'attention_required', last_mode = 'quick',
          last_error = 'scheduler_restarted', attention_required = 1
      WHERE source = 'panzhi'
    `).run();

    const restarted = new RefreshScheduleRepository(
      fixture.database,
      new Date("2026-08-02T00:05:00.000Z")
    );

    expect(restarted.list().find(({ source }) => source === "panzhi"))
      .toMatchObject({
        lastState: "running",
        lastMode: queued.job.mode,
        lastError: null,
        attentionRequired: false,
        nextQuickAt: before.nextQuickAt,
        nextDeepAt: before.nextDeepAt
      });
    expect(restarted.nextDue(new Date("2026-08-03T00:00:00.000Z")))
      .not.toEqual(expect.objectContaining({ source: "panzhi" }));
  });

  it("migrates a legacy Panzhi attention row to an automatic due tick", async () => {
    const fixture = schedulerFixture();
    const startupAt = new Date("2026-08-02T00:05:00.000Z");
    const legacyNextDeepAt = fixture.schedule.list().find(
      ({ source }) => source === "panzhi"
    )!.nextDeepAt;
    fixture.database.prepare(`
      UPDATE refresh_schedule
      SET last_state = 'attention_required', attention_required = 1,
          last_error = 'browser_snapshot_required',
          next_quick_at = '2026-08-02T02:00:00.000Z'
      WHERE source = 'panzhi'
    `).run();
    fixture.setNow(startupAt);

    const restarted = new RefreshScheduleRepository(
      fixture.database,
      startupAt
    );

    expect(fixture.automationRepository.getCurrentJob()).toBeNull();
    expect(restarted.list().find(({ source }) => source === "panzhi"))
      .toMatchObject({
        lastState: "idle",
        attentionRequired: false,
        lastError: null,
        nextQuickAt: startupAt.toISOString(),
        nextDeepAt: legacyNextDeepAt
      });

    const scheduler = new RefreshScheduler(
      restarted,
      fixture.listings,
      fixture.coordinator,
      fixture.tracker,
      fixture.admission,
      fixture.automation,
      {
        now: () => startupAt,
        random: () => 0.5
      }
    );
    await scheduler.tick();

    expect(fixture.automationRepository.getCurrentJob()).toMatchObject({
      mode: "deep",
      state: "queued"
    });
    expect(restarted.list().find(({ source }) => source === "panzhi"))
      .toMatchObject({
        lastState: "running",
        attentionRequired: false,
        nextQuickAt: startupAt.toISOString(),
        nextDeepAt: legacyNextDeepAt
      });
  });

  it("advances only the successful automation mode cadence", () => {
    const database = createDatabase(":memory:");
    const schedule = new RefreshScheduleRepository(database, baseTime);
    const before = schedule.list().find(({ source }) => source === "panzhi")!;
    const completedAt = new Date("2026-08-02T01:00:00.000Z");

    schedule.markAutomationFinished(
      "panzhi",
      "quick",
      "success",
      null,
      completedAt,
      () => 0.5
    );

    expect(schedule.list().find(({ source }) => source === "panzhi"))
      .toMatchObject({
        nextQuickAt: "2026-08-02T03:00:00.000Z",
        nextDeepAt: before.nextDeepAt,
        lastState: "success"
      });
  });

  it("backs off automation failures without replacing the trusted snapshot or cadence", () => {
    const fixture = schedulerFixture();
    seedCompletePanzhiBaseline(fixture);
    const before = fixture.schedule.list().find(
      ({ source }) => source === "panzhi"
    )!;
    const listingsBefore = fixture.listings.getListings();

    fixture.schedule.markAutomationFailedWithoutAdvancing(
      "panzhi",
      "deep",
      "failed",
      "page_structure_changed",
      baseTime,
      () => 0.5
    );

    expect(fixture.schedule.list().find(({ source }) => source === "panzhi"))
      .toMatchObject({
        lastState: "failed",
        consecutiveFailures: 1,
        backoffUntil: "2026-08-02T00:05:00.000Z",
        nextQuickAt: before.nextQuickAt,
        nextDeepAt: before.nextDeepAt
      });
    expect(fixture.listings.getListings()).toEqual(listingsBefore);
  });

  it("keeps other-source admission conflicts unchanged", () => {
    const fixture = schedulerFixture();
    const active = fixture.admission.withAllSourcesLease(() => undefined);
    expect(active.kind).toBe("acquired");

    expect(fixture.scheduler.trigger("pxb7", "quick")).toEqual({
      kind: "conflict",
      activeKind: "all_sources"
    });

    if (active.kind === "acquired") active.lease.release();
  });

  it("queues manual Panzhi quick and deep refreshes without advancing cadence", () => {
    const quick = schedulerFixture();
    seedCompletePanzhiBaseline(quick);
    const quickBefore = quick.schedule.list().find(
      ({ source }) => source === "panzhi"
    )!;

    const quickResult = quick.scheduler.trigger("panzhi", "quick");

    expect(quickResult).toEqual({
      kind: "queued",
      jobId: expect.any(String),
      source: "panzhi",
      mode: "quick"
    });
    expect(quick.schedule.list().find(({ source }) => source === "panzhi"))
      .toMatchObject({
        lastState: "running",
        lastMode: "quick",
        nextQuickAt: quickBefore.nextQuickAt,
        nextDeepAt: quickBefore.nextDeepAt
      });

    const deep = schedulerFixture();
    const deepBefore = deep.schedule.list().find(
      ({ source }) => source === "panzhi"
    )!;

    const deepResult = deep.scheduler.trigger("panzhi", "deep");

    expect(deepResult).toEqual({
      kind: "queued",
      jobId: expect.any(String),
      source: "panzhi",
      mode: "deep"
    });
    expect(deep.schedule.list().find(({ source }) => source === "panzhi"))
      .toMatchObject({
        lastState: "running",
        lastMode: "deep",
        nextQuickAt: deepBefore.nextQuickAt,
        nextDeepAt: deepBefore.nextDeepAt
      });
  });
});
