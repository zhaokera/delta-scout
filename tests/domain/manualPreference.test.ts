import {
  applyManualPreferenceFeedback,
  manualPreferenceAdjustment
} from "../../src/domain/manualPreference";
import type { ReviewedListing } from "../../src/domain/manualReview";
import { makeListing, makeScore } from "./listingFactory";

function reviewed(
  key: string,
  overrides: Partial<ReviewedListing> = {}
): ReviewedListing {
  return {
    ...makeListing({
      key,
      sourceListingId: key,
      score: makeScore(70, {
        m7: 13,
        assets: 5
      })
    }),
    manualReview: null,
    ...overrides
  };
}

function excluded(
  key: string,
  reason: NonNullable<ReviewedListing["manualReview"]>["reason"],
  overrides: Partial<ReviewedListing> = {}
): ReviewedListing {
  return reviewed(key, {
    manualReview: {
      excluded: true,
      reason,
      note: null,
      reviewedAt: "2026-08-01T00:00:00.000Z"
    },
    ...overrides
  });
}

describe("applyManualPreferenceFeedback", () => {
  it("applies a small transparent price penalty to similar candidates", () => {
    const feedback = excluded("panzhi:feedback", "price_overvalued", {
      priceCny: 4_000,
      score: {
        ...makeScore(72),
        value: 55,
        safety: 90,
        dataQuality: 100
      }
    });
    const candidate = reviewed("pxb7:candidate", {
      priceCny: 3_800,
      score: {
        ...makeScore(75),
        value: 60,
        safety: 90,
        dataQuality: 100
      }
    });

    const [result] = applyManualPreferenceFeedback(
      [candidate],
      [feedback]
    );

    expect(manualPreferenceAdjustment(result.score!)).toBe(-1);
    expect(result.score?.reasons.join(" ")).toContain("价格虚高");
    expect(result.score?.reasons.join(" ")).toContain("不改变硬条件");
  });

  it("does not penalize materially cheaper or more valuable candidates", () => {
    const feedback = excluded("panzhi:feedback", "price_overvalued", {
      priceCny: 4_000,
      score: {
        ...makeScore(72),
        value: 55,
        safety: 90,
        dataQuality: 100
      }
    });
    const cheaper = reviewed("pxb7:cheap", {
      priceCny: 3_000,
      score: {
        ...makeScore(72),
        value: 55,
        safety: 90,
        dataQuality: 100
      }
    });
    const stronger = reviewed("pxb7:stronger", {
      priceCny: 4_000,
      score: {
        ...makeScore(80),
        value: 70,
        safety: 90,
        dataQuality: 100
      }
    });

    const results = applyManualPreferenceFeedback(
      [cheaper, stronger],
      [feedback]
    );
    expect(results.map(({ score }) => manualPreferenceAdjustment(score!)))
      .toEqual([0, 0]);
  });

  it("caps repeated feedback and never changes eligibility or risk", () => {
    const candidate = reviewed("pxb7:candidate", {
      priceCny: 5_000,
      score: {
        ...makeScore(58, { m7: 6, assets: 1 }),
        value: 50,
        safety: 60,
        dataQuality: 90,
        riskLevel: "medium"
      }
    });
    const feedback = Array.from({ length: 20 }, (_, index) =>
      excluded(
        `panzhi:feedback-${index}`,
        index % 2 === 0 ? "m7_low_value" : "assets_low",
        {
          priceCny: 4_500,
          score: {
            ...makeScore(55, { m7: 6, assets: 1 }),
            value: 45,
            safety: 60,
            dataQuality: 90,
            riskLevel: "medium"
          }
        }
      )
    );

    const [result] = applyManualPreferenceFeedback([candidate], feedback);
    expect(manualPreferenceAdjustment(result.score!)).toBe(-8);
    const explainedPenalty = result.score!.reasons.reduce(
      (sum, reason) => {
        const match = reason.match(/排名 -(\d+)$/u);
        return sum + (match ? Number(match[1]) : 0);
      },
      0
    );
    expect(explainedPenalty).toBe(8);
    expect(result.eligibility).toBe("eligible");
    expect(result.score?.riskLevel).toBe("medium");
  });

  it("does not generalize seller concerns or free-form reasons", () => {
    const candidate = reviewed("pxb7:candidate");
    const results = applyManualPreferenceFeedback(
      [candidate],
      [
        excluded("panzhi:seller", "seller_concern"),
        excluded("panzhi:other", "other")
      ]
    );

    expect(results[0].score?.total).toBe(candidate.score?.total);
  });

  it("removes stale preference reasons when feedback is restored", () => {
    const base = reviewed("pxb7:candidate", {
      score: {
        ...makeScore(65),
        value: 50,
        safety: 80,
        dataQuality: 90,
        reasons: ["基础解释", "人工偏好：旧调整"]
      }
    });

    const [result] = applyManualPreferenceFeedback([base], []);
    expect(result.score?.total).toBe(65);
    expect(result.score?.reasons).toEqual(["基础解释"]);
  });
});
