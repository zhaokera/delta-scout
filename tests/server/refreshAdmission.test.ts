// @vitest-environment node

import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  BrowserRefreshRepository,
  BrowserRefreshRepositoryError
} from "../../src/server/browserRefresh/repository.js";
import { createDatabase } from "../../src/server/db.js";
import {
  RefreshAdmissionController
} from "../../src/server/refreshAdmission.js";
import { RefreshTracker } from "../../src/server/refreshTracker.js";
import { ListingRepository } from "../../src/server/repository.js";

const now = new Date("2026-07-30T10:00:00.000Z");

function setup(clock: { value: Date } = { value: now }) {
  const database = createDatabase(":memory:");
  const listingRepository = new ListingRepository(database);
  const browserRepository = new BrowserRefreshRepository(database);
  const tracker = new RefreshTracker(
    listingRepository.getRefreshSnapshot()
  );
  const controller = new RefreshAdmissionController({
    browserRepository,
    tracker,
    now: () => clock.value
  });
  return {
    database,
    listingRepository,
    browserRepository,
    tracker,
    controller
  };
}

function rowCount(database: DatabaseSync, table: string): number {
  return (
    database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      count: number;
    }
  ).count;
}

describe("RefreshAdmissionController", () => {
  it("conflicts browser work behind all-source work, then acquires after release", () => {
    const { browserRepository, controller } = setup();
    const allSources = controller.withAllSourcesLease(() => 41);
    expect(allSources).toMatchObject({
      kind: "acquired",
      value: 41
    });

    expect(
      controller.withBrowserLease(() =>
        browserRepository.createJob(now)
      )
    ).toEqual({
      kind: "conflict",
      activeKind: "all_sources"
    });

    if (allSources.kind !== "acquired") {
      throw new Error("expected all-source admission");
    }
    allSources.lease.release();
    expect(
      controller.withBrowserLease(() =>
        browserRepository.createJob(now)
      ).kind
    ).toBe("acquired");
  });

  it("conflicts all-source work behind browser work without exposing its full ID", () => {
    const { browserRepository, controller } = setup();
    const browser = controller.withBrowserLease(() =>
      browserRepository.createJob(now)
    );
    if (browser.kind !== "acquired") {
      throw new Error("expected browser admission");
    }

    const conflict = controller.withAllSourcesLease(() => 42);
    expect(conflict).toMatchObject({
      kind: "conflict",
      activeKind: "browser",
      jobId: expect.any(String)
    });
    if (conflict.kind !== "conflict") {
      throw new Error("expected admission conflict");
    }
    expect(conflict.jobId).not.toBe(browser.value.id);
    expect(conflict.jobId).not.toContain(browser.value.id);
    expect(JSON.stringify(conflict)).not.toMatch(
      /claim|bridge|permit|credential|hash/i
    );

    browserRepository.transition(
      browser.value.id,
      ["awaiting_codex"],
      "cancelled",
      { reason: "user_cancelled" },
      now
    );
    controller.releaseBrowser(browser.value.id);
    expect(controller.withAllSourcesLease(() => 42)).toMatchObject({
      kind: "acquired",
      value: 42
    });
  });

  it("admits exactly one of two simultaneous refresh kinds", async () => {
    const { browserRepository, controller } = setup();
    const [allSources, browser] = await Promise.all([
      Promise.resolve().then(() =>
        controller.withAllSourcesLease(() => "all")
      ),
      Promise.resolve().then(() =>
        controller.withBrowserLease(() =>
          browserRepository.createJob(now)
        )
      )
    ]);

    expect(
      [allSources.kind, browser.kind].sort()
    ).toEqual(["acquired", "conflict"]);
  });

  it("releases the browser reservation when job insertion fails", () => {
    const { database, browserRepository, controller } = setup();
    database.exec(`
      CREATE TRIGGER fail_browser_job_insert
      BEFORE INSERT ON browser_refresh_jobs
      BEGIN
        SELECT RAISE(ABORT, 'forced browser insert failure');
      END
    `);

    expect(() =>
      controller.withBrowserLease(() =>
        browserRepository.createJob(now)
      )
    ).toThrow(/forced browser insert failure/);
    expect(rowCount(database, "browser_refresh_jobs")).toBe(0);

    database.exec("DROP TRIGGER fail_browser_job_insert");
    expect(controller.withAllSourcesLease(() => 1).kind).toBe(
      "acquired"
    );
  });

  it("releases the browser reservation when BEGIN IMMEDIATE fails", () => {
    const { database, browserRepository, controller } = setup();
    const realExec = database.exec.bind(database);
    let failBegin = true;
    const exec = vi.spyOn(database, "exec").mockImplementation((sql) => {
      if (failBegin && sql.trim() === "BEGIN IMMEDIATE") {
        failBegin = false;
        throw new Error("forced begin failure");
      }
      return realExec(sql);
    });

    expect(() =>
      controller.withBrowserLease(() =>
        browserRepository.createJob(now)
      )
    ).toThrow(/forced begin failure/);
    expect(rowCount(database, "browser_refresh_jobs")).toBe(0);
    exec.mockRestore();

    expect(controller.withAllSourcesLease(() => 2).kind).toBe(
      "acquired"
    );
  });

  it("releases the all-source reservation when scan creation fails without leaving a run", () => {
    const {
      database,
      listingRepository,
      browserRepository,
      controller
    } = setup();
    database.exec(`
      CREATE TRIGGER fail_scan_insert
      BEFORE INSERT ON scan_runs
      BEGIN
        SELECT RAISE(ABORT, 'forced scan insert failure');
      END
    `);

    expect(() =>
      controller.withAllSourcesLease(() =>
        listingRepository.startScan(now)
      )
    ).toThrow(/forced scan insert failure/);
    expect(rowCount(database, "scan_runs")).toBe(0);

    database.exec("DROP TRIGGER fail_scan_insert");
    expect(
      controller.withBrowserLease(() =>
        browserRepository.createJob(now)
      ).kind
    ).toBe("acquired");
  });

  it("allows only one of two simultaneous browser job creations to persist", async () => {
    const { database, browserRepository, controller } = setup();
    const results = await Promise.all([
      Promise.resolve().then(() =>
        controller.withBrowserLease(() =>
          browserRepository.createJob(now)
        )
      ),
      Promise.resolve().then(() =>
        controller.withBrowserLease(() =>
          browserRepository.createJob(now)
        )
      )
    ]);

    expect(results.filter(({ kind }) => kind === "acquired")).toHaveLength(
      1
    );
    expect(results.filter(({ kind }) => kind === "conflict")).toHaveLength(
      1
    );
    expect(rowCount(database, "browser_refresh_jobs")).toBe(1);
  });

  it("releases its reservation when the persisted active-job recheck loses a race", () => {
    const { database, browserRepository, controller } = setup();
    let originalJobId: string | null = null;
    let conflict: unknown;

    try {
      controller.withBrowserLease(() => {
        const original = browserRepository.createJob(now);
        originalJobId = original.id;
        return browserRepository.createJob(now);
      });
    } catch (error) {
      conflict = error;
    }

    expect(conflict).toBeInstanceOf(BrowserRefreshRepositoryError);
    expect(conflict).toMatchObject({ code: "active_job_exists" });
    expect(originalJobId).not.toBeNull();
    expect(controller.snapshot()).toEqual({ activeKind: "none" });
    expect(rowCount(database, "browser_refresh_jobs")).toBe(1);
    expect(browserRepository.getJobRecord(originalJobId!, now)).toMatchObject({
      id: originalJobId,
      state: "awaiting_codex"
    });

    browserRepository.transition(
      originalJobId!,
      ["awaiting_codex"],
      "cancelled",
      { reason: "user_cancelled" },
      now
    );
    expect(controller.withAllSourcesLease(() => 3)).toMatchObject({
      kind: "acquired",
      value: 3
    });
  });

  it("releases its reservation when a generic browser creation callback throws", () => {
    const { controller } = setup();

    expect(() =>
      controller.withBrowserLease(() => {
        throw new Error("generic creation failure");
      })
    ).toThrow(/generic creation failure/);

    expect(controller.snapshot()).toEqual({ activeKind: "none" });
    expect(controller.withAllSourcesLease(() => 4)).toMatchObject({
      kind: "acquired",
      value: 4
    });
  });

  it("reconciles a held job that another repository read already expired", () => {
    const clock = { value: now };
    const { browserRepository, controller } = setup(clock);
    const browser = controller.withBrowserLease(() =>
      browserRepository.createJob(now)
    );
    if (browser.kind !== "acquired") {
      throw new Error("expected browser admission");
    }
    clock.value = new Date(
      new Date(browser.value.expiresAt).getTime() + 1
    );

    expect(browserRepository.getCurrentJob(clock.value)).toMatchObject({
      state: "expired"
    });
    controller.reconcile();

    expect(controller.withAllSourcesLease(() => 7)).toMatchObject({
      kind: "acquired",
      value: 7
    });
  });

  it("keeps a paused nonterminal browser job admitted", () => {
    const { browserRepository, controller } = setup();
    const browser = controller.withBrowserLease(() =>
      browserRepository.createJob(now)
    );
    if (browser.kind !== "acquired") {
      throw new Error("expected browser admission");
    }
    browserRepository.transition(
      browser.value.id,
      ["awaiting_codex"],
      "paused",
      { reason: "user_paused" },
      now
    );

    controller.reconcile();

    expect(controller.withAllSourcesLease(() => 8)).toMatchObject({
      kind: "conflict",
      activeKind: "browser"
    });
  });

  it("makes lease release idempotent and ignores the wrong browser ID", () => {
    const { browserRepository, controller } = setup();
    const browser = controller.withBrowserLease(() =>
      browserRepository.createJob(now)
    );
    if (browser.kind !== "acquired") {
      throw new Error("expected browser admission");
    }

    controller.releaseBrowser("wrong-job-id");
    expect(controller.withAllSourcesLease(() => 9).kind).toBe(
      "conflict"
    );

    browser.lease.release();
    browser.lease.release();
    expect(controller.snapshot()).toEqual({ activeKind: "none" });
    expect(controller.withAllSourcesLease(() => 9).kind).toBe(
      "conflict"
    );
  });

  it("restores browser occupation on startup and fails closed on impossible dual occupation", () => {
    const database = createDatabase(":memory:");
    const listingRepository = new ListingRepository(database);
    const browserRepository = new BrowserRefreshRepository(database);
    const created = browserRepository.createJob(now);
    const idleTracker = new RefreshTracker(
      listingRepository.getRefreshSnapshot()
    );

    const restored = new RefreshAdmissionController({
      browserRepository,
      tracker: idleTracker,
      now: () => now
    });
    expect(restored.withAllSourcesLease(() => 10)).toMatchObject({
      kind: "conflict",
      activeKind: "browser"
    });

    const runId = listingRepository.startScan(now);
    const runningTracker = new RefreshTracker(
      listingRepository.getRefreshSnapshot()
    );
    expect(runningTracker.snapshot()).toMatchObject({
      runId,
      state: "running"
    });
    expect(() =>
      new RefreshAdmissionController({
        browserRepository,
        tracker: runningTracker,
        now: () => now
      })
    ).toThrow(/refresh_admission_initialization_conflict/);
    expect(created.id).toEqual(expect.any(String));
  });

  it("restores all-source occupation from a running tracker", () => {
    const database = createDatabase(":memory:");
    const listingRepository = new ListingRepository(database);
    const browserRepository = new BrowserRefreshRepository(database);
    const runId = listingRepository.startScan(now);
    const tracker = new RefreshTracker(
      listingRepository.getRefreshSnapshot()
    );

    const restored = new RefreshAdmissionController({
      browserRepository,
      tracker,
      now: () => now
    });

    expect(restored.withBrowserLease(() =>
      browserRepository.createJob(now)
    )).toEqual({
      kind: "conflict",
      activeKind: "all_sources"
    });
    expect(tracker.snapshot()).toMatchObject({
      runId,
      state: "running"
    });
  });
});
