import type { Listing, Score } from "../../src/domain/listing.js";

export function makeScore(
  total: number,
  parts: Partial<Score["parts"]> = {}
): Score {
  return {
    total,
    preferenceAdjustment: 0,
    value: 0,
    safety: 0,
    dataQuality: 0,
    riskLevel: "unknown",
    coverage: {
      knownSafetySignals: 0,
      totalSafetySignals: 3
    },
    parts: {
      m7: 0,
      redSkins: 0,
      julang: 0,
      price: 0,
      assets: 0,
      secondRealName: 0,
      recovery: 0,
      verification: 0,
      ...parts
    },
    valueReasons: [],
    safetyReasons: [],
    reasons: []
  };
}

export function makeListing(overrides: Partial<Listing> = {}): Listing {
  return {
    key: "panzhi:SA123",
    source: "panzhi",
    sourceListingId: "SA123",
    url: "https://www.pzds.com/item/SA123",
    title: "棱镜攻势极品账号",
    originalDescription: "QQ 官服 M7 棱镜攻势 极品",
    capturedAt: "2026-07-28T10:00:00+08:00",
    priceCny: 2888,
    loginPlatform: "qq",
    service: "official",
    totalAssetsM: 266,
    hafCoins: 28_880_000,
    evidence: [
      { text: "QQ 官服 M7 棱镜攻势 极品", truncated: false },
      {
        text: "骇爪-维什戴尔 露娜-黑天际线",
        truncated: false
      },
      { text: "威龙 红皮", truncated: false },
      { text: "巨浪 极品", truncated: false }
    ],
    m7PrismStatus: "peak",
    m7PrismQuality: "A",
    m7Evidence: [{ text: "M7 棱镜攻势 极品", truncated: false }],
    m7RareFinishes: [],
    m7RareFinishEvidence: [],
    redSkins: ["威龙"],
    redSkinCount: 1,
    redSkinUnnamed: false,
    requiredRedSkins: ["骇爪-维什戴尔", "露娜-黑天际线"],
    requiredRedSkinStatus: "complete",
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
    scanStability: "unknown",
    consecutiveUnchangedScans: 0,
    ...overrides
  };
}
