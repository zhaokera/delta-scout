// @vitest-environment node
import { parseStoredListing } from "../../src/server/storedListing.js";
import { makeListing } from "../domain/listingFactory.js";

describe("parseStoredListing", () => {
  it("normalizes legacy optional fields and clears an old score shape", () => {
    const legacy = {
      ...makeListing(),
      score: {
        total: 80,
        parts: {
          safety: 40,
          price: 20,
          assets: 10,
          confidence: 10
        },
        reasons: []
      }
    } as Record<string, unknown>;
    delete legacy.m7PrismQuality;
    delete legacy.scanStability;
    delete legacy.consecutiveUnchangedScans;

    expect(parseStoredListing(JSON.stringify(legacy))).toMatchObject({
      m7PrismQuality: null,
      score: null,
      scanStability: "unknown",
      consecutiveUnchangedScans: 0
    });
  });

  it("does not hide damage to required listing fields", () => {
    const damaged = { ...makeListing(), source: "mystery" };

    expect(() =>
      parseStoredListing(JSON.stringify(damaged))
    ).toThrow();
  });
});
