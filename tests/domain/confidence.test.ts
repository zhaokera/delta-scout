import { calculateConfidence } from "../../src/domain/confidence";
import { makeListing } from "./listingFactory";

describe("calculateConfidence", () => {
  it("adds only explicitly evidenced fields", () => {
    const listing = makeListing({
      confidence: 0,
      evidence: [],
      m7Evidence: [{ text: "M7 棱镜攻势 极品", truncated: false }],
      loginPlatform: "qq",
      priceCny: 1888,
      secondRealNameAvailable: true,
      totalAssetsM: 266,
      redSkins: ["威龙"],
      julangStatus: "unknown"
    });

    expect(calculateConfidence(listing)).toBe(100);
  });

  it("gives zero to missing or unknown evidence", () => {
    const listing = makeListing({
      confidence: 0,
      m7Evidence: [],
      loginPlatform: "unknown",
      service: "unknown",
      priceCny: null,
      secondRealNameAvailable: null,
      recoveryCoverage: null,
      verificationAt: null,
      totalAssetsM: null,
      hafCoins: null,
      redSkins: [],
      redSkinUnnamed: false,
      julangStatus: "unknown"
    });

    expect(calculateConfidence(listing)).toBe(0);
  });

  it("does not let permanent recovery coverage raise confidence", () => {
    const listing = makeListing({
      confidence: 0,
      m7Evidence: [],
      loginPlatform: "unknown",
      service: "unknown",
      priceCny: null,
      secondRealNameAvailable: null,
      recoveryCoverage: true,
      verificationAt: null,
      totalAssetsM: null,
      hafCoins: null,
      redSkins: [],
      redSkinUnnamed: false,
      julangStatus: "unknown"
    });

    expect(calculateConfidence(listing)).toBe(0);
  });

  it("can reach high confidence without M7 evidence", () => {
    const listing = makeListing({
      confidence: 0,
      m7PrismStatus: "absent",
      m7PrismQuality: null,
      m7Evidence: []
    });

    expect(calculateConfidence(listing)).toBe(90);
  });
});
