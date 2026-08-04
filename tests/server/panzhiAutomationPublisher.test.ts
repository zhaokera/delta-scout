// @vitest-environment node

import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { createDatabase } from "../../src/server/db.js";
import type { PanzhiBrowserSnapshot } from "../../src/server/panzhiBrowserSnapshot.js";
import {
  PanzhiSnapshotPublisher,
  PanzhiSnapshotPublisherError
} from "../../src/server/panzhiAutomation/publisher.js";
import {
  PanzhiAutomationRepositoryError
} from "../../src/server/panzhiAutomation/repository.js";
import { ListingRepository } from "../../src/server/repository.js";

const firstCapture = new Date("2026-08-01T08:00:00.000Z");
const secondCapture = new Date("2026-08-01T09:00:00.000Z");
const panzhiJobId = "00000000-0000-4000-8000-000000000001";

type SnapshotItem = PanzhiBrowserSnapshot["items"][number];

if (false) {
  const repository = null as unknown as ListingRepository;
  const publisher = null as unknown as PanzhiSnapshotPublisher;
  // @ts-expect-error Transaction operations must not return promises.
  repository.runInTransaction(async () => undefined);
  // @ts-expect-error Completion hooks must not return promises.
  publisher.publish({}, firstCapture, async () => undefined);
}

function item(
  sourceListingId: string,
  priceCny = 2_888
): SnapshotItem {
  return {
    sourceListingId,
    url: `https://www.pzds.com/goodsDetails/${sourceListingId}/6`,
    title: `${sourceListingId} M7 棱镜攻势账号`,
    rawText:
      "总资产365M 哈夫币478w M7棱镜攻势(极品B) " +
      "骇爪-维什戴尔 露娜-黑天际线 " +
      `QQ可二次实名 找回包赔 ¥ ${priceCny}`,
    priceCny
  };
}

function snapshot(
  items: SnapshotItem[],
  overrides: Omit<
    Partial<PanzhiBrowserSnapshot>,
    "items" | "observedUniqueCount"
  > = {}
): PanzhiBrowserSnapshot {
  return {
    filterProof: {
      currentUrl: "https://www.pzds.com/goodsList/391/6",
      gameLabel: "三角洲行动",
      minPriceInput: "1900",
      maxPriceInput: "4000",
      secondRealNameFilter: {
        label: "可二次实名",
        selected: true
      },
      operatorSkinFilter: {
        fieldId: "22858",
        fieldLabel: "特战干员外观",
        fieldType: "CHECKBOX",
        mappingField: "22858",
        searchType: "ALL",
        searchTypeLabel: "全部都要有",
        selectedOptions: [
          {
            optionId: "1038173",
            label: "骇爪-维什戴尔",
            metadataCode: "SA200018"
          },
          {
            optionId: "1035794",
            label: "露娜-黑天际线",
            metadataCode: "SA200003"
          }
        ]
      },
      observedAt: firstCapture.toISOString()
    },
    loadActionCount: 4,
    observedUniqueCount: items.length,
    stopReason: "no_growth_twice",
    items,
    ...overrides
  };
}

function tableRows(
  database: DatabaseSync,
  table: string,
  orderBy: string
): unknown[] {
  return JSON.parse(JSON.stringify(
    database.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all()
  )) as unknown[];
}

function count(database: DatabaseSync, table: string): number {
  return (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number;
  }).count;
}

function seedHookRows(database: DatabaseSync): void {
  database.prepare(`
    INSERT INTO panzhi_browser_jobs (
      id, mode, state, created_at, updated_at
    ) VALUES (?, 'deep', 'queued', ?, ?)
  `).run(
    panzhiJobId,
    firstCapture.toISOString(),
    firstCapture.toISOString()
  );
  database.prepare(`
    INSERT INTO refresh_schedule (
      source, enabled, quick_interval_minutes, deep_interval_minutes,
      next_quick_at, next_deep_at
    ) VALUES ('panzhi', 1, 15, 240, ?, ?)
  `).run(
    "2026-08-01T10:00:00.000Z",
    "2026-08-01T12:00:00.000Z"
  );
}

