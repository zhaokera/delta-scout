// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
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
    expect(repository.verifyBridgeToken(
      created.id,
      claimed.bridgeToken,
      now
    ).id).toBe(created.id);
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
});

describe("BrowserRefreshRepository recovery and cleanup", () => {
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
