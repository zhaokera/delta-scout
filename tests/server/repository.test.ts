// @vitest-environment node

import { createDatabase } from "../../src/server/db.js";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listingMaterialHash } from "../../src/domain/listingFingerprint.js";
import {
  ListingRepository,
  type SourceRefreshStatusUpdate
} from "../../src/server/repository.js";
import {
  BrowserRefreshRepository
} from "../../src/server/browserRefresh/repository.js";
import {
  makeListing,
  makeScore
} from "../domain/listingFactory.js";

const scanTime = new Date("2026-07-29T10:00:00.000Z");

function successUpdate(
  source: "jiaoyimao" | "panzhi" | "pxb7",
  itemCount: number,
  state: "success" | "partial" = "success",
  pagesScanned = 1,
  attemptedAt = scanTime
): SourceRefreshStatusUpdate {
  return {
    source,
    state,
    attemptedAt,
    itemCount,
    metadata: {
      pagesScanned,
      stopReason: state === "success" ? "end_of_pages" : "error",
      error: state === "partial" ? "partial_fixture" : null
    }
  };
}

function sourceListings(
  source: "jiaoyimao" | "panzhi" | "pxb7",
  count: number,
  prefix: string
) {
  return Array.from({ length: count }, (_, index) =>
    makeListing({
      source,
      key: `${source}:${prefix}-${index}`,
      sourceListingId: `${prefix}-${index}`,
      url: `https://example.test/${source}/${prefix}-${index}`,
      score: makeScore(80)
    })
  ).sort((left, right) => left.key.localeCompare(right.key));
}

function failureUpdate(
  source: "jiaoyimao" | "panzhi" | "pxb7",
  state: "blocked" | "failed" = "failed"
): SourceRefreshStatusUpdate {
  return {
    source,
    state,
    attemptedAt: scanTime,
    error: `${source}_${state}`
  };
}

function createCommittingBrowserJob(
  database: ReturnType<typeof createDatabase>,
  now = scanTime
) {
  const browserRepository = new BrowserRefreshRepository(database);
  const created = browserRepository.createJob(now);
  browserRepository.transition(
    created.id,
    ["awaiting_codex"],
    "committing",
    { stage: "committing" },
    now
  );
  return { browserRepository, jobId: created.id };
}

