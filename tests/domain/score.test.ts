import {
  compareRecommendations,
  scoreEligibleListings
} from "../../src/domain/score";
import { makeListing, makeScore } from "./listingFactory";

const now = new Date("2026-07-28T12:00:00+08:00");
const tiedScore = makeScore(80);

describe("scoreEligibleListings", () => {
  it("uses neutral set-relative values for a single candidate", () => {
    const [result] = scoreEligibleListings([makeListing()], now);

    expect(result.score).toEqual({
      total: 80,
      value: 63.5,
      safety: 100,
      dataQuality: 100,
      riskLevel: "low",
      coverage: {
        knownSafetySignals: 3,
        totalSafetySignals: 3
      },
      parts: {
        m7: 29,
        redSkins: 4,
        julang: 15,
        price: 10,
        assets: 5.5,
        secondRealName: 40,
        recovery: 35,
        verification: 25
      },
      valueReasons: expect.any(Array),
      safetyReasons: expect.any(Array),
      reasons: expect.any(Array)
    });
  });

  it("uses robust ranks for price and assets across eligible candidates", () => {
    const cheap = makeListing({
      key: "panzhi:cheap",
      sourceListingId: "cheap",
      priceCny: 1_000,
      totalAssetsM: 100,
      hafCoins: 10
    });
    const rich = makeListing({
      key: "pxb7:rich",
      source: "pxb7",
      sourceListingId: "rich",
      priceCny: 5_000,
      totalAssetsM: 500,
      hafCoins: 50
    });

    const results = scoreEligibleListings([cheap, rich], now);
    const cheapResult = results.find(({ key }) => key === cheap.key)!;
    const richResult = results.find(({ key }) => key === rich.key)!;

    expect(cheapResult.score?.parts.price).toBe(20);
    expect(richResult.score?.parts.price).toBe(0);
    expect(cheapResult.score?.parts.assets).toBe(1);
    expect(richResult.score?.parts.assets).toBe(10);
  });

  it.each([
    ["S", 35],
    ["A", 29],
    ["B", 23],
    ["C", 17],
    [null, 0]
  ] as const)("scores M7 quality %s explicitly", (quality, expected) => {
    const [result] = scoreEligibleListings([
      makeListing({
        m7PrismQuality: quality,
        redSkins: [],
        redSkinCount: 0,
        julangStatus: "absent",
        julangQuality: null
      })
    ], now);

    expect(result.score?.parts.m7).toBe(expected);
    if (quality === null) {
      expect(result.score?.valueReasons.join(" ")).toContain(
        "极品品质待核验"
      );
    }
  });

  it("caps red-skin value at five and scores Julang separately", () => {
    const [result] = scoreEligibleListings([
      makeListing({
        m7PrismQuality: "C",
        redSkins: ["威龙", "红狼", "骇爪", "蜂医", "牧羊人"],
        redSkinCount: 5,
        julangStatus: "owned"
      })
    ], now);

    expect(result.score?.parts.redSkins).toBe(20);
    expect(result.score?.parts.julang).toBe(15);
    expect(result.score?.valueReasons.join(" ")).toContain(
      "5 个已识别角色红皮"
    );
    expect(result.score?.valueReasons.join(" ")).toContain("巨浪已拥有");
  });

  it("does not reward known negative safety values", () => {
    const [result] = scoreEligibleListings([
      makeListing({
        secondRealNameAvailable: false,
        recoveryCoverage: false,
        verificationAt: null
      })
    ], now);

    expect(result.score).toMatchObject({
      safety: 0,
      riskLevel: "high",
      coverage: {
        knownSafetySignals: 2,
        totalSafetySignals: 3
      },
      parts: {
        secondRealName: 0,
        recovery: 0,
        verification: 0
      }
    });
    expect(result.score?.safetyReasons.join(" ")).toContain("不可二次实名");
    expect(result.score?.safetyReasons.join(" ")).toContain("无包赔");
  });

  it("marks all-unknown safety evidence as unknown instead of safe", () => {
    const [result] = scoreEligibleListings([
      makeListing({
        secondRealNameAvailable: null,
        recoveryCoverage: null,
        verificationAt: null
      })
    ], now);

    expect(result.score).toMatchObject({
      safety: 0,
      riskLevel: "unknown",
      coverage: {
        knownSafetySignals: 0,
        totalSafetySignals: 3
      }
    });
  });

  it("uses medium risk for incomplete or stale safety evidence", () => {
    const [missing] = scoreEligibleListings([
      makeListing({ recoveryCoverage: null })
    ], now);
    const [stale] = scoreEligibleListings([
      makeListing({
        verificationAt: "2026-05-01T00:00:00.000Z"
      })
    ], now);

    expect(missing.score?.riskLevel).toBe("medium");
    expect(stale.score?.riskLevel).toBe("medium");
  });

  it("makes the combined recommendation formula explicit", () => {
    const [result] = scoreEligibleListings([
      makeListing({
        confidence: 80,
        secondRealNameAvailable: true,
        recoveryCoverage: false,
        verificationAt: null,
        m7PrismQuality: "S",
        redSkins: [],
        julangStatus: "absent",
        totalAssetsM: null,
        hafCoins: null
      })
    ], now);

    expect(result.score?.value).toBe(45);
    expect(result.score?.safety).toBe(40);
    expect(result.score?.dataQuality).toBe(80);
    expect(result.score?.total).toBe(
      Math.round(45 * 0.55 + 40 * 0.35 + 80 * 0.1)
    );
  });

  it("sorts ties by confidence, price, capture time, then URL", () => {
    const lowerConfidence = makeListing({
      key: "panzhi:low-confidence",
      confidence: 80
    });
    const higherConfidence = makeListing({
      key: "pxb7:high-confidence",
      source: "pxb7",
      confidence: 100
    });

    const [first] = scoreEligibleListings(
      [lowerConfidence, higherConfidence],
      now
    );

    expect(first.key).toBe("pxb7:high-confidence");
  });

  it("exports the complete recommendation comparator", () => {
    const lowerConfidence = makeListing({ score: tiedScore, confidence: 90 });
    const lowerPrice = makeListing({
      key: "panzhi:lower-price",
      score: tiedScore,
      confidence: 95,
      priceCny: 100
    });
    const newerCapture = makeListing({
      key: "panzhi:newer-capture",
      score: tiedScore,
      confidence: 95,
      priceCny: 100,
      capturedAt: "2026-07-28T11:00:00+08:00"
    });
    const earlierUrl = makeListing({
      key: "panzhi:earlier-url",
      score: tiedScore,
      confidence: 95,
      priceCny: 100,
      capturedAt: "2026-07-28T11:00:00+08:00",
      url: "https://example.test/a"
    });

    expect(
      [lowerConfidence, lowerPrice, newerCapture, earlierUrl].sort(
        compareRecommendations
      )
    ).toEqual([earlierUrl, newerCapture, lowerPrice, lowerConfidence]);
  });

  it("ranks a zero score above a missing score", () => {
    const zeroScore = makeListing({
      key: "panzhi:zero-score",
      score: makeScore(0),
      confidence: 0,
      priceCny: 9_999
    });
    const missingScore = makeListing({
      key: "panzhi:missing-score",
      score: null,
      confidence: 100,
      priceCny: 0
    });

    expect([missingScore, zeroScore].sort(compareRecommendations)).toEqual([
      zeroScore,
      missingScore
    ]);
  });

  it("scores 6000 candidates without rebuilding normalization ranges per item", () => {
    const candidates = Array.from({ length: 6_000 }, (_, index) =>
      makeListing({
        key: `panzhi:bulk-${index}`,
        sourceListingId: `bulk-${index}`,
        url: `https://example.test/bulk/${index}`,
        priceCny: index + 1,
        totalAssetsM: null,
        hafCoins: null
      })
    );
    const originalMinimum = Math.min;
    let minimumCalls = 0;
    let results = candidates;
    Math.min = (...values: number[]) => {
      minimumCalls += 1;
      return originalMinimum(...values);
    };
    try {
      results = scoreEligibleListings(candidates, now);
    } finally {
      Math.min = originalMinimum;
    }

    expect(results).toHaveLength(6_000);
    expect(results[0].priceCny).toBe(1);
    expect(results.at(-1)?.priceCny).toBe(6_000);
    expect(minimumCalls).toBeLessThanOrEqual(1);
  });
});
