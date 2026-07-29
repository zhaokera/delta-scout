import type { Listing } from "../../src/domain/listing";
import {
  selectBalancedCandidatePool,
  selectGlobalCandidatePool
} from "../../src/domain/candidatePool";
import { makeListing, makeScore } from "./listingFactory";

function scoredListing(
  source: Listing["source"],
  index: number,
  overrides: Partial<Listing> = {}
): Listing {
  return makeListing({
    key: `${source}:${index}`,
    source,
    sourceListingId: String(index),
    url: `https://example.test/${source}/${index}`,
    score: makeScore(100 - index),
    ...overrides
  });
}

describe("selectBalancedCandidatePool", () => {
  it("keeps the best ten unique eligible scored listings from each source", () => {
    const sources: Listing["source"][] = ["jiaoyimao", "panzhi", "pxb7"];
    const eligibleScored = sources.flatMap((source) =>
      Array.from({ length: 12 }, (_, index) => scoredListing(source, index))
    );
    const rejected = scoredListing("panzhi", 100, { eligibility: "rejected" });
    const unscored = scoredListing("pxb7", 101, { score: null });
    const duplicate = scoredListing("panzhi", 0, {
      score: makeScore(1),
      url: "https://example.test/duplicate-loser"
    });

    const result = selectBalancedCandidatePool([
      duplicate,
      rejected,
      ...eligibleScored.reverse(),
      unscored
    ]);

    expect(result).toHaveLength(30);
    expect(result.filter(({ source }) => source === "jiaoyimao")).toHaveLength(10);
    expect(result.filter(({ source }) => source === "panzhi")).toHaveLength(10);
    expect(result.filter(({ source }) => source === "pxb7")).toHaveLength(10);
    expect(result.map(({ key }) => key)).toEqual(
      Array.from({ length: 10 }, (_, index) =>
        sources.map((source) => `${source}:${index}`)
      )
        .flat()
    );
    expect(result.filter(({ key }) => key === "panzhi:0")).toHaveLength(1);
  });

  it("does not backfill a source with an eleventh listing from another source", () => {
    const panzhi = Array.from({ length: 12 }, (_, index) =>
      scoredListing("panzhi", index)
    );
    const pxb7 = Array.from({ length: 3 }, (_, index) =>
      scoredListing("pxb7", index, { score: makeScore(90 - index) })
    );

    const result = selectBalancedCandidatePool([...panzhi, ...pxb7]);

    expect(result).toHaveLength(13);
    expect(result.filter(({ source }) => source === "panzhi")).toHaveLength(10);
    expect(result.filter(({ source }) => source === "pxb7")).toHaveLength(3);
    expect(result.map(({ key }) => key)).not.toContain("panzhi:10");
  });

  it("returns retained listings in the complete recommendation order", () => {
    const result = selectBalancedCandidatePool([
      scoredListing("panzhi", 1, {
        score: makeScore(80),
        confidence: 90,
        priceCny: 1_000,
        capturedAt: "2026-07-28T08:00:00+08:00",
        url: "https://example.test/z"
      }),
      scoredListing("pxb7", 2, {
        score: makeScore(80),
        confidence: 90,
        priceCny: 1_000,
        capturedAt: "2026-07-28T08:00:00+08:00",
        url: "https://example.test/a"
      }),
      scoredListing("jiaoyimao", 3, {
        score: makeScore(80),
        confidence: 90,
        priceCny: 1_000,
        capturedAt: "2026-07-28T09:00:00+08:00"
      }),
      scoredListing("panzhi", 4, {
        score: makeScore(80),
        confidence: 90,
        priceCny: 900
      }),
      scoredListing("pxb7", 5, { score: makeScore(80), confidence: 95 }),
      scoredListing("jiaoyimao", 6, { score: makeScore(81) })
    ]);

    expect(result.map(({ key }) => key)).toEqual([
      "jiaoyimao:6",
      "pxb7:5",
      "panzhi:4",
      "jiaoyimao:3",
      "pxb7:2",
      "panzhi:1"
    ]);
  });
});

describe("selectGlobalCandidatePool", () => {
  it("keeps the real top thirty without source quotas", () => {
    const jiaoyimao = Array.from({ length: 35 }, (_, index) =>
      scoredListing("jiaoyimao", index)
    );
    const lowerRanked = [
      ...Array.from({ length: 3 }, (_, index) =>
        scoredListing("panzhi", 100 + index, {
          score: makeScore(20 - index)
        })
      ),
      scoredListing("pxb7", 200, {
        eligibility: "rejected",
        score: makeScore(100)
      }),
      scoredListing("pxb7", 201, { score: null })
    ];
    const duplicate = scoredListing("jiaoyimao", 0, {
      score: makeScore(1),
      url: "https://example.test/duplicate"
    });

    const result = selectGlobalCandidatePool([
      ...lowerRanked,
      duplicate,
      ...jiaoyimao.reverse()
    ]);

    expect(result).toHaveLength(30);
    expect(result.every(({ source }) => source === "jiaoyimao")).toBe(true);
    expect(result.map(({ key }) => key)).toEqual(
      Array.from({ length: 30 }, (_, index) => `jiaoyimao:${index}`)
    );
    expect(new Set(result.map(({ key }) => key)).size).toBe(30);
  });
});