describe("ListingRepository", () => {
  it("single-source browser publish preserves other sources and records only Jiaoyimao history", () => {
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);
    const oldJiaoyimao = makeListing({
      source: "jiaoyimao",
      key: "jiaoyimao:old",
      sourceListingId: "old",
      url: "https://www.jiaoyimao.com/jg2007840/100.html",
      title: "旧交易猫账号"
    });
    const panzhi = makeListing({
      source: "panzhi",
      key: "panzhi:keep",
      sourceListingId: "keep",
      url: "https://www.pzds.com/item/keep",
      title: "盼之保留字段"
    });
    const pxb7 = makeListing({
      source: "pxb7",
      key: "pxb7:keep",
      sourceListingId: "keep",
      url: "https://www.pxb7.com/item/keep",
      title: "螃蟹保留字段"
    });
    const initialRun = repository.startScan(scanTime);
    repository.commitScanRefresh(
      initialRun,
      [oldJiaoyimao, panzhi, pxb7],
      [
        successUpdate("jiaoyimao", 1),
        successUpdate("panzhi", 1),
        successUpdate("pxb7", 1)
      ],
      scanTime
    );
    const beforePanzhi = repository.getListing(panzhi.key)!;
    const beforePxb7 = repository.getListing(pxb7.key)!;
    const beforeOtherStatuses = database.prepare(`
      SELECT * FROM source_status
      WHERE source IN ('panzhi', 'pxb7')
      ORDER BY source
    `).all();
    const { browserRepository, jobId } =
      createCommittingBrowserJob(database);
    const attemptedAt = new Date(scanTime.getTime() + 1_000);
    const freshJiaoyimao = makeListing({
      source: "jiaoyimao",
      key: "jiaoyimao:fresh",
      sourceListingId: "fresh",
      url: "https://www.jiaoyimao.com/jg2007840/101.html",
      title: "新交易猫账号",
      score: makeScore(1),
      possibleDuplicateKeys: []
    });

    const result = repository.commitBrowserSourceRefresh({
      jobId,
      source: "jiaoyimao",
      listings: [freshJiaoyimao],
      attemptedAt,
      pagesScanned: 3,
      stopReason: "end_of_pages"
    });

    expect(result).toEqual({
      state: "success",
      scanRunId: expect.any(Number),
      publishedRunId: expect.any(Number)
    });
    expect(result.publishedRunId).toBe(result.scanRunId);
    expect(repository.getListing(oldJiaoyimao.key)).toBeNull();
    const afterPanzhi = repository.getListing(panzhi.key)!;
    const afterPxb7 = repository.getListing(pxb7.key)!;
    expect(afterPanzhi).toEqual({
      ...beforePanzhi,
      score: expect.any(Object),
      possibleDuplicateKeys: expect.arrayContaining([
        freshJiaoyimao.key,
        pxb7.key
      ])
    });
    expect(afterPanzhi).toMatchObject({
      key: beforePanzhi.key,
      title: beforePanzhi.title,
      sourceListingId: beforePanzhi.sourceListingId,
      score: expect.any(Object),
      possibleDuplicateKeys: expect.arrayContaining([
        freshJiaoyimao.key,
        pxb7.key
      ])
    });
    expect(afterPxb7).toEqual({
      ...beforePxb7,
      score: expect.any(Object),
      possibleDuplicateKeys: expect.arrayContaining([
        freshJiaoyimao.key,
        panzhi.key
      ])
    });
    expect(afterPxb7).toMatchObject({
      key: beforePxb7.key,
      title: beforePxb7.title,
      sourceListingId: beforePxb7.sourceListingId,
      score: expect.any(Object),
      possibleDuplicateKeys: expect.arrayContaining([
        freshJiaoyimao.key,
        panzhi.key
      ])
    });
    expect(database.prepare(`
      SELECT * FROM source_status
      WHERE source IN ('panzhi', 'pxb7')
      ORDER BY source
    `).all()).toEqual(beforeOtherStatuses);
    expect(repository.getListing(freshJiaoyimao.key)).toMatchObject({
      score: expect.any(Object),
      possibleDuplicateKeys: expect.arrayContaining([
        panzhi.key,
        pxb7.key
      ])
    });
    expect(
      database.prepare(`
        SELECT source FROM scan_source_results
        WHERE run_id = ?
      `).all(result.scanRunId)
    ).toEqual([{ source: "jiaoyimao" }]);
    expect(
      database.prepare(`
        SELECT DISTINCT source FROM listing_observations
        WHERE run_id = ?
      `).all(result.scanRunId)
    ).toEqual([{ source: "jiaoyimao" }]);
    expect(
      database.prepare(`
        SELECT listing_key, availability, trusted
        FROM listing_observations
        WHERE run_id = ?
        ORDER BY listing_key
      `).all(result.scanRunId)
    ).toEqual([
      {
        listing_key: freshJiaoyimao.key,
        availability: "active",
        trusted: 1
      },
      {
        listing_key: oldJiaoyimao.key,
        availability: "removed",
        trusted: 1
      }
    ]);
    expect(repository.getScanHistory(2)).toEqual([
      expect.objectContaining({
        id: result.scanRunId,
        scope: "single_source",
        requestedSource: "jiaoyimao"
      }),
      expect.objectContaining({
        id: initialRun,
        scope: "all_sources",
        requestedSource: null
      })
    ]);
    expect(
      repository.getSourceStatuses().find(
        ({ source }) => source === "jiaoyimao"
      )
    ).toMatchObject({
      state: "success",
      lastAttemptAt: attemptedAt.toISOString(),
      lastSuccessAt: attemptedAt.toISOString(),
      itemCount: 1,
      pagesScanned: 3,
      stopReason: "end_of_pages",
      error: null,
      anomaly: { state: "clear" }
    });
    expect(browserRepository.getJobRecord(jobId, attemptedAt)).toMatchObject({
      state: "success",
      scanRunId: result.scanRunId,
      publishedRunId: result.scanRunId
    });
  });

  it("browser quarantine preserves formal bytes and a matching second low result publishes", () => {
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);
    repository.replaceSourceSnapshot(
      "jiaoyimao",
      sourceListings("jiaoyimao", 20, "trusted"),
      "success",
      scanTime,
      { pagesScanned: 5, stopReason: "end_of_pages" }
    );
    const beforePayloads = database.prepare(`
      SELECT listing_key, payload FROM listings
      WHERE source = 'jiaoyimao'
      ORDER BY listing_key
    `).all();
    const first = createCommittingBrowserJob(database);
    const firstAttempt = new Date(scanTime.getTime() + 1_000);

    const quarantined = repository.commitBrowserSourceRefresh({
      jobId: first.jobId,
      source: "jiaoyimao",
      listings: sourceListings("jiaoyimao", 2, "low-first"),
      attemptedAt: firstAttempt,
      pagesScanned: 1,
      stopReason: "end_of_pages"
    });

    expect(quarantined).toMatchObject({
      state: "quarantined",
      publishedRunId: null
    });
    expect(database.prepare(`
      SELECT listing_key, payload FROM listings
      WHERE source = 'jiaoyimao'
      ORDER BY listing_key
    `).all()).toEqual(beforePayloads);
    expect(repository.getScanHistory(1)[0]).toMatchObject({
      state: "partial",
      scope: "single_source",
      requestedSource: "jiaoyimao",
      sources: [
        expect.objectContaining({
          source: "jiaoyimao",
          state: "partial",
          anomalyState: "suspect",
          published: false,
          observedItemCount: 2
        })
      ]
    });
    expect(
      repository.getSourceStatuses().find(
        ({ source }) => source === "jiaoyimao"
      )
    ).toMatchObject({
      state: "partial",
      lastAttemptAt: firstAttempt.toISOString(),
      lastSuccessAt: scanTime.toISOString(),
      itemCount: 20,
      pagesScanned: 5,
      stopReason: "anomaly_guard",
      anomaly: { state: "suspect" }
    });
    expect(first.browserRepository.getJobRecord(
      first.jobId,
      firstAttempt
    )).toMatchObject({
      state: "quarantined",
      reason: "anomaly_quarantined",
      lastError: "anomaly_quarantined",
      scanRunId: quarantined.scanRunId,
      publishedRunId: null
    });

    const second = createCommittingBrowserJob(database);
    const secondAttempt = new Date(scanTime.getTime() + 2_000);
    const accepted = repository.commitBrowserSourceRefresh({
      jobId: second.jobId,
      source: "jiaoyimao",
      listings: sourceListings("jiaoyimao", 2, "low-second"),
      attemptedAt: secondAttempt,
      pagesScanned: 1,
      stopReason: "no_growth_twice"
    });
    expect(accepted).toMatchObject({
      state: "success",
      publishedRunId: accepted.scanRunId
    });
    expect(
      repository.getListings().filter(
        ({ source }) => source === "jiaoyimao"
      )
    ).toHaveLength(2);
    expect(
      repository.getSourceStatuses().find(
        ({ source }) => source === "jiaoyimao"
      )
    ).toMatchObject({
      state: "success",
      itemCount: 2,
      pagesScanned: 1,
      stopReason: "no_growth_twice",
      anomaly: { state: "clear" }
    });
  });

  it("browser publisher rolls back every write when a post-listing status write fails", () => {
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);
    repository.replaceSourceSnapshot(
      "jiaoyimao",
      sourceListings("jiaoyimao", 1, "trusted"),
      "success",
      scanTime,
      { pagesScanned: 1, stopReason: "end_of_pages" }
    );
    const beforeListings = database.prepare(`
      SELECT * FROM listings ORDER BY listing_key
    `).all();
    const beforeRuns = database.prepare(`
      SELECT COUNT(*) AS count FROM scan_runs
    `).get();
    const beforeStatus = database.prepare(`
      SELECT * FROM source_status WHERE source = 'jiaoyimao'
    `).get();
    const beforeGuard = database.prepare(`
      SELECT * FROM source_anomaly_guards WHERE source = 'jiaoyimao'
    `).get();
    const { browserRepository, jobId } =
      createCommittingBrowserJob(database);
    database.exec(`
      CREATE TRIGGER fail_browser_post_listing_write
      BEFORE UPDATE ON source_status
      WHEN NEW.source = 'jiaoyimao'
        AND NEW.state = 'success'
        AND EXISTS (
          SELECT 1 FROM listings
          WHERE listing_key = 'jiaoyimao:fresh-0'
        )
      BEGIN
        SELECT RAISE(ABORT, 'injected post-listing failure');
      END;
    `);

    expect(() => repository.commitBrowserSourceRefresh({
      jobId,
      source: "jiaoyimao",
      listings: sourceListings("jiaoyimao", 1, "fresh"),
      attemptedAt: new Date(scanTime.getTime() + 1_000),
      pagesScanned: 1,
      stopReason: "end_of_pages"
    })).toThrow("无法提交交易猫浏览器刷新");

    expect(database.prepare(`
      SELECT * FROM listings ORDER BY listing_key
    `).all()).toEqual(beforeListings);
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM scan_runs
    `).get()).toEqual(beforeRuns);
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM scan_source_results
    `).get()).toEqual({ count: 0 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM listing_observations
    `).get()).toEqual({ count: 0 });
    expect(database.prepare(`
      SELECT * FROM source_status WHERE source = 'jiaoyimao'
    `).get()).toEqual(beforeStatus);
    expect(database.prepare(`
      SELECT * FROM source_anomaly_guards WHERE source = 'jiaoyimao'
    `).get()).toEqual(beforeGuard);
    expect(browserRepository.getJobRecord(
      jobId,
      new Date(scanTime.getTime() + 1_000)
    )).toMatchObject({
      state: "committing",
      scanRunId: null,
      publishedRunId: null
    });
  });

  it("does not roll back a caller transaction when nested browser publish fails", () => {
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);
    repository.replaceSourceSnapshot(
      "jiaoyimao",
      sourceListings("jiaoyimao", 1, "trusted"),
      "success",
      scanTime,
      { pagesScanned: 1, stopReason: "end_of_pages" }
    );
    const { browserRepository, jobId } =
      createCommittingBrowserJob(database);
    database.exec(`
      CREATE TABLE outer_transaction_markers (
        marker TEXT PRIMARY KEY
      );
      CREATE TRIGGER fail_nested_browser_publish
      BEFORE UPDATE ON source_status
      WHEN NEW.source = 'jiaoyimao'
        AND NEW.state = 'success'
        AND EXISTS (
          SELECT 1 FROM listings
          WHERE listing_key = 'jiaoyimao:nested-fresh-0'
        )
      BEGIN
        SELECT RAISE(ABORT, 'nested publish failure');
      END;
      BEGIN IMMEDIATE;
      INSERT INTO outer_transaction_markers (marker) VALUES ('kept');
    `);

    expect(() => repository.commitBrowserSourceRefresh({
      jobId,
      source: "jiaoyimao",
      listings: sourceListings("jiaoyimao", 1, "nested-fresh"),
      attemptedAt: new Date(scanTime.getTime() + 1_000),
      pagesScanned: 1,
      stopReason: "end_of_pages"
    })).toThrow("无法提交交易猫浏览器刷新");

    expect(database.isTransaction).toBe(true);
    expect(
      database.prepare(
        "SELECT marker FROM outer_transaction_markers"
      ).all()
    ).toEqual([{ marker: "kept" }]);
    expect(browserRepository.getJobRecord(
      jobId,
      new Date(scanTime.getTime() + 1_000)
    )).toMatchObject({
      state: "committing",
      scanRunId: null,
      publishedRunId: null
    });
    database.exec("ROLLBACK");
    expect(database.isTransaction).toBe(false);
    expect(
      database.prepare(
        "SELECT COUNT(*) AS count FROM outer_transaction_markers"
      ).get()
    ).toEqual({ count: 0 });
  });

  it("uses a savepoint for a successful nested browser publish", () => {
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);
    const { browserRepository, jobId } =
      createCommittingBrowserJob(database);
    database.exec(`
      CREATE TABLE successful_outer_markers (
        marker TEXT PRIMARY KEY
      );
      BEGIN IMMEDIATE;
      INSERT INTO successful_outer_markers (marker) VALUES ('kept');
    `);

    const result = repository.commitBrowserSourceRefresh({
      jobId,
      source: "jiaoyimao",
      listings: sourceListings("jiaoyimao", 1, "nested-success"),
      attemptedAt: new Date(scanTime.getTime() + 1_000),
      pagesScanned: 1,
      stopReason: "end_of_pages"
    });

    expect(result.state).toBe("success");
    expect(database.isTransaction).toBe(true);
    expect(
      database.prepare(
        "SELECT marker FROM successful_outer_markers"
      ).all()
    ).toEqual([{ marker: "kept" }]);
    expect(browserRepository.getJobRecord(
      jobId,
      new Date(scanTime.getTime() + 1_000)
    )).toMatchObject({
      state: "success",
      scanRunId: result.scanRunId,
      publishedRunId: result.scanRunId
    });
    database.exec("ROLLBACK");
    expect(database.isTransaction).toBe(false);
    expect(
      database.prepare(
        "SELECT COUNT(*) AS count FROM successful_outer_markers"
      ).get()
    ).toEqual({ count: 0 });
    expect(browserRepository.getJobRecord(
      jobId,
      new Date(scanTime.getTime() + 1_000)
    )).toMatchObject({
      state: "committing",
      scanRunId: null,
      publishedRunId: null
    });
    expect(repository.getScanHistory(10)).toEqual([]);
    expect(repository.getListings()).toEqual([]);
  });

  it("keeps lastSnapshotAt on the prior published run after quarantine and restart", () => {
    const directory = mkdtempSync(join(
      tmpdir(),
      "sjz-quarantine-snapshot-"
    ));
    const databasePath = join(directory, "snapshot.sqlite");
    const initialFinishedAt = new Date(scanTime.getTime() + 1_000);
    const quarantineAt = new Date(scanTime.getTime() + 2_000);
    try {
      const database = createDatabase(databasePath);
      const repository = new ListingRepository(database);
      const initialRun = repository.startScan(scanTime);
      repository.commitScanRefresh(
        initialRun,
        [
          ...sourceListings("jiaoyimao", 20, "trusted"),
          ...sourceListings("panzhi", 1, "trusted"),
          ...sourceListings("pxb7", 1, "trusted")
        ],
        [
          successUpdate("jiaoyimao", 20, "success", 5),
          successUpdate("panzhi", 1),
          successUpdate("pxb7", 1)
        ],
        initialFinishedAt
      );
      const { jobId } = createCommittingBrowserJob(
        database,
        quarantineAt
      );
      const quarantined = repository.commitBrowserSourceRefresh({
        jobId,
        source: "jiaoyimao",
        listings: sourceListings("jiaoyimao", 2, "low"),
        attemptedAt: quarantineAt,
        pagesScanned: 1,
        stopReason: "end_of_pages"
      });
      expect(quarantined.state).toBe("quarantined");
      expect(repository.getRefreshSnapshot()).toMatchObject({
        latestRun: expect.objectContaining({
          id: quarantined.scanRunId,
          state: "partial"
        }),
        lastSnapshotAt: initialFinishedAt.toISOString()
      });
      database.close();

      const reopened = createDatabase(databasePath);
      try {
        expect(
          new ListingRepository(reopened).getRefreshSnapshot()
        ).toMatchObject({
          latestRun: expect.objectContaining({
            id: quarantined.scanRunId,
            state: "partial"
          }),
          lastSnapshotAt: initialFinishedAt.toISOString()
        });
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("migrates legacy source statuses without destroying rows", () => {
    const directory = mkdtempSync(join(tmpdir(), "sjz-legacy-source-status-"));
    const databasePath = join(directory, "legacy.sqlite");
    const legacyDatabase = new DatabaseSync(databasePath);
    legacyDatabase.exec(`
      CREATE TABLE source_status (
        source TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        last_attempt_at TEXT,
        last_success_at TEXT,
        item_count INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );
      INSERT INTO source_status (
        source, state, last_attempt_at, last_success_at, item_count, error
      ) VALUES ('panzhi', 'success', '2026-07-28T00:00:00.000Z',
        '2026-07-28T00:00:00.000Z', 3, NULL);
    `);
    legacyDatabase.close();

    try {
      const database = createDatabase(databasePath);
      try {
        const repository = new ListingRepository(database);

        expect(repository.getSourceStatuses()).toContainEqual(
          expect.objectContaining({
            source: "panzhi",
            state: "success",
            itemCount: 3,
            pagesScanned: 0,
            stopReason: null
          })
        );
        const resultColumns = (
          database.prepare("PRAGMA table_info(scan_source_results)").all() as
            Array<{ name: string }>
        ).map(({ name }) => name);
        expect(resultColumns).toEqual(
          expect.arrayContaining(["anomaly_state", "published"])
        );
        const observationColumns = (
          database.prepare("PRAGMA table_info(listing_observations)").all() as
            Array<{ name: string }>
        ).map(({ name }) => name);
        expect(observationColumns).toEqual(
          expect.arrayContaining([
            "snapshot_json",
            "changes_json",
            "availability",
            "trusted"
          ])
        );
        expect(
          database
            .prepare(
              "SELECT source, state FROM source_anomaly_guards ORDER BY source"
            )
            .all()
        ).toEqual([
          { source: "jiaoyimao", state: "clear" },
          { source: "panzhi", state: "clear" },
          { source: "pxb7", state: "clear" }
        ]);
      } finally {
        database.close();
      }

      const reopenedDatabase = createDatabase(databasePath);
      try {
        expect(new ListingRepository(reopenedDatabase).getSourceStatuses()).toContainEqual(
          expect.objectContaining({
            source: "panzhi",
            itemCount: 3,
            pagesScanned: 0,
            stopReason: null
          })
        );
      } finally {
        reopenedDatabase.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("loads legacy payloads without an M7 grade as null", () => {
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);
    const legacy = { ...makeListing() } as Record<string, unknown>;
    delete legacy.m7PrismQuality;
    database
      .prepare(`
        INSERT INTO listings (listing_key, source, eligibility, payload)
        VALUES (?, ?, ?, ?)
      `)
      .run(
        "panzhi:legacy",
        "panzhi",
        "eligible",
        JSON.stringify({ ...legacy, key: "panzhi:legacy" })
      );

    expect(repository.getListings()[0].m7PrismQuality).toBeNull();
  });

  it("upserts a source snapshot and filters by eligibility", () => {
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);
    const eligible = makeListing();
    const rejected = makeListing({
      key: "panzhi:rejected",
      sourceListingId: "rejected",
      eligibility: "rejected"
    });

    repository.replaceSourceSnapshot(
      "panzhi",
      [eligible, rejected],
      "success",
      new Date("2026-07-28T10:00:00+08:00")
    );

    expect(repository.getListings("eligible")).toEqual([eligible]);
    expect(repository.getListings()).toHaveLength(2);
  });

  it("retains an old snapshot when a source fails", () => {
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);
    repository.replaceSourceSnapshot(
      "panzhi",
      [makeListing()],
      "success",
      new Date("2026-07-27T10:00:00+08:00")
    );

    repository.markSourceFailure(
      "panzhi",
      "登录验证阻塞",
      new Date("2026-07-28T12:00:00+08:00"),
      "blocked"
    );

    expect(repository.getListings()).toHaveLength(1);
    expect(
      repository
        .getSourceStatuses(new Date("2026-07-28T12:00:00+08:00"))
        .find(({ source }) => source === "panzhi")
    ).toMatchObject({
      state: "blocked",
      itemCount: 1,
      error: "登录验证阻塞"
    });
  });

  it("persists partial scan metadata and clears it on a blocked failure", () => {
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);

    repository.replaceSourceSnapshot(
      "panzhi",
      [makeListing()],
      "partial",
      new Date("2026-07-28T10:00:00+08:00"),
      {
        pagesScanned: 5,
        stopReason: "error",
        error: "request_timeout"
      }
    );
    expect(repository.getSourceStatuses().find(({ source }) => source === "panzhi"))
      .toMatchObject({
        state: "partial",
        itemCount: 1,
        pagesScanned: 5,
        stopReason: "error",
        error: "request_timeout"
      });

    repository.markSourceFailure(
      "panzhi",
      "captcha_required",
      new Date("2026-07-28T12:00:00+08:00"),
      "blocked"
    );

    expect(repository.getListings()).toHaveLength(1);
    expect(repository.getSourceStatuses().find(({ source }) => source === "panzhi"))
      .toMatchObject({
        state: "blocked",
        itemCount: 1,
        pagesScanned: 0,
        stopReason: "error",
        error: "captcha_required"
      });
  });

  it("marks a source stale after 24 hours and preserves ISO timestamps", () => {
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);
    repository.replaceSourceSnapshot(
      "pxb7",
      [makeListing({ source: "pxb7", key: "pxb7:1" })],
      "partial",
      new Date("2026-07-27T10:00:00+08:00")
    );

    const status = repository
      .getSourceStatuses(new Date("2026-07-28T11:00:01+08:00"))
      .find(({ source }) => source === "pxb7");

    expect(status).toMatchObject({
      state: "partial",
      stale: true,
      itemCount: 1
    });
    expect(status?.lastSuccessAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    );
  });

  it("rolls back a failed snapshot write and returns an actionable error", () => {
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);
    repository.replaceSourceSnapshot(
      "panzhi",
      [makeListing()],
      "success",
      new Date("2026-07-28T10:00:00+08:00")
    );
    database.exec(`
      CREATE TRIGGER force_listing_failure
      BEFORE INSERT ON listings
      BEGIN
        SELECT RAISE(ABORT, 'forced write failure');
      END;
    `);

    expect(() =>
      repository.replaceSourceSnapshot(
        "panzhi",
        [makeListing({ key: "panzhi:new", sourceListingId: "new" })],
        "success",
        new Date("2026-07-28T11:00:00+08:00")
      )
    ).toThrow("无法保存 panzhi 快照");
    expect(repository.getListings().map(({ key }) => key)).toEqual([
      "panzhi:SA123"
    ]);
  });

  it("creates one hidden compatibility baseline for a legacy success snapshot", () => {
    const directory = mkdtempSync(join(tmpdir(), "sjz-scan-baseline-"));
    const databasePath = join(directory, "legacy.sqlite");
    const legacy = {
      ...makeListing(),
      score: {
        total: 80,
        parts: {
          safety: 40,
          price: 20,
          assets: 10,
          confidence: 10
        },
        reasons: []
      }
    } as Record<string, unknown>;
    delete legacy.scanStability;
    delete legacy.consecutiveUnchangedScans;
    const legacyDatabase = new DatabaseSync(databasePath);
    legacyDatabase.exec(`
      CREATE TABLE listings (
        listing_key TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        eligibility TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE source_status (
        source TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        last_attempt_at TEXT,
        last_success_at TEXT,
        item_count INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );
    `);
    legacyDatabase.prepare(`
      INSERT INTO listings (listing_key, source, eligibility, payload)
      VALUES (?, ?, ?, ?)
    `).run("panzhi:SA123", "panzhi", "eligible", JSON.stringify(legacy));
    legacyDatabase.prepare(`
      INSERT INTO source_status (
        source, state, last_attempt_at, last_success_at, item_count, error
      ) VALUES (?, 'success', ?, ?, 1, NULL)
    `).run(
      "panzhi",
      "2026-07-28T00:00:00.000Z",
      "2026-07-28T00:00:00.000Z"
    );
    legacyDatabase.close();

    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const database = createDatabase(databasePath);
        try {
          expect(
            database.prepare(
              "SELECT COUNT(*) AS count FROM scan_runs WHERE is_baseline = 1"
            ).get()
          ).toEqual({ count: 1 });
          expect(
            database.prepare(
              "SELECT COUNT(*) AS count FROM listing_observations"
            ).get()
          ).toEqual({ count: 1 });
          const repository = new ListingRepository(database);
          expect(repository.getListings()[0]).toMatchObject({
            score: null,
            scanStability: "unknown",
            consecutiveUnchangedScans: 0
          });
          expect(repository.getRefreshSnapshot()).toMatchObject({
            latestRun: null,
            lastSnapshotAt: "2026-07-28T00:00:00.000Z"
          });
        } finally {
          database.close();
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("marks an interrupted running scan failed when reopening", () => {
    const directory = mkdtempSync(join(tmpdir(), "sjz-interrupted-scan-"));
    const databasePath = join(directory, "scan.sqlite");
    try {
      const first = createDatabase(databasePath);
      first.prepare(`
        INSERT INTO scan_runs (started_at, state, is_baseline)
        VALUES (?, 'running', 0)
      `).run("2026-07-29T00:00:00.000Z");
      first.close();

      const reopened = createDatabase(databasePath);
      try {
        expect(
          reopened.prepare(
            "SELECT state, error FROM scan_runs WHERE is_baseline = 0"
          ).get()
        ).toEqual({
          state: "failed",
          error: "进程中断"
        });
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("tracks new, stable, changed, absent, and partial observations", () => {
    const repository = new ListingRepository(createDatabase(":memory:"));
    const failedOthers = [
      failureUpdate("jiaoyimao"),
      failureUpdate("pxb7", "blocked")
    ];
    const original = makeListing({ score: makeScore(80) });

    const firstRun = repository.startScan(scanTime);
    expect(
      repository.commitScanRefresh(
        firstRun,
        [original],
        [successUpdate("panzhi", 1), ...failedOthers],
        scanTime
      )
    ).toBe("partial");
    expect(repository.getListing(original.key)).toMatchObject({
      scanStability: "new",
      consecutiveUnchangedScans: 1
    });

    const secondRun = repository.startScan(scanTime);
    repository.commitScanRefresh(
      secondRun,
      [original],
      [successUpdate("panzhi", 1), ...failedOthers],
      scanTime
    );
    expect(repository.getListing(original.key)).toMatchObject({
      scanStability: "stable",
      consecutiveUnchangedScans: 2
    });

    const changed = { ...original, priceCny: 1999 };
    const thirdRun = repository.startScan(scanTime);
    repository.commitScanRefresh(
      thirdRun,
      [changed],
      [successUpdate("panzhi", 1), ...failedOthers],
      scanTime
    );
    expect(repository.getListing(original.key)).toMatchObject({
      scanStability: "changed",
      consecutiveUnchangedScans: 1
    });

    const absentRun = repository.startScan(scanTime);
    repository.commitScanRefresh(
      absentRun,
      [],
      [successUpdate("panzhi", 0), ...failedOthers],
      scanTime
    );
    expect(repository.getListing(original.key)).toBeNull();

    const reappearedRun = repository.startScan(scanTime);
    repository.commitScanRefresh(
      reappearedRun,
      [changed],
      [successUpdate("panzhi", 1), ...failedOthers],
      scanTime
    );
    expect(repository.getListing(original.key)).toMatchObject({
      scanStability: "new",
      consecutiveUnchangedScans: 1
    });

    const partialRun = repository.startScan(scanTime);
    repository.commitScanRefresh(
      partialRun,
      [changed],
      [successUpdate("panzhi", 1, "partial"), ...failedOthers],
      scanTime
    );
    expect(repository.getListing(original.key)).toMatchObject({
      scanStability: "unknown",
      consecutiveUnchangedScans: 0
    });

    const afterPartialRun = repository.startScan(scanTime);
    repository.commitScanRefresh(
      afterPartialRun,
      [changed],
      [successUpdate("panzhi", 1), ...failedOthers],
      scanTime
    );
    expect(repository.getListing(original.key)).toMatchObject({
      scanStability: "stable",
      consecutiveUnchangedScans: 2
    });
  });

  it("quarantines the first 44-to-10 drop and retains the trusted snapshot", () => {
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);
    const trusted = sourceListings("panzhi", 44, "trusted");
    repository.replaceSourceSnapshot(
      "panzhi",
      trusted,
      "success",
      scanTime,
      { pagesScanned: 5, stopReason: "end_of_pages" }
    );

    const runId = repository.startScan(scanTime);
    expect(
      repository.commitScanRefresh(
        runId,
        sourceListings("panzhi", 10, "low"),
        [
          successUpdate("panzhi", 10, "success", 1),
          failureUpdate("jiaoyimao"),
          failureUpdate("pxb7")
        ],
        scanTime
      )
    ).toBe("partial");

    const retained = repository
      .getListings()
      .filter(({ source }) => source === "panzhi");
    expect(retained.map(({ key }) => key)).toEqual(
      trusted.map(({ key }) => key)
    );
    expect(retained.map(listingMaterialHash)).toEqual(
      trusted.map(listingMaterialHash)
    );
    expect(
      repository.getSourceStatuses().find(({ source }) => source === "panzhi")
    ).toMatchObject({
      state: "partial",
      itemCount: 44,
      pagesScanned: 5,
      stopReason: "anomaly_guard",
      anomaly: {
        state: "suspect",
        baselineItemCount: 44,
        baselinePagesScanned: 5,
        observedItemCount: 10,
        observedPagesScanned: 1,
        confirmationCount: 1
      }
    });
    expect(repository.getScanHistory(1)[0].sources).toContainEqual(
      expect.objectContaining({
        source: "panzhi",
        state: "partial",
        observedItemCount: 10,
        pagesScanned: 1,
        anomalyState: "suspect",
        published: false
      })
    );
  });

  it("rescales the retained trusted snapshot with fresh sources while an anomaly is quarantined", () => {
    const repository = new ListingRepository(createDatabase(":memory:"));
    const trusted = sourceListings("panzhi", 44, "trusted").map(
      (listing) => ({ ...listing, score: null })
    );
    const failedRetained = makeListing({
      source: "pxb7",
      key: "pxb7:retained",
      sourceListingId: "retained",
      url: "https://example.test/pxb7/retained",
      score: makeScore(99)
    });
    repository.replaceSourceSnapshot(
      "panzhi",
      trusted,
      "success",
      scanTime,
      { pagesScanned: 5, stopReason: "end_of_pages" }
    );
    repository.replaceSourceSnapshot(
      "pxb7",
      [failedRetained],
      "success",
      scanTime,
      { pagesScanned: 1, stopReason: "end_of_pages" }
    );
    const fresh = makeListing({
      source: "jiaoyimao",
      key: "jiaoyimao:fresh",
      sourceListingId: "fresh",
      url: "https://example.test/jiaoyimao/fresh",
      score: null
    });

    const runId = repository.startScan(scanTime);
    repository.commitScanRefresh(
      runId,
      [...sourceListings("panzhi", 10, "low"), fresh],
      [
        successUpdate("panzhi", 10, "success", 1),
        successUpdate("jiaoyimao", 1),
        failureUpdate("pxb7")
      ],
      scanTime
    );

    expect(repository.getListing(trusted[0].key)?.score).not.toBeNull();
    expect(repository.getListing(fresh.key)?.score).not.toBeNull();
    expect(repository.getListing(failedRetained.key)?.score).toBeNull();
  });

  it("does not publish an anomalously low partial scan or start confirmation", () => {
    const repository = new ListingRepository(createDatabase(":memory:"));
    const trusted = sourceListings("panzhi", 44, "trusted");
    repository.replaceSourceSnapshot(
      "panzhi",
      trusted,
      "success",
      scanTime,
      { pagesScanned: 5, stopReason: "end_of_pages" }
    );

    repository.commitScanRefresh(
      repository.startScan(scanTime),
      sourceListings("panzhi", 10, "partial-low"),
      [
        successUpdate("panzhi", 10, "partial", 1),
        failureUpdate("jiaoyimao"),
        failureUpdate("pxb7")
      ],
      scanTime
    );

    const retained = repository
      .getListings()
      .filter(({ source }) => source === "panzhi");
    expect(retained.map(({ key }) => key)).toEqual(
      trusted.map(({ key }) => key)
    );
    expect(
      repository.getSourceStatuses().find(({ source }) => source === "panzhi")
    ).toMatchObject({
      state: "partial",
      itemCount: 44,
      pagesScanned: 5,
      anomaly: { state: "clear" }
    });
    expect(repository.getScanHistory(1)[0].sources).toContainEqual(
      expect.objectContaining({
        source: "panzhi",
        state: "partial",
        observedItemCount: 10,
        published: false,
        anomalyState: "none"
      })
    );
  });

  it("publishes a second similar low scan and clears the anomaly guard", () => {
    const repository = new ListingRepository(createDatabase(":memory:"));
    repository.replaceSourceSnapshot(
      "panzhi",
      sourceListings("panzhi", 44, "trusted"),
      "success",
      scanTime,
      { pagesScanned: 5, stopReason: "end_of_pages" }
    );
    const failures = [
      failureUpdate("jiaoyimao"),
      failureUpdate("pxb7")
    ];

    repository.commitScanRefresh(
      repository.startScan(scanTime),
      sourceListings("panzhi", 10, "low-first"),
      [successUpdate("panzhi", 10, "success", 1), ...failures],
      scanTime
    );
    const confirmed = sourceListings("panzhi", 11, "low-confirmed");
    repository.commitScanRefresh(
      repository.startScan(new Date(scanTime.getTime() + 1_000)),
      confirmed,
      [successUpdate("panzhi", 11, "success", 1), ...failures],
      new Date(scanTime.getTime() + 1_000)
    );

    expect(
      repository.getListings().filter(({ source }) => source === "panzhi")
    ).toHaveLength(11);
    expect(
      repository.getSourceStatuses().find(({ source }) => source === "panzhi")
    ).toMatchObject({
      state: "success",
      itemCount: 11,
      pagesScanned: 1,
      anomaly: { state: "clear" }
    });
    expect(repository.getScanHistory(1)[0].sources).toContainEqual(
      expect.objectContaining({
        source: "panzhi",
        state: "success",
        anomalyState: "confirmed",
        published: true
      })
    );
  });

  it("does not use partial or blocked scans to confirm a pending drop", () => {
    const repository = new ListingRepository(createDatabase(":memory:"));
    const trusted = sourceListings("panzhi", 44, "trusted");
    repository.replaceSourceSnapshot(
      "panzhi",
      trusted,
      "success",
      scanTime,
      { pagesScanned: 5, stopReason: "end_of_pages" }
    );
    const otherFailures = [
      failureUpdate("jiaoyimao"),
      failureUpdate("pxb7")
    ];
    repository.commitScanRefresh(
      repository.startScan(scanTime),
      sourceListings("panzhi", 10, "suspect"),
      [successUpdate("panzhi", 10, "success", 1), ...otherFailures],
      scanTime
    );

    repository.commitScanRefresh(
      repository.startScan(new Date(scanTime.getTime() + 1_000)),
      sourceListings("panzhi", 10, "partial"),
      [successUpdate("panzhi", 10, "partial", 1), ...otherFailures],
      new Date(scanTime.getTime() + 1_000)
    );
    expect(
      repository.getSourceStatuses().find(({ source }) => source === "panzhi")
    ).toMatchObject({
      anomaly: {
        state: "suspect",
        confirmationCount: 1
      }
    });
    const retained = repository
      .getListings()
      .filter(({ source }) => source === "panzhi");
    expect(retained.map(({ key }) => key)).toEqual(
      trusted.map(({ key }) => key)
    );
    expect(retained.map(listingMaterialHash)).toEqual(
      trusted.map(listingMaterialHash)
    );

    repository.finalizeFailedScan(
      repository.startScan(new Date(scanTime.getTime() + 2_000)),
      [
        failureUpdate("panzhi", "blocked"),
        failureUpdate("jiaoyimao"),
        failureUpdate("pxb7")
      ],
      "没有来源取得新鲜数据",
      new Date(scanTime.getTime() + 2_000)
    );
    expect(
      repository.getSourceStatuses().find(({ source }) => source === "panzhi")
    ).toMatchObject({
      anomaly: {
        state: "suspect",
        confirmationCount: 1
      }
    });
  });

  it("accepts a recovered volume and clears a pending guard", () => {
    const repository = new ListingRepository(createDatabase(":memory:"));
    repository.replaceSourceSnapshot(
      "panzhi",
      sourceListings("panzhi", 44, "trusted"),
      "success",
      scanTime,
      { pagesScanned: 5, stopReason: "end_of_pages" }
    );
    const failures = [
      failureUpdate("jiaoyimao"),
      failureUpdate("pxb7")
    ];
    repository.commitScanRefresh(
      repository.startScan(scanTime),
      sourceListings("panzhi", 10, "suspect"),
      [successUpdate("panzhi", 10, "success", 1), ...failures],
      scanTime
    );
    const recovered = sourceListings("panzhi", 43, "recovered");
    repository.commitScanRefresh(
      repository.startScan(new Date(scanTime.getTime() + 1_000)),
      recovered,
      [successUpdate("panzhi", 43, "success", 5), ...failures],
      new Date(scanTime.getTime() + 1_000)
    );

    expect(
      repository.getListings().filter(({ source }) => source === "panzhi")
    ).toHaveLength(43);
    expect(
      repository.getSourceStatuses().find(({ source }) => source === "panzhi")
    ).toMatchObject({
      state: "success",
      anomaly: { state: "clear" }
    });
  });

  it("publishes a recovered partial volume and clears a pending guard", () => {
    const repository = new ListingRepository(createDatabase(":memory:"));
    repository.replaceSourceSnapshot(
      "panzhi",
      sourceListings("panzhi", 44, "trusted"),
      "success",
      scanTime,
      { pagesScanned: 5, stopReason: "end_of_pages" }
    );
    const failures = [
      failureUpdate("jiaoyimao"),
      failureUpdate("pxb7")
    ];
    repository.commitScanRefresh(
      repository.startScan(scanTime),
      sourceListings("panzhi", 10, "suspect"),
      [successUpdate("panzhi", 10, "success", 1), ...failures],
      scanTime
    );
    const recovered = sourceListings("panzhi", 43, "partial-recovered");
    const recoveredAt = new Date(scanTime.getTime() + 1_000);
    repository.commitScanRefresh(
      repository.startScan(recoveredAt),
      recovered,
      [successUpdate("panzhi", 43, "partial", 5), ...failures],
      recoveredAt
    );

    expect(
      repository.getListings().filter(({ source }) => source === "panzhi")
    ).toHaveLength(43);
    expect(
      repository.getSourceStatuses().find(({ source }) => source === "panzhi")
    ).toMatchObject({
      state: "partial",
      itemCount: 43,
      pagesScanned: 5,
      anomaly: { state: "clear" }
    });
    expect(repository.getScanHistory(1)[0].sources).toContainEqual(
      expect.objectContaining({
        source: "panzhi",
        state: "partial",
        anomalyState: "recovered",
        published: true
      })
    );
  });

  it("stores trusted field and price changes for an active listing", () => {
    const repository = new ListingRepository(createDatabase(":memory:"));
    const failures = [
      failureUpdate("jiaoyimao"),
      failureUpdate("pxb7")
    ];
    const original = makeListing({ priceCny: 1888 });
    repository.commitScanRefresh(
      repository.startScan(scanTime),
      [original],
      [successUpdate("panzhi", 1), ...failures],
      scanTime
    );
    const changedAt = new Date(scanTime.getTime() + 1_000);
    repository.commitScanRefresh(
      repository.startScan(changedAt),
      [
        makeListing({
          priceCny: 2199,
          recoveryCoverage: false
        })
      ],
      [successUpdate("panzhi", 1, "success", 1, changedAt), ...failures],
      changedAt
    );

    expect(repository.getListingHistory(original.key, 20)).toMatchObject({
      key: original.key,
      source: "panzhi",
      availability: "active",
      lastSeenAt: changedAt.toISOString(),
      observations: [
        {
          observedAt: changedAt.toISOString(),
          availability: "active",
          priceCny: 2199,
          changes: expect.arrayContaining([
            {
              field: "priceCny",
              label: "价格",
              before: "¥1,888",
              after: "¥2,199"
            },
            {
              field: "recoveryCoverage",
              label: "找回保障",
              before: "支持包赔",
              after: "无包赔"
            }
          ])
        },
        {
          availability: "active",
          priceCny: 1888,
          changes: [
            {
              field: "availability",
              label: "在售状态",
              before: "未记录",
              after: "在售"
            }
          ]
        }
      ]
    });
  });

  it("normalizes legacy history without inventing an empty finish change", () => {
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);
    const failures = [
      failureUpdate("jiaoyimao"),
      failureUpdate("pxb7")
    ];
    const listing = makeListing({ m7RareFinishes: [] });
    repository.commitScanRefresh(
      repository.startScan(scanTime),
      [listing],
      [successUpdate("panzhi", 1), ...failures],
      scanTime
    );
    const row = database
      .prepare(`
        SELECT run_id, snapshot_json
        FROM listing_observations
        WHERE listing_key = ?
          AND trusted = 1
      `)
      .get(listing.key) as {
      run_id: number;
      snapshot_json: string;
    };
    const {
      m7RareFinishes: _legacyFinishes,
      ...legacySnapshot
    } = JSON.parse(row.snapshot_json) as Record<string, unknown>;
    database
      .prepare(`
        UPDATE listing_observations
        SET snapshot_json = ?
        WHERE run_id = ? AND listing_key = ?
      `)
      .run(JSON.stringify(legacySnapshot), row.run_id, listing.key);

    const nextScan = new Date(scanTime.getTime() + 1_000);
    repository.commitScanRefresh(
      repository.startScan(nextScan),
      [listing],
      [successUpdate("panzhi", 1, "success", 1, nextScan), ...failures],
      nextScan
    );

    const history = repository.getListingHistory(listing.key, 20);
    expect(history?.observations[0].changes).not.toContainEqual(
      expect.objectContaining({ field: "m7RareFinishes" })
    );
    expect(
      history?.observations.map(
        ({ snapshot }) => snapshot.m7RareFinishes
      )
    ).toEqual([[], []]);
  });

  it("writes a removed tombstone only after a trusted complete scan", () => {
    const repository = new ListingRepository(createDatabase(":memory:"));
    const failures = [
      failureUpdate("jiaoyimao"),
      failureUpdate("pxb7")
    ];
    const listing = makeListing();
    repository.commitScanRefresh(
      repository.startScan(scanTime),
      [listing],
      [successUpdate("panzhi", 1), ...failures],
      scanTime
    );
    const partialAt = new Date(scanTime.getTime() + 1_000);
    repository.commitScanRefresh(
      repository.startScan(partialAt),
      [],
      [
        successUpdate("panzhi", 0, "partial", 1, partialAt),
        ...failures
      ],
      partialAt
    );

    expect(repository.getListingHistory(listing.key, 20)).toMatchObject({
      availability: "unknown",
      observations: [
        expect.objectContaining({ availability: "active" })
      ]
    });

    const removedAt = new Date(scanTime.getTime() + 2_000);
    repository.commitScanRefresh(
      repository.startScan(removedAt),
      [],
      [successUpdate("panzhi", 0, "success", 1, removedAt), ...failures],
      removedAt
    );
    expect(repository.getListing(listing.key)).toBeNull();
    expect(repository.getListingHistory(listing.key, 20)).toMatchObject({
      availability: "removed",
      lastSeenAt: scanTime.toISOString(),
      observations: [
        {
          observedAt: removedAt.toISOString(),
          availability: "removed",
          changes: [
            {
              field: "availability",
              label: "在售状态",
              before: "在售",
              after: "已下架"
            }
          ]
        },
        expect.objectContaining({ availability: "active" })
      ]
    });
  });

  it("records a removed listing becoming active again", () => {
    const repository = new ListingRepository(createDatabase(":memory:"));
    const failures = [
      failureUpdate("jiaoyimao"),
      failureUpdate("pxb7")
    ];
    const listing = makeListing();
    repository.commitScanRefresh(
      repository.startScan(scanTime),
      [listing],
      [successUpdate("panzhi", 1), ...failures],
      scanTime
    );
    repository.commitScanRefresh(
      repository.startScan(new Date(scanTime.getTime() + 1_000)),
      [],
      [
        successUpdate(
          "panzhi",
          0,
          "success",
          1,
          new Date(scanTime.getTime() + 1_000)
        ),
        ...failures
      ],
      new Date(scanTime.getTime() + 1_000)
    );
    const reappearedAt = new Date(scanTime.getTime() + 2_000);
    repository.commitScanRefresh(
      repository.startScan(reappearedAt),
      [listing],
      [
        successUpdate("panzhi", 1, "success", 1, reappearedAt),
        ...failures
      ],
      reappearedAt
    );

    expect(repository.getListingHistory(listing.key, 20)).toMatchObject({
      availability: "active",
      observations: [
        {
          availability: "active",
          changes: expect.arrayContaining([
            {
              field: "availability",
              label: "在售状态",
              before: "已下架",
              after: "在售"
            }
          ])
        },
        expect.objectContaining({ availability: "removed" }),
        expect.objectContaining({ availability: "active" })
      ]
    });
  });

  it("finalizes an all-failed scan without replacing retained listings", () => {
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);
    const retained = makeListing({
      score: makeScore(80),
      scanStability: "stable",
      consecutiveUnchangedScans: 2
    });
    repository.replaceSourceSnapshot("panzhi", [retained], "success", scanTime);
    const runId = repository.startScan(scanTime);
    const updates = [
      failureUpdate("jiaoyimao", "blocked"),
      failureUpdate("panzhi"),
      failureUpdate("pxb7", "blocked")
    ];

    repository.finalizeFailedScan(
      runId,
      updates,
      "没有来源取得新鲜数据",
      scanTime
    );

    expect(repository.getListing(retained.key)).toEqual(retained);
    expect(repository.getScanHistory(1)[0]).toMatchObject({
      id: runId,
      state: "failed",
      sources: expect.arrayContaining([
        expect.objectContaining({
          source: "panzhi",
          state: "failed",
          observedItemCount: 0,
          eligibleCount: 0,
          balancedCandidateCount: 0,
          globalCandidateCount: 0
        })
      ])
    });
    expect(repository.getSourceStatuses()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "panzhi", state: "failed" })
      ])
    );
  });

  it("keeps only fifty normal scan runs and timestamps an empty published snapshot", () => {
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);
    for (let index = 0; index < 51; index += 1) {
      const when = new Date(scanTime.getTime() + index * 1_000);
      const runId = repository.startScan(when);
      repository.commitScanRefresh(
        runId,
        [],
        [
          successUpdate("jiaoyimao", 0),
          successUpdate("panzhi", 0),
          successUpdate("pxb7", 0)
        ],
        when
      );
    }

    expect(
      database.prepare(
        "SELECT COUNT(*) AS count FROM scan_runs WHERE is_baseline = 0"
      ).get()
    ).toEqual({ count: 50 });
    expect(repository.getScanHistory(50)).toHaveLength(50);
    expect(repository.getRefreshSnapshot()).toMatchObject({
      latestRun: expect.objectContaining({ state: "success" }),
      lastSnapshotAt: new Date(
        scanTime.getTime() + 50 * 1_000
      ).toISOString()
    });
  });

  it("idempotently reparses, reclassifies, and rescores stored listings without fabricating history", () => {
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);
    const premiumS = makeListing({
      key: "panzhi:premium-s",
      sourceListingId: "premium-s",
      url: "https://www.pzds.com/item/premium-s",
      evidence: [
        {
          text:
            "M7战斗步枪-棱镜攻势S2(优品S) " +
            "骇爪-维什戴尔 露娜-黑天际线",
          truncated: false
        }
      ],
      m7Evidence: [
        {
          text: "M7战斗步枪-棱镜攻势S2(优品S)",
          truncated: false
        }
      ],
      m7PrismStatus: "premium",
      m7PrismQuality: null,
      eligibility: "rejected",
      score: null
    });
    const premiumA = makeListing({
      key: "panzhi:premium-a",
      sourceListingId: "premium-a",
      url: "https://www.pzds.com/item/premium-a",
      evidence: [
        {
          text:
            "M7战斗步枪-棱镜攻势S2(优品A) " +
            "骇爪-维什戴尔 露娜-黑天际线",
          truncated: false
        }
      ],
      m7Evidence: [
        {
          text: "M7战斗步枪-棱镜攻势S2(优品A)",
          truncated: false
        }
      ],
      m7PrismStatus: "premium",
      m7PrismQuality: null,
      eligibility: "rejected",
      score: null
    });
    const reviewedPeak = makeListing({
      key: "panzhi:reviewed-peak",
      sourceListingId: "reviewed-peak",
      url: "https://www.pzds.com/item/reviewed-peak",
      evidence: [
        { text: "M7棱镜攻势(极品A)", truncated: false },
        {
          text: "骇爪-维什戴尔 露娜-黑天际线",
          truncated: false
        },
        { text: "威龙 红皮", truncated: false },
        { text: "巨浪 极品", truncated: false }
      ],
      m7Evidence: [
        { text: "M7棱镜攻势(极品A)", truncated: false }
      ]
    });
    const duplicatePeak = makeListing({
      key: "pxb7:duplicate-peak",
      source: "pxb7",
      sourceListingId: "duplicate-peak",
      url: "https://www.pxb7.com/item/duplicate-peak",
      evidence: [
        { text: "M7棱镜攻势(极品A)", truncated: false },
        {
          text: "骇爪-维什戴尔 露娜-黑天际线",
          truncated: false
        },
        { text: "威龙 红皮", truncated: false },
        { text: "巨浪 极品", truncated: false }
      ],
      m7Evidence: [
        { text: "M7棱镜攻势(极品A)", truncated: false }
      ]
    });
    const runId = repository.startScan(scanTime);
    repository.commitScanRefresh(
      runId,
      [premiumS, premiumA, reviewedPeak, duplicatePeak],
      [
        successUpdate("jiaoyimao", 0),
        successUpdate("panzhi", 3),
        successUpdate("pxb7", 1)
      ],
      scanTime
    );
    repository.excludeListing(
      reviewedPeak.key,
      {
        reason: "m7_low_value",
        note: "保留人工判断"
      },
      new Date("2026-07-31T08:00:00.000Z")
    );
    repository.updateDerivedListings(
      repository.getListings().map((listing) => ({
        ...listing,
        ...(listing.key === premiumS.key ||
        listing.key === premiumA.key
          ? {
              m7PrismQuality: null,
              eligibility: "rejected" as const,
              score: null
            }
          : {
              score: makeScore(99, { m7: 15 }),
              possibleDuplicateKeys: []
            })
      }))
    );

    const metadata = () => ({
      sourceStatus: database.prepare(
        "SELECT * FROM source_status ORDER BY source"
      ).all(),
      scanRuns: database.prepare(
        "SELECT * FROM scan_runs ORDER BY id"
      ).all(),
      sourceResults: database.prepare(
        "SELECT * FROM scan_source_results ORDER BY run_id, source"
      ).all(),
      observations: database.prepare(
        "SELECT * FROM listing_observations ORDER BY run_id, listing_key"
      ).all(),
      reviews: database.prepare(
        "SELECT * FROM manual_listing_reviews ORDER BY id"
      ).all()
    });
    const metadataBefore = metadata();
    const recomputedAt = new Date("2026-07-31T10:00:00.000Z");

    repository.recomputeDerivedListings(recomputedAt);

    expect(repository.getListing(premiumS.key)).toMatchObject({
      m7PrismStatus: "premium",
      m7PrismQuality: "S",
      eligibility: "eligible",
      score: {
        parts: { m7: 5 }
      }
    });
    expect(repository.getListing(premiumA.key)).toMatchObject({
      m7PrismStatus: "premium",
      m7PrismQuality: "A",
      eligibility: "eligible",
      score: {
        parts: { m7: 0 }
      }
    });
    expect(repository.getListing(reviewedPeak.key)).toMatchObject({
      possibleDuplicateKeys: [duplicatePeak.key],
      score: {
        parts: { m7: 10 }
      }
    });
    expect(repository.getListing(duplicatePeak.key)).toMatchObject({
      possibleDuplicateKeys: [reviewedPeak.key],
      score: {
        parts: { m7: 10 }
      }
    });
    expect(repository.getReviewedListing(reviewedPeak.key)).toMatchObject({
      manualReview: {
        reason: "m7_low_value",
        note: "保留人工判断"
      }
    });
    expect(metadata()).toEqual(metadataBefore);

    const firstPayloads = database.prepare(`
      SELECT listing_key, eligibility, payload
      FROM listings
      ORDER BY listing_key
    `).all();
    repository.recomputeDerivedListings(recomputedAt);
    expect(database.prepare(`
      SELECT listing_key, eligibility, payload
      FROM listings
      ORDER BY listing_key
    `).all()).toEqual(firstPayloads);
    expect(metadata()).toEqual(metadataBefore);
  });

  it("appends changed manual exclusions while identical writes stay idempotent", () => {
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);
    const listing = makeListing();
    const firstReviewAt = new Date("2026-07-31T08:00:00.000Z");
    const changedReviewAt = new Date("2026-07-31T08:05:00.000Z");
    repository.replaceSourceSnapshot(
      listing.source,
      [listing],
      "success",
      scanTime
    );

    expect(
      repository.excludeListing(
        listing.key,
        {
          reason: "price_overvalued",
          note: "同价位更安全"
        },
        firstReviewAt
      )
    ).toMatchObject({
      key: listing.key,
      manualReview: {
        excluded: true,
        reason: "price_overvalued",
        note: "同价位更安全",
        reviewedAt: firstReviewAt.toISOString()
      }
    });
    expect(repository.getReviewedListing(listing.key)).toMatchObject({
      manualReview: {
        reason: "price_overvalued",
        reviewedAt: firstReviewAt.toISOString()
      }
    });
    expect(repository.getReviewedListings("eligible")).toHaveLength(1);

    repository.excludeListing(
      listing.key,
      {
        reason: "price_overvalued",
        note: "同价位更安全"
      },
      changedReviewAt
    );
    expect(
      database.prepare(
        "SELECT COUNT(*) AS count FROM manual_listing_reviews"
      ).get()
    ).toEqual({ count: 1 });

    expect(
      repository.excludeListing(
        listing.key,
        {
          reason: "safety_risk",
          note: "验号信息不完整"
        },
        changedReviewAt
      )
    ).toMatchObject({
      manualReview: {
        reason: "safety_risk",
        note: "验号信息不完整",
        reviewedAt: changedReviewAt.toISOString()
      }
    });
    expect(
      database.prepare(
        "SELECT COUNT(*) AS count FROM manual_listing_reviews"
      ).get()
    ).toEqual({ count: 2 });
  });

  it("uses active manual feedback for a capped ranking adjustment and removes it on restore", () => {
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);
    const feedback = makeListing({
      key: "panzhi:feedback",
      sourceListingId: "feedback",
      url: "https://www.pzds.com/item/feedback",
      title: "用户认为价格虚高的账号"
    });
    const candidate = makeListing({
      key: "panzhi:candidate",
      sourceListingId: "candidate",
      url: "https://www.pzds.com/item/candidate",
      title: "属性相近的另一个账号"
    });
    repository.replaceSourceSnapshot(
      "panzhi",
      [feedback, candidate],
      "success",
      scanTime
    );
    repository.recomputeDerivedListings(scanTime);
    const baseTotal = repository.getListing(candidate.key)?.score?.total;
    expect(baseTotal).toBeTypeOf("number");

    repository.excludeListing(
      feedback.key,
      { reason: "price_overvalued", note: null },
      new Date("2026-08-01T08:00:00.000Z")
    );
    expect(repository.getReviewedListing(candidate.key)).toMatchObject({
      score: {
        total: baseTotal! - 1,
        reasons: expect.arrayContaining([
          expect.stringContaining("价格虚高"),
          expect.stringContaining("最多 -8")
        ])
      }
    });

    repository.restoreListing(
      feedback.key,
      new Date("2026-08-01T09:00:00.000Z")
    );
    const restored = repository.getReviewedListing(candidate.key);
    expect(restored?.score?.total).toBe(baseTotal);
    expect(restored?.score?.reasons.join(" ")).not.toContain("人工偏好");
  });

  it("restores a manual exclusion idempotently while preserving its audit history", () => {
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);
    const listing = makeListing();
    repository.replaceSourceSnapshot(
      listing.source,
      [listing],
      "success",
      scanTime
    );
    repository.excludeListing(
      listing.key,
      { reason: "assets_low", note: null },
      new Date("2026-07-31T08:00:00.000Z")
    );

    expect(
      repository.restoreListing(
        listing.key,
        new Date("2026-07-31T09:00:00.000Z")
      )
    ).toMatchObject({
      key: listing.key,
      manualReview: null
    });
    repository.restoreListing(
      listing.key,
      new Date("2026-07-31T10:00:00.000Z")
    );

    expect(repository.getReviewedListing(listing.key)).toMatchObject({
      manualReview: null
    });
    expect(
      database.prepare(
        "SELECT action, COUNT(*) AS count FROM manual_listing_reviews GROUP BY action ORDER BY action"
      ).all()
    ).toEqual([
      { action: "exclude", count: 1 },
      { action: "restore", count: 1 }
    ]);
  });

  it("keeps the latest manual decision when a source disappears and reappears", () => {
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);
    const listing = makeListing();
    repository.replaceSourceSnapshot(
      listing.source,
      [listing],
      "success",
      scanTime
    );
    repository.excludeListing(
      listing.key,
      { reason: "m7_low_value", note: "M7 品质不值这个价" },
      new Date("2026-07-31T08:00:00.000Z")
    );

    repository.replaceSourceSnapshot(
      listing.source,
      [],
      "success",
      new Date("2026-07-31T09:00:00.000Z")
    );
    expect(repository.getReviewedListing(listing.key)).toBeNull();

    const reappeared = {
      ...listing,
      title: "重新上架的账号",
      capturedAt: "2026-07-31T10:00:00.000Z"
    };
    repository.replaceSourceSnapshot(
      listing.source,
      [reappeared],
      "success",
      new Date("2026-07-31T10:00:00.000Z")
    );

    expect(repository.getReviewedListing(listing.key)).toMatchObject({
      title: "重新上架的账号",
      manualReview: {
        reason: "m7_low_value",
        note: "M7 品质不值这个价"
      }
    });
  });

  it("persists manual exclusions across a database restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "sjz-manual-review-"));
    const databasePath = join(directory, "reviews.sqlite");
    const listing = makeListing();

    try {
      const database = createDatabase(databasePath);
      const repository = new ListingRepository(database);
      repository.replaceSourceSnapshot(
        listing.source,
        [listing],
        "success",
        scanTime
      );
      repository.excludeListing(
        listing.key,
        { reason: "seller_concern", note: "卖家描述前后不一致" },
        new Date("2026-07-31T08:00:00.000Z")
      );
      database.close();

      const reopenedDatabase = createDatabase(databasePath);
      try {
        expect(
          new ListingRepository(reopenedDatabase).getReviewedListing(
            listing.key
          )
        ).toMatchObject({
          manualReview: {
            reason: "seller_concern",
            note: "卖家描述前后不一致"
          }
        });
      } finally {
        reopenedDatabase.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects manual exclusion for a missing or ineligible listing", () => {
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);
    const rejected = makeListing({
      key: "panzhi:hard-rejected",
      sourceListingId: "hard-rejected",
      eligibility: "rejected"
    });
    repository.replaceSourceSnapshot(
      rejected.source,
      [rejected],
      "success",
      scanTime
    );

    expect(() =>
      repository.excludeListing(
        "panzhi:missing",
        { reason: "price_overvalued", note: null }
      )
    ).toThrow("listing_not_found");
    expect(() =>
      repository.excludeListing(
        rejected.key,
        { reason: "price_overvalued", note: null }
      )
    ).toThrow("listing_not_eligible");
    expect(
      database.prepare(
        "SELECT COUNT(*) AS count FROM manual_listing_reviews"
      ).get()
    ).toEqual({ count: 0 });
  });
});
