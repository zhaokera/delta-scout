import {
  assetRecoveryRate,
  compareRecommendations,
  potentialRecommendationScore,
  preciseRecommendationScore,
  scoreEligibleListings
} from "../../src/domain/score";
import {
  normalizedRecommendationScore
} from "../../src/domain/scoreAllocation";
import { makeListing, makeScore } from "./listingFactory";

const now = new Date("2026-07-28T12:00:00+08:00");
const tiedScore = makeScore(80);

describe("scoreEligibleListings", () => {
  it("uses fixed price-band values for a single candidate", () => {
    const [result] = scoreEligibleListings([makeListing()], now);

    expect(result.score).toEqual({
      total: 71,
      exactTotal: 70.9,
      preferenceAdjustment: 0,
      value: 63.66541353383458,
      safety: 10,
      dataQuality: 100,
      riskLevel: "low",
      coverage: {
        knownSafetySignals: 1,
        totalSafetySignals: 1
      },
      parts: {
        m7: 10,
        redSkins: 17,
        julang: 15,
        price: 8.365413533834587,
        assets: 13.3,
        secondRealName: 10,
        recovery: 0,
        verification: 0
      },
      valueReasons: expect.any(Array),
      safetyReasons: expect.any(Array),
      reasons: expect.any(Array)
    });
  });

  it("uses the locked price band and the fixed ¥2/M asset valuation", () => {
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

    expect(cheapResult.score?.parts.price).toBeCloseTo(13.3333);
    expect(richResult.score?.parts.price).toBeCloseTo(3.3333);
    expect(cheapResult.score?.parts.assets).toBe(5);
    expect(richResult.score?.parts.assets).toBe(25);
    expect(assetRecoveryRate(cheapResult)).toBeCloseTo(0.2);
    expect(assetRecoveryRate(richResult)).toBeCloseTo(0.2);
  });

  it("does not change one account's score when another platform adds volume", () => {
    const target = makeListing({
      key: "jiaoyimao:stable",
      source: "jiaoyimao",
      sourceListingId: "stable",
      priceCny: 2_800,
      totalAssetsM: 220
    });
    const [single] = scoreEligibleListings([target], now);
    const expanded = scoreEligibleListings([
      target,
      ...Array.from({ length: 200 }, (_, index) =>
        makeListing({
          key: `pxb7:volume-${index}`,
          source: "pxb7",
          sourceListingId: `volume-${index}`,
          priceCny: 1_900 + (index % 21) * 100,
          totalAssetsM: 50 + index
        })
      )
    ], now).find(({ key }) => key === target.key)!;

    expect(expanded.score).toEqual(single.score);
  });

  it("does not double count Haf coins when total assets are known", () => {
    const results = scoreEligibleListings([
      makeListing({ key: "panzhi:low-coins", totalAssetsM: 100, hafCoins: 1 }),
      makeListing({ key: "pxb7:high-coins", totalAssetsM: 100, hafCoins: 99_999_999 })
    ], now);

    expect(results.map(({ score }) => score?.parts.assets)).toEqual([5, 5]);
    expect(results[0].score?.valueReasons.join(" ")).toContain(
      "100.0M，按 ¥2/M 估值约 ¥200"
    );
  });

  it("uses Haf coins only as a fallback and caps asset value at 500M", () => {
    const [result] = scoreEligibleListings([
      makeListing({ totalAssetsM: null, hafCoins: 600_000_000 })
    ], now);

    expect(result.score?.parts.assets).toBe(25);
    expect(result.score?.valueReasons.join(" ")).toContain("仅按哈夫币折算");
  });

  it.each([
    ["S", 12],
    ["A", 10],
    ["B", 8],
    ["C", 6],
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
        "M7 极品品质待核验"
      );
    }
  });

  it("scores premium S below every peak grade", () => {
    const [result] = scoreEligibleListings([
      makeListing({
        m7PrismStatus: "premium",
        m7PrismQuality: "S",
        redSkins: [],
        redSkinCount: 0,
        julangStatus: "absent",
        julangQuality: null
      })
    ], now);

    expect(result.score?.parts.m7).toBe(5);
    expect(result.score?.valueReasons.join(" ")).toContain(
      "M7 优品S，品质价值 5.0/12"
    );
  });

  it("adds one non-stacking three-point bonus for trusted M7 finishes", () => {
    const [untagged] = scoreEligibleListings([
      makeListing({
        key: "panzhi:untagged",
        m7PrismQuality: "A",
        m7RareFinishes: []
      })
    ], now);
    const [tagged] = scoreEligibleListings([
      makeListing({
        key: "panzhi:tagged",
        m7PrismQuality: "A",
        m7RareFinishes: ["pearl"]
      })
    ], now);
    const [multiTagged] = scoreEligibleListings([
      makeListing({
        key: "panzhi:multi-tagged",
        m7PrismQuality: "S",
        m7RareFinishes: ["pearl", "iridescent", "candy"]
      })
    ], now);

    expect(untagged.score?.parts.m7).toBe(10);
    expect(tagged.score?.parts.m7).toBe(13);
    expect(multiTagged.score?.parts.m7).toBe(15);
    expect(tagged.score?.parts).not.toHaveProperty("m7RareFinish");
    expect(tagged.score?.valueReasons.join(" ")).toContain(
      "品质价值 10.0/12"
    );
    expect(tagged.score?.valueReasons.join(" ")).toContain(
      "M7 稀有模板：珠光 M7，价值 3.0/3"
    );
    expect(untagged.score?.valueReasons.join(" ")).toContain(
      "M7 稀有模板未发现，价值 0.0/3"
    );
  });

  it("does not let M7 rare finishes change purchase safety or risk", () => {
    const listings = [
      makeListing({
        key: "panzhi:plain",
        m7RareFinishes: [],
        secondRealNameAvailable: false,
        recoveryCoverage: true
      }),
      makeListing({
        key: "panzhi:rare",
        m7RareFinishes: ["candy"],
        secondRealNameAvailable: false,
        recoveryCoverage: true
      })
    ];
    const results = scoreEligibleListings(listings, now);
    const plain = results.find(({ key }) => key === "panzhi:plain")!;
    const rare = results.find(({ key }) => key === "panzhi:rare")!;

    expect(rare.score?.safety).toBe(plain.score?.safety);
    expect(rare.score?.riskLevel).toBe(plain.score?.riskLevel);
  });

  it("caps red-skin value at 25 points and scores Julang separately", () => {
    const [result] = scoreEligibleListings([
      makeListing({
        m7PrismQuality: "C",
        redSkins: ["威龙", "红狼", "骇爪", "蜂医", "牧羊人"],
        redSkinCount: 5,
        julangStatus: "owned"
      })
    ], now);

    expect(result.score?.parts.redSkins).toBe(25);
    expect(result.score?.parts.julang).toBe(15);
    expect(result.score?.valueReasons.join(" ")).toContain(
      "付费红皮估值约 ¥1600"
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
        knownSafetySignals: 1,
        totalSafetySignals: 1
      },
      parts: {
        secondRealName: 0,
        recovery: 0,
        verification: 0
      }
    });
    expect(result.score?.safetyReasons.join(" ")).toContain("不可二次实名");
    expect(result.score?.safetyReasons.join(" ")).toContain(
      "永久包赔仅作参考，不参与评分：页面显示不支持"
    );
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
        totalSafetySignals: 1
      }
    });
  });

  it("does not let known verification rescue unknown secondary-real-name evidence", () => {
    const [result] = scoreEligibleListings([
      makeListing({
        secondRealNameAvailable: null,
        verificationAt: "2026-07-27T10:00:00+08:00"
      })
    ], now);

    expect(result.score).toMatchObject({
      safety: 0,
      riskLevel: "unknown",
      coverage: {
        knownSafetySignals: 0,
        totalSafetySignals: 1
      }
    });
  });

  it("does not let known verification rescue unavailable secondary real-name", () => {
    const [result] = scoreEligibleListings([
      makeListing({
        secondRealNameAvailable: false,
        verificationAt: "2026-07-27T10:00:00+08:00"
      })
    ], now);

    expect(result.score).toMatchObject({
      safety: 0,
      riskLevel: "high",
      coverage: {
        knownSafetySignals: 1,
        totalSafetySignals: 1
      }
    });
  });

  it("treats known secondary-real-name evidence as complete without verification time", () => {
    const [missingVerification] = scoreEligibleListings([
      makeListing({ verificationAt: null })
    ], now);

    expect(missingVerification.score).toMatchObject({
      riskLevel: "low",
      coverage: {
        knownSafetySignals: 1,
        totalSafetySignals: 1
      }
    });
  });

  it("keeps recent, stale, and missing verification reference-only", () => {
    const results = [
      "2026-07-27T10:00:00+08:00",
      "2026-05-01T00:00:00.000Z",
      null
    ].map((verificationAt, index) => scoreEligibleListings([
      makeListing({ key: `panzhi:verification-${index}`, verificationAt })
    ], now)[0]);
    const scoredFields = results.map(({ score }) => ({
      total: score?.total,
      exactTotal: score?.exactTotal,
      safety: score?.safety,
      dataQuality: score?.dataQuality,
      coverage: score?.coverage,
      riskLevel: score?.riskLevel
    }));

    expect(scoredFields[1]).toEqual(scoredFields[0]);
    expect(scoredFields[2]).toEqual(scoredFields[0]);
    expect(scoredFields[0]).toMatchObject({
      safety: 10,
      coverage: { knownSafetySignals: 1, totalSafetySignals: 1 },
      riskLevel: "low"
    });
    const [recent, stale, missing] = results;
    expect(recent.score?.parts.verification).toBe(0);
    expect(stale.score?.parts.verification).toBe(0);
    expect(missing.score?.parts.verification).toBe(0);
    expect(recent.score?.safetyReasons.join(" ")).toContain("距今 1 天");
    expect(stale.score?.safetyReasons.join(" ")).toContain(
      "验号时间仅作参考，不参与评分"
    );
    expect(missing.score?.safetyReasons.join(" ")).toContain("待人工核验");
  });

  it("never lets permanent recovery coverage change score, quality, coverage, or risk", () => {
    const results = scoreEligibleListings([
      makeListing({ key: "panzhi:covered", recoveryCoverage: true }),
      makeListing({ key: "pxb7:uncovered", recoveryCoverage: false }),
      makeListing({ key: "jiaoyimao:unknown", recoveryCoverage: null })
    ], now);

    const scoredFields = results.map(({ score }) => ({
      total: score?.total,
      exactTotal: score?.exactTotal,
      safety: score?.safety,
      dataQuality: score?.dataQuality,
      risk: score?.riskLevel,
      recovery: score?.parts.recovery,
      coverage: score?.coverage
    }));

    expect(scoredFields[1]).toEqual(scoredFields[0]);
    expect(scoredFields[2]).toEqual(scoredFields[0]);
    expect(scoredFields[0]).toMatchObject({
      total: 71,
      exactTotal: 70.9,
      safety: 10,
      dataQuality: 100,
      risk: "low",
      recovery: 0,
      coverage: { knownSafetySignals: 1, totalSafetySignals: 1 }
    });
  });

  it("lets a ban note override confirmed secondary-real-name availability", () => {
    const [result] = scoreEligibleListings([
      makeListing({
        secondRealNameAvailable: true,
        banNotes: ["存在封禁记录"]
      })
    ], now);

    expect(result.score).toMatchObject({
      safety: 10,
      riskLevel: "high",
      coverage: { knownSafetySignals: 1, totalSafetySignals: 1 }
    });
    expect(result.score?.safetyReasons.join(" ")).toContain("存在封禁记录");
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

    expect(result.score?.value).toBeCloseTo(29.2952380952);
    expect(result.score?.safety).toBe(10);
    expect(result.score?.dataQuality).toBe(80);
    expect(result.score?.total).toBe(
      Math.round(normalizedRecommendationScore(
        result.score?.value ?? 0,
        10,
        80
      ))
    );
  });

  it("keeps unknown value out of the confirmed score but exposes its upside", () => {
    const [unknown] = scoreEligibleListings([
      makeListing({
        m7PrismStatus: "absent",
        m7PrismQuality: null,
        julangStatus: "unknown",
        julangQuality: null
      })
    ], now);
    const [absent] = scoreEligibleListings([
      makeListing({
        m7PrismStatus: "absent",
        m7PrismQuality: null,
        julangStatus: "absent",
        julangQuality: null
      })
    ], now);

    expect(unknown.score?.parts.julang).toBe(0);
    expect(potentialRecommendationScore(unknown)).toBeGreaterThan(
      unknown.score?.total ?? 0
    );
    expect(potentialRecommendationScore(absent)).toBe(
      preciseRecommendationScore(absent.score!)
    );
  });

  it("keeps an otherwise eligible account without M7 in unified scoring", () => {
    const [result] = scoreEligibleListings([
      makeListing({
        m7PrismStatus: "absent",
        m7PrismQuality: null,
        m7Evidence: [],
        redSkins: ["威龙", "红狼"],
        redSkinCount: 2
      })
    ], now);

    expect(result.score?.parts.m7).toBe(0);
    expect(result.score?.parts.redSkins).toBe(22);
    expect(result.score?.valueReasons.join(" ")).toContain("M7 未发现");
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
