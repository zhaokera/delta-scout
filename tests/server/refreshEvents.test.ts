import { describe, expect, it } from "vitest";
import { makeListing, makeScore } from "../domain/listingFactory.js";
import { detectRefreshEvents } from "../../src/server/refreshEvents.js";

function candidate(id: string, score: number) {
  return makeListing({
    key: `pxb7:${id}`,
    source: "pxb7",
    sourceListingId: id,
    url: `https://www.pxb7.com/product/${id}/1`,
    score: makeScore(score)
  });
}

describe("refresh events", () => {
  it("detects price, recovery, valuable M7, safety and removal changes", () => {
    const changedBefore = candidate("100", 70);
    const changedAfter = {
      ...changedBefore,
      priceCny: 2500,
      totalAssetsM: 500,
      m7RareFinishes: ["pearl" as const],
      recoveryCoverage: false
    };
    const removed = candidate("200", 60);
    const events = detectRefreshEvents({
      runId: 9,
      before: [changedBefore, removed],
      after: [changedAfter],
      refreshedSources: new Set(["pxb7"]),
      createdAt: new Date("2026-08-02T06:00:00.000Z")
    });

    expect(events.map(({ type }) => type)).toEqual(
      expect.arrayContaining([
        "price_drop",
        "asset_recovery_up",
        "valuable_m7",
        "safety_changed",
        "removed"
      ])
    );
  });

  it("reports a newly promoted global Top10 candidate", () => {
    const before = Array.from({ length: 11 }, (_, index) =>
      candidate(String(index + 1), 90 - index)
    );
    const promoted = candidate("11", 99);
    const after = before.map((listing) =>
      listing.key === promoted.key ? promoted : listing
    );
    const events = detectRefreshEvents({
      runId: 10,
      before,
      after,
      refreshedSources: new Set(["pxb7"]),
      createdAt: new Date("2026-08-02T06:00:00.000Z")
    });

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "new_top10",
          listingKey: "pxb7:11",
          severity: "opportunity"
        })
      ])
    );
  });

  it("does not report removals for an incomplete source snapshot", () => {
    const removed = candidate("partial-miss", 60);
    const events = detectRefreshEvents({
      runId: 11,
      before: [removed],
      after: [],
      refreshedSources: new Set(["pxb7"]),
      removalSources: new Set(),
      createdAt: new Date("2026-08-02T06:00:00.000Z")
    });

    expect(events).toEqual([]);
  });
});
