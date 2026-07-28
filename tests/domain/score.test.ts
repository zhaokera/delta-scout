import { scoreEligibleListings } from "../../src/domain/score";
import { makeListing } from "./listingFactory";

const now = new Date("2026-07-28T12:00:00+08:00");

describe("scoreEligibleListings", () => {
  it("uses neutral set-relative values for a single candidate", () => {
    const [result] = scoreEligibleListings([makeListing()], now);

    expect(result.score).toEqual({
      total: 79,
      parts: {
        safety: 40,
        price: 12.5,
        assets: 11.5,
        confidence: 15
      },
      reasons: expect.any(Array)
    });
  });

  it("normalizes price and assets across eligible candidates", () => {
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

    expect(cheapResult.score?.parts.price).toBe(25);
    expect(richResult.score?.parts.price).toBe(0);
    expect(cheapResult.score?.parts.assets).toBe(3);
    expect(richResult.score?.parts.assets).toBe(20);
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
});
