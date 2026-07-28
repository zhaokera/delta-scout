import type { Listing } from "../../src/domain/listing";

export function makeListing(overrides: Partial<Listing> = {}): Listing {
  return {
    key: "panzhi:SA123",
    source: "panzhi",
    sourceListingId: "SA123",
    url: "https://www.pzds.com/item/SA123",
    title: "棱镜攻势极品账号",
    originalDescription: "QQ 官服 M7 棱镜攻势 极品",
    capturedAt: "2026-07-28T10:00:00+08:00",
    priceCny: 1888,
    loginPlatform: "qq",
    service: "official",
    totalAssetsM: 266,
    hafCoins: 28_880_000,
    evidence: [
      { text: "QQ 官服 M7 棱镜攻势 极品", truncated: false },
      { text: "威龙 红皮", truncated: false },
      { text: "巨浪 极品", truncated: false }
    ],
    m7PrismStatus: "peak",
    m7Evidence: [{ text: "M7 棱镜攻势 极品", truncated: false }],
    redSkins: ["威龙"],
    redSkinCount: 1,
    redSkinUnnamed: false,
    julangStatus: "owned",
    julangQuality: "极品",
    realNameStatus: "second_available",
    secondRealNameAvailable: true,
    recoveryCoverage: true,
    verificationAt: "2026-07-27T10:00:00+08:00",
    banNotes: [],
    parseWarnings: [],
    confidence: 100,
    eligibility: "eligible",
    score: null,
    possibleDuplicateKeys: [],
    ...overrides
  };
}