describe("PanzhiSnapshotPublisher", () => {
  it("publishes a manual-style deep payload with the route response counts", () => {
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);
    const publisher = new PanzhiSnapshotPublisher(repository);

    const result = publisher.publish(snapshot([
      item("SA2INRANGE"),
      item("SA2PINNED", 50_000)
    ]), firstCapture);

    expect(result).toEqual({
      source: "panzhi",
      mode: "deep",
      state: "success",
      scanRunId: expect.any(Number),
      observedItemCount: 2,
      publishedItemCount: 1,
      preservedItemCount: 0,
      droppedByPrice: 1,
      published: true
    });
    expect(repository.getListings().map(({ sourceListingId }) =>
      sourceListingId
    )).toEqual(["SA2INRANGE"]);
    expect(repository.getScanHistory(1)[0]).toMatchObject({
      id: result.scanRunId,
      state: "success",
      scope: "single_source",
      requestedSource: "panzhi",
      sources: [expect.objectContaining({
        source: "panzhi",
        observedItemCount: 2,
        published: true,
        stopReason: "no_growth_twice"
      })]
    });
  });

  it("merges a quick payload over its complete baseline and reports observed, published, preserved, and dropped counts", () => {
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);
    const publisher = new PanzhiSnapshotPublisher(repository);
    publisher.publish(snapshot([
      item("BASE-A", 3_000),
      item("BASE-B", 2_900),
      item("BASE-C", 2_800)
    ]), firstCapture);

    const result = publisher.publish(snapshot([
      item("BASE-A", 2_500),
      item("BASE-C", 50_000)
    ], {
      mode: "quick",
      loadActionCount: 2,
      stopReason: "quick_window",
      filterProof: {
        ...snapshot([]).filterProof,
        observedAt: secondCapture.toISOString()
      }
    }), secondCapture);

    expect(result).toMatchObject({
      source: "panzhi",
      mode: "quick",
      state: "success",
      observedItemCount: 2,
      publishedItemCount: 2,
      preservedItemCount: 1,
      droppedByPrice: 1,
      published: true
    });
    expect(repository.getListings().map(({ sourceListingId }) =>
      sourceListingId
    )).toEqual(["BASE-A", "BASE-B"]);
    expect(repository.getListing("panzhi:BASE-A")?.priceCny).toBe(2_500);
    expect(repository.getListing("panzhi:BASE-B")?.priceCny).toBe(2_900);
    const history = repository.getScanHistory(1)[0];
    expect(history.sources[0]).toMatchObject({
      pagesScanned: 4,
      observedItemCount: 2,
      stopReason: "quick_window",
      published: true
    });
    expect(database.prepare(`
      SELECT listing_key FROM listing_observations
      WHERE run_id = ? ORDER BY listing_key
    `).all(result.scanRunId)).toEqual([
      { listing_key: "panzhi:BASE-A" }
    ]);
  });

  it("requires a complete baseline before quick mode without creating a scan", () => {
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);
    const publisher = new PanzhiSnapshotPublisher(repository);
    let thrown: unknown;

    try {
      publisher.publish(snapshot([item("QUICK-FIRST")], {
        mode: "quick",
        loadActionCount: 2,
        stopReason: "quick_window"
      }), firstCapture);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PanzhiSnapshotPublisherError);
    expect(thrown).toMatchObject({
      code: "panzhi_complete_snapshot_required"
    });
    expect(count(database, "scan_runs")).toBe(0);
  });

  it("does not treat captcha-limited deep listings as a complete quick baseline", () => {
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);
    const publisher = new PanzhiSnapshotPublisher(repository);
    publisher.publish(snapshot([item("CAPTCHA-ONLY")], {
      stopReason: "captcha_required"
    }), firstCapture);
    const runCount = count(database, "scan_runs");
    let thrown: unknown;

    try {
      publisher.publish(snapshot([item("QUICK-AFTER-CAPTCHA")], {
        mode: "quick",
        loadActionCount: 2,
        stopReason: "quick_window",
        filterProof: {
          ...snapshot([]).filterProof,
          observedAt: secondCapture.toISOString()
        }
      }), secondCapture);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PanzhiSnapshotPublisherError);
    expect(thrown).toMatchObject({
      code: "panzhi_complete_snapshot_required"
    });
    expect(count(database, "scan_runs")).toBe(runCount);
    expect(repository.getListings().map(({ sourceListingId }) =>
      sourceListingId
    )).toEqual(["CAPTCHA-ONLY"]);
  });

  it("accepts a trusted complete zero-item Panzhi scan as a quick baseline", () => {
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);
    const publisher = new PanzhiSnapshotPublisher(repository);
    const runId = repository.startScopedScan("panzhi", firstCapture);
    repository.commitScanRefresh(runId, [], [{
      source: "panzhi",
      state: "success",
      attemptedAt: firstCapture,
      itemCount: 0,
      metadata: {
        pagesScanned: 4,
        stopReason: "no_growth_twice",
        observedItemCount: 0,
        coverage: "full",
        observedListingKeys: []
      }
    }], firstCapture);

    const result = publisher.publish(snapshot([item("AFTER-EMPTY")], {
      mode: "quick",
      loadActionCount: 2,
      stopReason: "quick_window",
      filterProof: {
        ...snapshot([]).filterProof,
        observedAt: secondCapture.toISOString()
      }
    }), secondCapture);

    expect(result).toMatchObject({
      mode: "quick",
      state: "success",
      observedItemCount: 1,
      publishedItemCount: 1,
      preservedItemCount: 0,
      published: true
    });
    expect(repository.getListings().map(({ sourceListingId }) =>
      sourceListingId
    )).toEqual(["AFTER-EMPTY"]);
  });

  it("rejects quick mode when the latest published non-quick result is partial", () => {
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);
    const publisher = new PanzhiSnapshotPublisher(repository);
    publisher.publish(snapshot([item("FULL-BEFORE-PARTIAL")]), firstCapture);
    publisher.publish(snapshot([item("PARTIAL-LATEST")], {
      stopReason: "captcha_required",
      filterProof: {
        ...snapshot([]).filterProof,
        observedAt: secondCapture.toISOString()
      }
    }), secondCapture);
    const runCount = count(database, "scan_runs");
    let thrown: unknown;

    try {
      publisher.publish(snapshot([item("QUICK-AFTER-PARTIAL")], {
        mode: "quick",
        loadActionCount: 2,
        stopReason: "quick_window"
      }), new Date("2026-08-01T10:00:00.000Z"));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: "panzhi_complete_snapshot_required"
    });
    expect(count(database, "scan_runs")).toBe(runCount);
  });

  it("keeps the trusted complete lineage after an unpublished anomaly", () => {
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);
    const publisher = new PanzhiSnapshotPublisher(repository);
    const trustedItems = Array.from({ length: 20 }, (_, index) =>
      item(`LINEAGE-${String(index).padStart(2, "0")}`, 2_500 + index)
    );
    publisher.publish(snapshot(trustedItems, {
      loadActionCount: 10
    }), firstCapture);
    const quarantined = publisher.publish(snapshot([
      item("LINEAGE-LOW-1"),
      item("LINEAGE-LOW-2")
    ], {
      loadActionCount: 2,
      filterProof: {
        ...snapshot([]).filterProof,
        observedAt: secondCapture.toISOString()
      }
    }), secondCapture);

    const quick = publisher.publish(snapshot([trustedItems[0]], {
      mode: "quick",
      loadActionCount: 2,
      stopReason: "quick_window"
    }), new Date("2026-08-01T10:00:00.000Z"));

    expect(quarantined.published).toBe(false);
    expect(quick).toMatchObject({
      state: "success",
      published: true,
      preservedItemCount: 19
    });
  });

  it("retains the latest complete baseline while pruning more than fifty quick scans", () => {
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);
    const publisher = new PanzhiSnapshotPublisher(repository);
    const baseline = publisher.publish(
      snapshot([item("PRUNED-BASELINE")]),
      firstCapture
    );
    for (let index = 0; index < 51; index += 1) {
      const capturedAt = new Date(
        secondCapture.getTime() + index * 60_000
      );
      publisher.publish(snapshot([item("PRUNED-BASELINE")], {
        mode: "quick",
        loadActionCount: 2,
        stopReason: "quick_window",
        filterProof: {
          ...snapshot([]).filterProof,
          observedAt: capturedAt.toISOString()
        }
      }), capturedAt);
    }

    expect(database.prepare(`
      SELECT id FROM scan_runs WHERE id = ?
    `).get(baseline.scanRunId)).toEqual({ id: baseline.scanRunId });
    const nextQuick = publisher.publish(snapshot([item("PRUNED-BASELINE")], {
      mode: "quick",
      loadActionCount: 2,
      stopReason: "quick_window"
    }), new Date("2026-08-02T08:00:00.000Z"));
    expect(nextQuick.published).toBe(true);
  });

  it("uses one outer transaction and creates exactly one scoped Panzhi scan", () => {
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);
    const publisher = new PanzhiSnapshotPublisher(repository);
    const transaction = vi.spyOn(repository, "runInTransaction");
    const start = vi.spyOn(repository, "startScopedScan");

    const result = publisher.publish(
      snapshot([item("SINGLE-SCAN")]),
      firstCapture
    );

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith("panzhi", firstCapture);
    expect(tableRows(database, "scan_runs", "id")).toEqual([
      expect.objectContaining({
        id: result.scanRunId,
        state: "success",
        scope: "single_source",
        requested_source: "panzhi"
      })
    ]);
  });

  it("rejects a native async repository operation before its body starts", () => {
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);
    const unsafeRun = repository.runInTransaction.bind(repository) as (
      operation: () => unknown
    ) => unknown;
    let started = false;
    let thrown: unknown;

    try {
      unsafeRun(async () => {
        started = true;
        repository.startScopedScan("panzhi", firstCapture);
      });
    } catch (error) {
      thrown = error;
    }

    expect(started).toBe(false);
    expect(thrown).toMatchObject({
      code: "synchronous_transaction_required",
      target: "operation"
    });
    expect(count(database, "scan_runs")).toBe(0);
  });

  it("rolls back a repository operation that returns a thenable", () => {
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);
    const unsafeRun = repository.runInTransaction.bind(repository) as (
      operation: () => unknown
    ) => unknown;
    let thrown: unknown;

    try {
      unsafeRun(() => {
        repository.startScopedScan("panzhi", firstCapture);
        return Promise.resolve("not-sync");
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: "synchronous_transaction_required",
      target: "operation"
    });
    expect(count(database, "scan_runs")).toBe(0);
  });

  it("rejects a native async publisher hook before its body starts", () => {
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);
    const publisher = new PanzhiSnapshotPublisher(repository);
    const unsafePublish = publisher.publish.bind(publisher) as (
      input: unknown,
      capturedAt: Date,
      hook: () => unknown
    ) => unknown;
    let started = false;
    let thrown: unknown;

    try {
      unsafePublish(snapshot([item("ASYNC-HOOK")]), firstCapture, async () => {
        started = true;
        database.prepare(`
          UPDATE source_status SET error = 'async-started'
          WHERE source = 'panzhi'
        `).run();
      });
    } catch (error) {
      thrown = error;
    }

    expect(started).toBe(false);
    expect(thrown).toMatchObject({
      code: "synchronous_transaction_required",
      target: "before_commit"
    });
    expect(count(database, "scan_runs")).toBe(0);
    expect(repository.getListings()).toEqual([]);
  });

  it("rolls back publisher writes when a sync-shaped hook returns a thenable", () => {
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);
    const publisher = new PanzhiSnapshotPublisher(repository);
    const unsafePublish = publisher.publish.bind(publisher) as (
      input: unknown,
      capturedAt: Date,
      hook: () => unknown
    ) => unknown;
    let started = false;
    let thrown: unknown;

    try {
      unsafePublish(snapshot([item("THENABLE-HOOK")]), firstCapture, () => {
        started = true;
        return Promise.resolve("not-sync");
      });
    } catch (error) {
      thrown = error;
    }

    expect(started).toBe(true);
    expect(thrown).toMatchObject({
      code: "synchronous_transaction_required",
      target: "before_commit"
    });
    expect(count(database, "scan_runs")).toBe(0);
    expect(repository.getListings()).toEqual([]);
  });

  it("rolls back the complete publish and completion-hook job and schedule writes when the hook throws", () => {
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);
    const publisher = new PanzhiSnapshotPublisher(repository);
    publisher.publish(snapshot([item("ROLLBACK", 2_888)]), firstCapture);
    seedHookRows(database);
    const tables = {
      listings: "listing_key",
      source_status: "source",
      listing_observations: "run_id, listing_key",
      refresh_events: "id",
      scan_source_results: "run_id, source",
      scan_runs: "id",
      panzhi_browser_jobs: "id",
      refresh_schedule: "source"
    } as const;
    const before = Object.fromEntries(
      Object.entries(tables).map(([table, orderBy]) => [
        table,
        tableRows(database, table, orderBy)
      ])
    );
    const beforeObservationCount = count(database, "listing_observations");
    const beforeEventCount = count(database, "refresh_events");
    const beforeResultCount = count(database, "scan_source_results");
    const beforeRunCount = count(database, "scan_runs");

    expect(() => publisher.publish(
      snapshot([item("ROLLBACK", 2_500)], {
        filterProof: {
          ...snapshot([]).filterProof,
          observedAt: secondCapture.toISOString()
        }
      }),
      secondCapture,
      (result) => {
        expect(database.isTransaction).toBe(true);
        expect(repository.getListing("panzhi:ROLLBACK")?.priceCny).toBe(2_500);
        expect(count(database, "listing_observations")).toBe(
          beforeObservationCount + 1
        );
        expect(count(database, "refresh_events")).toBe(beforeEventCount + 1);
        expect(count(database, "scan_source_results")).toBe(
          beforeResultCount + 1
        );
        expect(count(database, "scan_runs")).toBe(beforeRunCount + 1);
        database.prepare(`
          UPDATE panzhi_browser_jobs
          SET error = 'hook-mutated', updated_at = ?
          WHERE id = ?
        `).run(secondCapture.toISOString(), panzhiJobId);
        database.prepare(`
          UPDATE refresh_schedule
          SET last_state = 'success', last_mode = 'deep',
              last_finished_at = ?
          WHERE source = 'panzhi'
        `).run(secondCapture.toISOString());
        expect(result.published).toBe(true);
        throw new Error("completion hook failed");
      }
    )).toThrow();

    for (const [table, orderBy] of Object.entries(tables)) {
      expect(tableRows(database, table, orderBy)).toEqual(before[table]);
    }
  });

  it("rolls back a real anomaly-guard mutation when the completion hook throws", () => {
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);
    const publisher = new PanzhiSnapshotPublisher(repository);
    const trustedItems = Array.from({ length: 20 }, (_, index) =>
      item(`ROLLBACK-TRUSTED-${String(index).padStart(2, "0")}`, 2_500 + index)
    );
    publisher.publish(snapshot(trustedItems, {
      loadActionCount: 10
    }), firstCapture);
    seedHookRows(database);
    const tables = {
      listings: "listing_key",
      source_status: "source",
      source_anomaly_guards: "source",
      listing_observations: "run_id, listing_key",
      refresh_events: "id",
      scan_source_results: "run_id, source",
      scan_runs: "id",
      panzhi_browser_jobs: "id",
      refresh_schedule: "source"
    } as const;
    const before = Object.fromEntries(
      Object.entries(tables).map(([table, orderBy]) => [
        table,
        tableRows(database, table, orderBy)
      ])
    );
    const beforeRunCount = count(database, "scan_runs");

    expect(() => publisher.publish(snapshot([
      item("ROLLBACK-LOW-1"),
      item("ROLLBACK-LOW-2")
    ], {
      loadActionCount: 2,
      filterProof: {
        ...snapshot([]).filterProof,
        observedAt: secondCapture.toISOString()
      }
    }), secondCapture, (result) => {
      expect(result).toMatchObject({
        state: "quarantined",
        published: false
      });
      expect(database.prepare(`
        SELECT state, baseline_item_count, baseline_pages_scanned,
               observed_item_count, observed_pages_scanned
        FROM source_anomaly_guards WHERE source = 'panzhi'
      `).get()).toEqual({
        state: "suspect",
        baseline_item_count: 20,
        baseline_pages_scanned: 10,
        observed_item_count: 2,
        observed_pages_scanned: 2
      });
      expect(database.prepare(`
        SELECT state, last_attempt_at, stop_reason
        FROM source_status WHERE source = 'panzhi'
      `).get()).toEqual({
        state: "partial",
        last_attempt_at: secondCapture.toISOString(),
        stop_reason: "anomaly_guard"
      });
      expect(count(database, "scan_runs")).toBe(beforeRunCount + 1);
      database.prepare(`
        UPDATE panzhi_browser_jobs
        SET error = 'hook-mutated', updated_at = ?
        WHERE id = ?
      `).run(secondCapture.toISOString(), panzhiJobId);
      database.prepare(`
        UPDATE refresh_schedule
        SET last_state = 'failed', last_error = 'hook-mutated'
        WHERE source = 'panzhi'
      `).run();
      throw new Error("completion hook failed after anomaly guard");
    })).toThrow();

    for (const [table, orderBy] of Object.entries(tables)) {
      expect(tableRows(database, table, orderBy)).toEqual(before[table]);
    }
  });

  it("rethrows a typed Panzhi completion error unchanged after rollback", () => {
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);
    const publisher = new PanzhiSnapshotPublisher(repository);
    const completionError = new PanzhiAutomationRepositoryError(
      "conflict",
      "completion failed"
    );
    let thrown: unknown;

    try {
      publisher.publish(
        snapshot([item("TYPED-HOOK-ERROR")]),
        firstCapture,
        () => {
          throw completionError;
        }
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(completionError);
    expect(thrown).toMatchObject({ code: "conflict" });
    expect(count(database, "scan_runs")).toBe(0);
    expect(repository.getListings()).toEqual([]);
  });

  it("calls the completion hook before commit with the final response and finished scan state", () => {
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);
    const publisher = new PanzhiSnapshotPublisher(repository);
    let seenResult: unknown;

    const result = publisher.publish(
      snapshot([item("HOOK-CONTEXT")]),
      firstCapture,
      (finalResult) => {
        seenResult = finalResult;
        expect(database.isTransaction).toBe(true);
        expect(database.prepare(`
          SELECT state, finished_at FROM scan_runs WHERE id = ?
        `).get(finalResult.scanRunId)).toEqual({
          state: "success",
          finished_at: firstCapture.toISOString()
        });
        expect(database.prepare(`
          SELECT state, published FROM scan_source_results
          WHERE run_id = ? AND source = 'panzhi'
        `).get(finalResult.scanRunId)).toEqual({
          state: "success",
          published: 1
        });
        expect(finalResult).toEqual({
          source: "panzhi",
          mode: "deep",
          state: "success",
          scanRunId: finalResult.scanRunId,
          observedItemCount: 1,
          publishedItemCount: 1,
          preservedItemCount: 0,
          droppedByPrice: 0,
          published: true
        });
      }
    );

    expect(seenResult).toEqual(result);
  });

  it("quarantines an anomalous deep drop, retains trusted listings, and lets the hook fail the job without advancing cadence", () => {
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);
    const publisher = new PanzhiSnapshotPublisher(repository);
    const trustedItems = Array.from({ length: 20 }, (_, index) =>
      item(`TRUSTED-${String(index).padStart(2, "0")}`, 2_500 + index)
    );
    publisher.publish(snapshot(trustedItems, {
      loadActionCount: 10
    }), firstCapture);
    const trustedBefore = repository.getListings().map((listing) => ({
      key: listing.key,
      sourceListingId: listing.sourceListingId,
      priceCny: listing.priceCny
    }));
    seedHookRows(database);
    const cadenceBefore = database.prepare(`
      SELECT next_quick_at, next_deep_at
      FROM refresh_schedule WHERE source = 'panzhi'
    `).get();

    const result = publisher.publish(snapshot([
      item("LOW-1"),
      item("LOW-2")
    ], {
      loadActionCount: 2,
      filterProof: {
        ...snapshot([]).filterProof,
        observedAt: secondCapture.toISOString()
      }
    }), secondCapture, (finalResult) => {
      expect(finalResult).toMatchObject({
        state: "quarantined",
        published: false,
        publishedItemCount: 0,
        preservedItemCount: 0
      });
      expect(database.prepare(`
        SELECT state FROM scan_runs WHERE id = ?
      `).get(finalResult.scanRunId)).toEqual({ state: "partial" });
      expect(database.prepare(`
        SELECT state, published, anomaly_state
        FROM scan_source_results
        WHERE run_id = ? AND source = 'panzhi'
      `).get(finalResult.scanRunId)).toEqual({
        state: "partial",
        published: 0,
        anomaly_state: "suspect"
      });
      database.prepare(`
        UPDATE panzhi_browser_jobs
        SET state = 'failed', error = 'anomaly_guard',
            updated_at = ?, finished_at = ?
        WHERE id = ?
      `).run(
        secondCapture.toISOString(),
        secondCapture.toISOString(),
        panzhiJobId
      );
      database.prepare(`
        UPDATE refresh_schedule
        SET last_state = 'failed', last_mode = 'deep',
            last_finished_at = ?, consecutive_failures =
              consecutive_failures + 1,
            last_error = 'anomaly_guard'
        WHERE source = 'panzhi'
      `).run(secondCapture.toISOString());
    });

    expect(result).toMatchObject({
      state: "quarantined",
      published: false,
      observedItemCount: 2,
      publishedItemCount: 0,
      preservedItemCount: 0,
      droppedByPrice: 0
    });
    expect(repository.getListings().map((listing) => ({
      key: listing.key,
      sourceListingId: listing.sourceListingId,
      priceCny: listing.priceCny
    }))).toEqual(trustedBefore);
    expect(database.prepare(`
      SELECT state, error FROM panzhi_browser_jobs WHERE id = ?
    `).get(panzhiJobId)).toEqual({
      state: "failed",
      error: "anomaly_guard"
    });
    expect(database.prepare(`
      SELECT next_quick_at, next_deep_at
      FROM refresh_schedule WHERE source = 'panzhi'
    `).get()).toEqual(cadenceBefore);
  });

  it("publishes a captcha-limited payload as a partial scan", () => {
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);
    const publisher = new PanzhiSnapshotPublisher(repository);

    const result = publisher.publish(snapshot([item("CAPTCHA")], {
      stopReason: "captcha_required"
    }), firstCapture);

    expect(result).toMatchObject({
      state: "partial",
      published: true,
      publishedItemCount: 1
    });
    expect(repository.getScanHistory(1)[0]).toMatchObject({
      id: result.scanRunId,
      state: "partial",
      sources: [expect.objectContaining({
        state: "partial",
        stopReason: "captcha_required",
        error: "captcha_required",
        published: true
      })]
    });
  });
});
