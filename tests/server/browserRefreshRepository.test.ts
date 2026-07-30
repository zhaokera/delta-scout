// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDatabase } from "../../src/server/db.js";
import {
  BrowserRefreshRepository
} from "../../src/server/browserRefresh/repository.js";
import { ListingRepository } from "../../src/server/repository.js";
import type {
  BrowserDetailBatch,
  BrowserFilterProof,
  BrowserListBatch,
  BrowserLoadEvent
} from "../../src/server/browserRefresh/contracts.js";

const now = new Date("2026-07-30T10:00:00.000Z");
const filterUrl =
  "https://www.jiaoyimao.com/jg2007840/f8845003-c8845004/o110/";

function proof(at = now): BrowserFilterProof {
  return {
    currentUrl: filterUrl,
    gameLabel: "三角洲行动",
    platformLabel: "QQ",
    categoryLabel: "账号",
    m7FilterLabels: ["极品S", "极品A", "极品B", "极品C"],
    observedAt: at.toISOString()
  };
}

function listBatch(
  sequence = 1,
  sourceListingId = "1785384225212552"
): BrowserListBatch {
  return {
    sequence,
    observedAt: now.toISOString(),
    items: [
      {
        sourceListingId,
        url:
          `https://www.jiaoyimao.com/jg2007840/${sourceListingId}.html`,
        title: `商品 ${sourceListingId}`,
        rawText: "商品卡片可见文本",
        priceCny: 4300
      }
    ]
  };
}

function detailBatch(
  sequence = 1,
  sourceListingId = "1785384225212552",
  actionPermit?: string
): BrowserDetailBatch {
  return {
    sequence,
    items: [
      {
        sourceListingId,
        url:
          `https://www.jiaoyimao.com/jg2007840/${sourceListingId}.html`,
        observedAt: now.toISOString(),
        sections: {
          head: "商品标题",
          report: "举报信息",
          safety: "安全保障",
          description: "商品描述"
        }
      }
    ],
    ...(actionPermit ? { actionPermit } : {})
  };
}

function loadEvent(
  sequence = 1,
  overrides: Partial<BrowserLoadEvent> = {}
): BrowserLoadEvent {
  return {
    sequence,
    observedUniqueCount: sequence,
    newItemCount: 1,
    visibleTotalCount: null,
    endMarkerVisible: false,
    loadingVisible: false,
    blockingState: "none",
    observedAt: new Date(now.getTime() + sequence * 1_000).toISOString(),
    ...overrides
  };
}

function makeRepository(): {
  database: DatabaseSync;
  repository: BrowserRefreshRepository;
} {
  const database = createDatabase(":memory:");
  return {
    database,
    repository: new BrowserRefreshRepository(database)
  };
}

function claim(
  repository: BrowserRefreshRepository,
  at = now
): {
  id: string;
  bridgeToken: string;
  claimCode: string;
} {
  const created = repository.createJob(at);
  const claimed = repository.claimJob(created.id, created.claimCode, at);
  return {
    id: created.id,
    claimCode: created.claimCode,
    bridgeToken: claimed.bridgeToken
  };
}

