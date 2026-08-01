import {
  isReviewedListingSummary,
  summarizeReviewedListing
} from "../../src/domain/listingSummary";
import { makeListing, makeScore } from "./listingFactory";

describe("summarizeReviewedListing", () => {
  it("keeps decision fields while removing full evidence payloads", () => {
    const listing = {
      ...makeListing({
        originalDescription: "完整原文".repeat(1_000),
        evidence: [
          { text: "证据一", truncated: false },
          { text: "证据二", truncated: false }
        ],
        parseWarnings: ["结构变化"],
        banNotes: ["封禁备注"],
        score: {
          ...makeScore(75),
          valueReasons: ["价值解释"],
          safetyReasons: ["安全解释"],
          reasons: ["综合解释"]
        }
      }),
      manualReview: null
    };

    const summary = summarizeReviewedListing(listing);

    expect(summary).toMatchObject({
      key: listing.key,
      detailLevel: "summary",
      evidenceCount: 2,
      parseWarningCount: 1,
      banNoteCount: 1,
      score: { total: 75 }
    });
    expect(summary).not.toHaveProperty("originalDescription");
    expect(summary).not.toHaveProperty("evidence");
    expect(summary).not.toHaveProperty("m7Evidence");
    expect(summary.score).not.toHaveProperty("reasons");
    expect(isReviewedListingSummary(summary)).toBe(true);
    expect(JSON.stringify(summary).length).toBeLessThan(
      JSON.stringify(listing).length / 4
    );
  });

  it("does not misclassify a full listing used by client test doubles", () => {
    const listing = { ...makeListing(), manualReview: null };
    expect(isReviewedListingSummary(listing)).toBe(false);
  });
});
