// @vitest-environment node

import { createDatabase } from "../../src/server/db.js";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ListingRepository } from "../../src/server/repository.js";
import { makeListing } from "../domain/listingFactory.js";

describe("ListingRepository", () => {
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
      { pagesScanned: 5, stopReason: "request_timeout" }
    );
    expect(repository.getSourceStatuses().find(({ source }) => source === "panzhi"))
      .toMatchObject({
        state: "partial",
        itemCount: 1,
        pagesScanned: 5,
        stopReason: "request_timeout"
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
        stopReason: "captcha_required"
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
});