describe("browser refresh database migration", () => {
  it("creates all staging tables, foreign keys, indexes, and scan scope columns", () => {
    const database = createDatabase(":memory:");
    const tables = (
      database.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'browser_refresh_%'
        ORDER BY name
      `).all() as { name: string }[]
    ).map(({ name }) => name);
    expect(tables).toEqual([
      "browser_refresh_batches",
      "browser_refresh_details",
      "browser_refresh_filter_proofs",
      "browser_refresh_jobs",
      "browser_refresh_list_items",
      "browser_refresh_load_events"
    ]);
    expect(
      database.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name = 'browser_refresh_one_active_jiaoyimao'
      `).get()
    ).toBeDefined();
    expect(
      (
        database.prepare("PRAGMA table_info(scan_runs)").all() as {
          name: string;
        }[]
      ).map(({ name }) => name)
    ).toEqual(expect.arrayContaining(["scope", "requested_source"]));

    const jobForeignKey = database
      .prepare("PRAGMA foreign_key_list(browser_refresh_jobs)")
      .all() as { table: string; from: string; on_delete: string }[];
    expect(jobForeignKey).toContainEqual(
      expect.objectContaining({
        table: "scan_runs",
        from: "scan_run_id",
        on_delete: "CASCADE"
      })
    );
    database.close();
  });

  it("can open an already migrated database a second time", () => {
    const directory = mkdtempSync(join(tmpdir(), "sjz-browser-refresh-"));
    const path = join(directory, "database.sqlite");
    try {
      createDatabase(path).close();
      const reopened = createDatabase(path);
      expect(
        reopened.prepare("SELECT scope FROM scan_runs LIMIT 1").all()
      ).toEqual([]);
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("migrates a real pre-browser schema without losing existing data", () => {
    const directory = mkdtempSync(join(tmpdir(), "sjz-pre-browser-"));
    const path = join(directory, "database.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      PRAGMA foreign_keys = ON;
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
        error TEXT,
        pages_scanned INTEGER NOT NULL DEFAULT 0,
        stop_reason TEXT
      );
      CREATE TABLE scan_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        state TEXT NOT NULL,
        error TEXT,
        is_baseline INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE scan_source_results (
        run_id INTEGER NOT NULL,
        source TEXT NOT NULL,
        state TEXT NOT NULL,
        pages_scanned INTEGER NOT NULL,
        observed_item_count INTEGER NOT NULL,
        eligible_count INTEGER NOT NULL,
        balanced_candidate_count INTEGER NOT NULL,
        global_candidate_count INTEGER NOT NULL,
        anomaly_state TEXT NOT NULL DEFAULT 'none',
        published INTEGER NOT NULL DEFAULT 1,
        stop_reason TEXT,
        error TEXT,
        PRIMARY KEY (run_id, source),
        FOREIGN KEY (run_id) REFERENCES scan_runs(id) ON DELETE CASCADE
      );
      CREATE TABLE listing_observations (
        run_id INTEGER NOT NULL,
        listing_key TEXT NOT NULL,
        source TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        eligibility TEXT NOT NULL,
        material_hash TEXT NOT NULL,
        stability TEXT NOT NULL,
        consecutive_unchanged_scans INTEGER NOT NULL,
        snapshot_json TEXT,
        changes_json TEXT NOT NULL DEFAULT '[]',
        availability TEXT NOT NULL DEFAULT 'active',
        trusted INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (run_id, listing_key),
        FOREIGN KEY (run_id) REFERENCES scan_runs(id) ON DELETE CASCADE
      );
      CREATE TABLE source_anomaly_guards (
        source TEXT PRIMARY KEY,
        state TEXT NOT NULL DEFAULT 'clear',
        baseline_item_count INTEGER,
        baseline_pages_scanned INTEGER,
        observed_item_count INTEGER,
        observed_pages_scanned INTEGER,
        confirmation_count INTEGER NOT NULL DEFAULT 0,
        first_detected_at TEXT,
        last_detected_at TEXT,
        reason TEXT
      );
      INSERT INTO listings (
        listing_key, source, eligibility, payload
      ) VALUES ('panzhi:sentinel', 'panzhi', 'eligible',
        '{"sentinel":true}');
      INSERT INTO source_status (
        source, state, last_attempt_at, last_success_at,
        item_count, error, pages_scanned, stop_reason
      ) VALUES ('panzhi', 'success', '2026-07-29T10:00:00.000Z',
        '2026-07-29T10:00:00.000Z', 1, NULL, 3, 'end_of_pages');
      INSERT INTO scan_runs (
        id, started_at, finished_at, state, error, is_baseline
      ) VALUES (7, '2026-07-29T10:00:00.000Z',
        '2026-07-29T10:01:00.000Z', 'success', NULL, 0);
    `);
    legacy.close();

    try {
      const migrated = createDatabase(path);
      expect(
        migrated.prepare(`
          SELECT listing_key, payload FROM listings
          WHERE listing_key = 'panzhi:sentinel'
        `).get()
      ).toEqual({
        listing_key: "panzhi:sentinel",
        payload: '{"sentinel":true}'
      });
      expect(
        migrated.prepare(`
          SELECT state, item_count, pages_scanned
          FROM source_status WHERE source = 'panzhi'
        `).get()
      ).toEqual({
        state: "success",
        item_count: 1,
        pages_scanned: 3
      });
      expect(
        migrated.prepare(`
          SELECT scope, requested_source FROM scan_runs WHERE id = 7
        `).get()
      ).toEqual({
        scope: "all_sources",
        requested_source: null
      });
      expect(
        migrated.prepare(`
          SELECT COUNT(*) AS count FROM sqlite_master
          WHERE type = 'table' AND name LIKE 'browser_refresh_%'
        `).get()
      ).toEqual({ count: 6 });
      migrated.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("BrowserRefreshRepository credentials and jobs", () => {
  it("allows only one non-terminal job and releases the slot after terminal transition", () => {
    const { repository } = makeRepository();
    const first = repository.createJob(now);
    expect(() => repository.createJob(now)).toThrow(/active|进行中/i);

    repository.transition(
      first.id,
      ["awaiting_codex"],
      "cancelled",
      { reason: "user_cancelled" },
      now
    );
    expect(repository.createJob(now).id).not.toBe(first.id);
  });

  it("never exposes hashes or stores plaintext credentials and consumes the claim code", () => {
    const { database, repository } = makeRepository();
    const created = repository.createJob(now);
    expect(JSON.stringify(created)).not.toMatch(/hash/i);
    expect(JSON.stringify(repository.getJob(created.id, now))).not.toMatch(
      /hash/i
    );

    const claimed = repository.claimJob(
      created.id,
      created.claimCode,
      now
    );
    expect(JSON.stringify(claimed)).not.toMatch(/hash/i);
    const verified = repository.verifyBridgeToken(
      created.id,
      claimed.bridgeToken,
      now
    );
    expect(verified.id).toBe(created.id);
    expect(Object.keys(verified)).not.toEqual(
      expect.arrayContaining([
        "claimCodeHash",
        "bridgeTokenHash",
        "actionPermitHash"
      ])
    );
    expect(JSON.stringify(verified)).not.toMatch(/hash/i);
    const internalStatus = repository.getJobRecord(created.id, now);
    expect(Object.keys(internalStatus ?? {})).not.toEqual(
      expect.arrayContaining([
        "claimCodeHash",
        "bridgeTokenHash",
        "actionPermitHash"
      ])
    );
    expect(JSON.stringify(internalStatus)).not.toMatch(/hash/i);
    expect(() =>
      repository.claimJob(created.id, created.claimCode, now)
    ).toThrow(/claim|接管/i);
    expect(() =>
      repository.verifyBridgeToken(created.id, "wrong-token", now)
    ).toThrow(/credential|token|凭据/i);

    const row = database.prepare(`
      SELECT claim_code_hash, bridge_token_hash
      FROM browser_refresh_jobs WHERE id = ?
    `).get(created.id) as {
      claim_code_hash: string | null;
      bridge_token_hash: string | null;
    };
    expect(row.claim_code_hash).toBeNull();
    expect(row.bridge_token_hash).toMatch(/^scrypt\$/);
    expect(JSON.stringify(row)).not.toContain(created.claimCode);
    expect(JSON.stringify(row)).not.toContain(claimed.bridgeToken);
  });

  it("expires overdue jobs before reads and clears both credentials", () => {
    const { database, repository } = makeRepository();
    const created = repository.createJob(now);
    const claimed = repository.claimJob(
      created.id,
      created.claimCode,
      now
    );
    const afterExpiry = new Date(created.expiresAt);
    afterExpiry.setMilliseconds(afterExpiry.getMilliseconds() + 1);

    expect(repository.getCurrentJob(afterExpiry)).toMatchObject({
      state: "expired"
    });
    expect(repository.getJob(created.id, afterExpiry)).toMatchObject({
      state: "expired"
    });
    expect(() =>
      repository.verifyBridgeToken(
        created.id,
        claimed.bridgeToken,
        afterExpiry
      )
    ).toThrow(/expired|terminal|凭据/i);
    expect(
      database.prepare(`
        SELECT claim_code_hash, bridge_token_hash
        FROM browser_refresh_jobs WHERE id = ?
      `).get(created.id)
    ).toEqual({
      claim_code_hash: null,
      bridge_token_hash: null
    });
    expect(repository.createJob(afterExpiry).id).not.toBe(created.id);
  });
});

describe("BrowserRefreshRepository staging", () => {
  it("preserves a caller-owned transaction when an inner write fails", () => {
    const { database, repository } = makeRepository();
    const { id } = claim(repository);
    const batch = listBatch();
    repository.acceptListBatch(id, batch, now);
    database.exec(`
      CREATE TABLE transaction_sentinel (value TEXT NOT NULL);
      BEGIN;
      INSERT INTO transaction_sentinel (value) VALUES ('preserve-me');
    `);

    try {
      expect(() =>
        repository.acceptListBatch(id, {
          ...batch,
          items: [{ ...batch.items[0], title: "conflict" }]
        }, now)
      ).toThrow(/sequence|hash/i);
      expect(database.isTransaction).toBe(true);
      expect(
        database.prepare(`
          SELECT value FROM transaction_sentinel
        `).get()
      ).toEqual({ value: "preserve-me" });
    } finally {
      if (database.isTransaction) database.exec("ROLLBACK");
    }
  });

  it("rolls back proof and job updates together when the second statement fails", () => {
    const { database, repository } = makeRepository();
    const { id } = claim(repository);
    database.exec(`
      CREATE TRIGGER fail_filter_url_update
      BEFORE UPDATE OF filter_url ON browser_refresh_jobs
      BEGIN
        SELECT RAISE(ABORT, 'injected filter update failure');
      END;
    `);

    expect(() => repository.saveFilterProof(id, proof(), now)).toThrow(
      /injected filter update failure/
    );
    expect(
      database.prepare(`
        SELECT COUNT(*) AS count FROM browser_refresh_filter_proofs
        WHERE job_id = ?
      `).get(id)
    ).toEqual({ count: 0 });
    expect(
      database.prepare(`
        SELECT filter_url FROM browser_refresh_jobs WHERE id = ?
      `).get(id)
    ).toEqual({ filter_url: null });
  });

  it("persists filter proof and idempotently accepts an identical list batch", () => {
    const { database, repository } = makeRepository();
    const { id } = claim(repository);
    repository.saveFilterProof(id, proof(), now);
    const batch = listBatch();
    const first = repository.acceptListBatch(id, batch, now);
    const replay = repository.acceptListBatch(id, batch, now);

    expect(replay).toEqual(first);
    expect(first).toEqual({
      acceptedCount: 1,
      uniqueItemCount: 1,
      nextSequence: 2
    });
    expect(
      database.prepare(`
        SELECT COUNT(*) AS count FROM browser_refresh_list_items
        WHERE job_id = ?
      `).get(id)
    ).toEqual({ count: 1 });
    expect(() =>
      repository.acceptListBatch(id, {
        ...batch,
        items: [{ ...batch.items[0], title: "变更后的内容" }]
      }, now)
    ).toThrow(/sequence|hash|序号/i);
  });

  it("requires a staged list item before accepting detail evidence", () => {
    const { repository } = makeRepository();
    const { id } = claim(repository);
    expect(() =>
      repository.acceptDetailBatch(id, detailBatch(), now)
    ).toThrow(/list|列表|staged/i);
  });

  it("returns the original detail progress on exact replay before checking a consumed permit", () => {
    const { database, repository } = makeRepository();
    const { id } = claim(repository);
    repository.acceptListBatch(id, listBatch(), now);
    const permit = "short-lived-action-permit";
    repository.transition(
      id,
      ["collecting_list"],
      "collecting_details",
      {
        detailRequiredCount: 1,
        actionPermit: permit,
        actionPermitExpiresAt: new Date(
          now.getTime() + 60_000
        ).toISOString()
      },
      now
    );

    const batch = detailBatch(1, "1785384225212552", permit);
    const first = repository.acceptDetailBatch(id, batch, now);
    expect(first).toEqual({
      acceptedCount: 1,
      detailCompletedCount: 1,
      detailRequiredCount: 1,
      nextSourceListingId: null,
      nextSequence: 2
    });
    expect(repository.acceptDetailBatch(id, batch, now)).toEqual(first);
    expect(
      database.prepare(`
        SELECT action_permit_consumed_at
        FROM browser_refresh_jobs WHERE id = ?
      `).get(id)
    ).toEqual({ action_permit_consumed_at: now.toISOString() });
    expect(() =>
      repository.acceptDetailBatch(id, {
        ...batch,
        items: [{
          ...batch.items[0],
          sections: { ...batch.items[0].sections, head: "冲突" }
        }]
      }, now)
    ).toThrow(/sequence|hash|序号/i);
  });

  it("accepts maximum bounded progress and replays its detail result exactly", () => {
    const { database, repository } = makeRepository();
    const { id } = claim(repository);
    repository.acceptListBatch(id, listBatch(), now);
    const insertListItem = database.prepare(`
      INSERT INTO browser_refresh_list_items (
        job_id, source_listing_id, url, title, raw_text,
        price_cny, last_batch_sequence, observed_at
      ) VALUES (?, ?, ?, 'fixture', 'fixture', NULL, 1, ?)
    `);
    const insertDetail = database.prepare(`
      INSERT INTO browser_refresh_details (
        job_id, source_listing_id, url, evidence_json, observed_at
      ) VALUES (?, ?, ?, '{}', ?)
    `);
    database.exec("BEGIN IMMEDIATE");
    try {
      for (let index = 1; index < 2_000; index += 1) {
        const sourceListingId = `${1_000_000 + index}`;
        const url =
          `https://www.jiaoyimao.com/jg2007840/` +
          `${sourceListingId}.html`;
        insertListItem.run(
          id,
          sourceListingId,
          url,
          now.toISOString()
        );
        insertDetail.run(
          id,
          sourceListingId,
          url,
          now.toISOString()
        );
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    const bounded = repository.transition(
      id,
      ["collecting_list"],
      "collecting_details",
      {
        detailRequiredCount: 2_000,
        detailCompletedCount: 2_000,
        uniqueItemCount: 2_000,
        itemCount: 2_000,
        listBatchCursor: 2_000,
        loadActionCount: 100,
        cooldownAttempt: 4
      },
      now
    );
    expect(bounded).toMatchObject({
      detailRequiredCount: 2_000,
      detailCompletedCount: 2_000,
      uniqueItemCount: 2_000,
      itemCount: 2_000,
      listBatchCursor: 2_000,
      loadActionCount: 100,
      cooldownAttempt: 4
    });

    const batch = detailBatch();
    const accepted = repository.acceptDetailBatch(id, batch, now);
    expect(accepted).toMatchObject({
      detailCompletedCount: 2_000,
      detailRequiredCount: 2_000
    });
    expect(repository.acceptDetailBatch(id, batch, now)).toEqual(
      accepted
    );
  });

  it("rejects operational counters above their safety limits before persistence", () => {
    const { repository } = makeRepository();
    const { id } = claim(repository);
    const invalidPatches = [
      { detailRequiredCount: 2_001 },
      { detailCompletedCount: 2_001 },
      { uniqueItemCount: 2_001 },
      { itemCount: 2_001 },
      { listBatchCursor: 2_001 },
      { loadActionCount: 101 },
      { cooldownAttempt: 5 }
    ];

    for (const patch of invalidPatches) {
      expect(() =>
        repository.transition(
          id,
          ["collecting_list"],
          "collecting_list",
          patch,
          now
        )
      ).toThrow(/limit|bounded|counter/i);
      expect(repository.getJob(id, now)).toMatchObject({
        detailRequiredCount: 0,
        detailCompletedCount: 0,
        uniqueItemCount: 0,
        itemCount: 0,
        listBatchCursor: 0,
        loadActionCount: 0,
        cooldownAttempt: 0
      });
    }
  });

  it("rejects list, detail, and load sequences beyond bounded cursors", () => {
    const list = makeRepository();
    const listJob = claim(list.repository);
    list.repository.transition(
      listJob.id,
      ["collecting_list"],
      "collecting_list",
      { listBatchCursor: 2_000 },
      now
    );
    expect(() =>
      list.repository.acceptListBatch(
        listJob.id,
        listBatch(2_001),
        now
      )
    ).toThrow(/limit|bounded/i);

    const detail = makeRepository();
    const detailJob = claim(detail.repository);
    detail.repository.acceptListBatch(
      detailJob.id,
      listBatch(),
      now
    );
    detail.database.prepare(`
      INSERT INTO browser_refresh_batches (
        job_id, kind, sequence, payload_hash, accepted_count,
        accepted_result_json, created_at
      ) VALUES (?, 'detail', 2000, 'fixture', 1, ?, ?)
    `).run(
      detailJob.id,
      JSON.stringify({
        acceptedCount: 1,
        detailCompletedCount: 0,
        detailRequiredCount: 0,
        nextSourceListingId: "1785384225212552",
        nextSequence: 2001
      }),
      now.toISOString()
    );
    expect(() =>
      detail.repository.acceptDetailBatch(
        detailJob.id,
        detailBatch(2_001),
        now
      )
    ).toThrow(/limit|bounded/i);

    const load = makeRepository();
    const loadJob = claim(load.repository);
    load.repository.acceptListBatch(loadJob.id, listBatch(), now);
    load.repository.transition(
      loadJob.id,
      ["collecting_list"],
      "collecting_list",
      { loadActionCount: 99 },
      now
    );
    load.database.prepare(`
      INSERT INTO browser_refresh_load_events (
        job_id, sequence, payload_hash, accepted_result_json,
        observed_unique_count, new_item_count, visible_total_count,
        end_marker_visible, loading_visible, blocking_state, observed_at
      ) VALUES (?, 100, 'fixture', ?, 1, 0, NULL, 0, 0, 'none', ?)
    `).run(
      loadJob.id,
      JSON.stringify({
        acceptedCount: 1,
        loadActionCount: 99,
        nextSequence: 101
      }),
      now.toISOString()
    );
    expect(() =>
      load.repository.acceptLoadEvent(
        loadJob.id,
        loadEvent(101, {
          observedUniqueCount: 1,
          newItemCount: 0
        }),
        now
      )
    ).toThrow(/limit|bounded/i);
  });

  it("validates load event ordering, monotonic counts, and exact replay", () => {
    const { repository } = makeRepository();
    const { id } = claim(repository);
    repository.acceptListBatch(id, listBatch(), now);
    const event = loadEvent();
    const accepted = repository.acceptLoadEvent(id, event, now);
    expect(repository.acceptLoadEvent(id, event, now)).toEqual(accepted);
    expect(accepted).toEqual({
      acceptedCount: 1,
      loadActionCount: 1,
      nextSequence: 2
    });
    expect(() =>
      repository.acceptLoadEvent(id, loadEvent(3), now)
    ).toThrow(/sequence|序号/i);
    expect(() =>
      repository.acceptLoadEvent(
        id,
        loadEvent(2, { observedUniqueCount: 0 }),
        now
      )
    ).toThrow(/monotonic|unique|数量/i);
  });

  it("returns the original load progress when an old event is replayed", () => {
    const { repository } = makeRepository();
    const { id } = claim(repository);
    repository.acceptListBatch(id, listBatch(), now);
    repository.transition(
      id,
      ["collecting_list"],
      "collecting_list",
      { loadActionCount: 7 },
      now
    );
    const first = loadEvent(1);
    const original = repository.acceptLoadEvent(id, first, now);
    expect(original.loadActionCount).toBe(8);
    repository.transition(
      id,
      ["collecting_list"],
      "collecting_list",
      { loadActionCount: 12 },
      now
    );

    expect(repository.acceptLoadEvent(id, first, now)).toEqual(original);
  });

  it("rejects noncanonical action-permit expiry timestamps", () => {
    const { repository } = makeRepository();
    const { id } = claim(repository);
    for (const expiresAt of [
      "2026-07-30T18:01:00.000+08:00",
      "2026-07-30T10:01:00Z",
      "not-a-date"
    ]) {
      expect(() =>
        repository.transition(
          id,
          ["collecting_list"],
          "collecting_list",
          {
            actionPermit: "permit",
            actionPermitExpiresAt: expiresAt
          },
          now
        )
      ).toThrow(/canonical|timestamp|expiry/i);
    }
  });

  it("compares persisted action-permit expiry by epoch milliseconds", () => {
    const { database, repository } = makeRepository();
    const { id } = claim(repository);
    repository.acceptListBatch(id, listBatch(), now);
    repository.transition(
      id,
      ["collecting_list"],
      "collecting_list",
      {
        actionPermit: "permit",
        actionPermitExpiresAt: new Date(
          now.getTime() + 60_000
        ).toISOString()
      },
      now
    );
    database.prepare(`
      UPDATE browser_refresh_jobs
      SET action_permit_expires_at = 'not-a-date'
      WHERE id = ?
    `).run(id);

    expect(() =>
      repository.acceptLoadEvent(
        id,
        { ...loadEvent(), actionPermit: "permit" },
        now
      )
    ).toThrow(/permit|expiry|expired/i);
  });

  it("reports corrupted replay JSON with a stable sanitized error", () => {
    const { database, repository } = makeRepository();
    const { id } = claim(repository);
    const batch = listBatch();
    repository.acceptListBatch(id, batch, now);
    database.prepare(`
      UPDATE browser_refresh_batches
      SET accepted_result_json = '{"private":"raw-corruption"}'
      WHERE job_id = ? AND kind = 'list' AND sequence = 1
    `).run(id);

    let caught: unknown;
    try {
      repository.acceptListBatch(id, batch, now);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "browser_refresh_corrupt_replay",
      message: "Stored browser refresh replay result is corrupt"
    });
    expect(String(caught)).not.toContain("raw-corruption");
  });
});

describe("BrowserRefreshRepository recovery and cleanup", () => {
  it("rejects every transition from an already terminal job", () => {
    const cancelled = makeRepository();
    const cancelledJob = cancelled.repository.createJob(now);
    cancelled.repository.transition(
      cancelledJob.id,
      ["awaiting_codex"],
      "cancelled",
      { reason: "first" },
      now
    );
    expect(() =>
      cancelled.repository.transition(
        cancelledJob.id,
        ["cancelled"],
        "cancelled",
        { reason: "rewrite", listBatchCursor: 9 },
        new Date(now.getTime() + 1_000)
      )
    ).toThrow(/terminal/i);

    const successful = makeRepository();
    const scanRunId = new ListingRepository(
      successful.database
    ).startScan(now);
    const successJob = successful.repository.createJob(now);
    successful.repository.transition(
      successJob.id,
      ["awaiting_codex"],
      "success",
      { scanRunId, publishedRunId: scanRunId },
      now
    );
    expect(() =>
      successful.repository.transition(
        successJob.id,
        ["success"],
        "success",
        { reason: "rewrite", listBatchCursor: 9 },
        new Date(now.getTime() + 1_000)
      )
    ).toThrow(/terminal/i);
  });

  it("enforces terminal run linkage for direct database writes", () => {
    const { database, repository } = makeRepository();
    const created = repository.createJob(now);

    expect(() =>
      database.prepare(`
        UPDATE browser_refresh_jobs
        SET state = 'success'
        WHERE id = ?
      `).run(created.id)
    ).toThrow(/link/i);
  });

  it("rejects terminal transitions without valid formal scan linkage", () => {
    const { database, repository } = makeRepository();
    const listingRepository = new ListingRepository(database);
    const firstRun = listingRepository.startScan(now);
    const secondRun = listingRepository.startScan(now);

    const invalidTransitions = [
      {
        next: "success" as const,
        patch: {}
      },
      {
        next: "success" as const,
        patch: { scanRunId: firstRun }
      },
      {
        next: "success" as const,
        patch: {
          scanRunId: firstRun,
          publishedRunId: secondRun
        }
      },
      {
        next: "quarantined" as const,
        patch: {}
      },
      {
        next: "quarantined" as const,
        patch: {
          scanRunId: firstRun,
          publishedRunId: firstRun
        }
      },
      {
        next: "failed" as const,
        patch: {
          scanRunId: firstRun,
          publishedRunId: firstRun
        }
      }
    ];

    for (const { next, patch } of invalidTransitions) {
      const created = repository.createJob(now);
      expect(() =>
        repository.transition(
          created.id,
          ["awaiting_codex"],
          next,
          patch,
          now
        )
      ).toThrow(/scan|published|link/i);
      repository.transition(
        created.id,
        ["awaiting_codex"],
        "cancelled",
        {},
        now
      );
    }
  });

  it.each(["success", "quarantined"] as const)(
    "does not clean staging for an invalid %s row without scan linkage",
    (state) => {
      const { database, repository } = makeRepository();
      const { id } = claim(repository);
      repository.acceptListBatch(id, listBatch(), now);
      database.exec(
        "DROP TRIGGER browser_refresh_jobs_terminal_link_update"
      );
      database.prepare(`
        UPDATE browser_refresh_jobs
        SET state = ?, finished_at = ?, updated_at = ?
        WHERE id = ?
      `).run(state, now.toISOString(), now.toISOString(), id);

      expect(() => repository.cleanupTerminalStaging(now)).toThrow(
        /scan|published|link/i
      );
      expect(
        database.prepare(`
          SELECT COUNT(*) AS count FROM browser_refresh_list_items
          WHERE job_id = ?
        `).get(id)
      ).toEqual({ count: 1 });
      expect(
        database.prepare(`
          SELECT COUNT(*) AS count FROM browser_refresh_batches
          WHERE job_id = ?
        `).get(id)
      ).toEqual({ count: 1 });
    }
  );

  it("fails interrupted commits and pauses other unfinished jobs without losing cursors", () => {
    const first = makeRepository();
    const committing = claim(first.repository);
    first.repository.acceptListBatch(
      committing.id,
      listBatch(),
      now
    );
    first.database.prepare(`
      UPDATE browser_refresh_jobs SET state = 'committing'
      WHERE id = ?
    `).run(committing.id);
    first.repository.recoverInterruptedJobs(now);
    expect(first.repository.getJobRecord(committing.id, now)).toMatchObject({
      state: "failed",
      reason: "process_interrupted",
      listBatchCursor: 1
    });

    const second = makeRepository();
    const collecting = claim(second.repository);
    second.repository.acceptListBatch(collecting.id, listBatch(), now);
    second.repository.recoverInterruptedJobs(now);
    expect(second.repository.getJobRecord(collecting.id, now)).toMatchObject({
      state: "paused",
      reason: "process_interrupted",
      listBatchCursor: 1
    });
  });

  it("cleans terminal staging while retaining bounded successful audit evidence", () => {
    const { database, repository } = makeRepository();
    const listingRepository = new ListingRepository(database);
    const runId = listingRepository.startScan(now);
    const { id } = claim(repository);
    repository.saveFilterProof(id, proof(), now);
    repository.acceptListBatch(id, listBatch(), now);
    for (let sequence = 1; sequence <= 3; sequence += 1) {
      repository.acceptLoadEvent(
        id,
        loadEvent(sequence, {
          observedUniqueCount: 1,
          newItemCount: sequence === 1 ? 1 : 0
        }),
        now
      );
    }
    repository.acceptDetailBatch(id, detailBatch(), now);
    repository.transition(
      id,
      ["collecting_list"],
      "success",
      {
        scanRunId: runId,
        publishedRunId: runId,
        detailRequiredCount: 1
      },
      now
    );

    expect(repository.cleanupTerminalStaging(now)).toBeGreaterThan(0);
    expect(repository.getJob(id, now)).toMatchObject({
      state: "success",
      scanRunId: runId,
      publishedRunId: runId,
      uniqueItemCount: 1,
      loadActionCount: 3
    });
    expect(
      database.prepare(`
        SELECT COUNT(*) AS count FROM browser_refresh_load_events
        WHERE job_id = ?
      `).get(id)
    ).toEqual({ count: 2 });
    for (const table of [
      "browser_refresh_list_items",
      "browser_refresh_details",
      "browser_refresh_batches"
    ]) {
      expect(
        database.prepare(
          `SELECT COUNT(*) AS count FROM ${table} WHERE job_id = ?`
        ).get(id)
      ).toEqual({ count: 0 });
    }
    expect(
      database.prepare(`
        SELECT COUNT(*) AS count FROM browser_refresh_filter_proofs
        WHERE job_id = ?
      `).get(id)
    ).toEqual({ count: 1 });
  });

  it("keeps lightweight recent failures but prunes unlinked audit rows after 24 hours", () => {
    const { database, repository } = makeRepository();
    const { id } = claim(repository);
    repository.saveFilterProof(id, proof(), now);
    repository.acceptListBatch(id, listBatch(), now);
    repository.transition(
      id,
      ["collecting_list"],
      "failed",
      { reason: "collection_failed", lastError: "fixture" },
      now
    );
    repository.cleanupTerminalStaging(now);
    expect(repository.getJob(id, now)).toMatchObject({ state: "failed" });
    expect(
      database.prepare(`
        SELECT COUNT(*) AS count FROM browser_refresh_filter_proofs
        WHERE job_id = ?
      `).get(id)
    ).toEqual({ count: 0 });

    const afterRetention = new Date(now.getTime() + 24 * 60 * 60_000 + 1);
    repository.cleanupTerminalStaging(afterRetention);
    expect(repository.getJob(id, afterRetention)).toBeNull();
  });

  it("cascades retained evidence when normal scan history pruning removes run 51", () => {
    const { database, repository } = makeRepository();
    const listingRepository = new ListingRepository(database);
    const ids: string[] = [];
    for (let index = 0; index < 51; index += 1) {
      const at = new Date(now.getTime() + index * 1_000);
      const runId = listingRepository.startScan(at);
      const created = repository.createJob(at);
      repository.saveFilterProof(created.id, proof(at), at);
      repository.acceptListBatch(
        created.id,
        listBatch(1, `${1_000_000 + index}`),
        at
      );
      repository.acceptLoadEvent(
        created.id,
        loadEvent(1, {
          observedAt: at.toISOString(),
          observedUniqueCount: 1
        }),
        at
      );
      repository.transition(
        created.id,
        ["awaiting_codex"],
        index % 2 === 0 ? "success" : "quarantined",
        {
          scanRunId: runId,
          ...(index % 2 === 0 ? { publishedRunId: runId } : {})
        },
        at
      );
      ids.push(created.id);
      listingRepository.failScan(runId, "fixture", at);
    }

    expect(
      database.prepare(`
        SELECT COUNT(*) AS count FROM browser_refresh_jobs
        WHERE scan_run_id IS NOT NULL
      `).get()
    ).toEqual({ count: 50 });
    expect(repository.getJob(ids[0], new Date(now.getTime() + 60_000)))
      .toBeNull();
    expect(repository.getJob(ids[50], new Date(now.getTime() + 60_000)))
      .toMatchObject({ scanRunId: expect.any(Number) });
    expect(
      database.prepare(`
        SELECT COUNT(*) AS count FROM browser_refresh_filter_proofs
      `).get()
    ).toEqual({ count: 50 });
    expect(
      database.prepare(`
        SELECT COUNT(*) AS count FROM browser_refresh_load_events
      `).get()
    ).toEqual({ count: 50 });
  });
});
