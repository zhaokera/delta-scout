import { ListingSchema } from "../../src/domain/listing";

const validListing = {
  key: "panzhi:SA123",
  source: "panzhi",
  sourceListingId: "SA123",
  url: "https://www.pzds.com/item/SA123",
  title: "棱镜攻势极品账号",
  originalDescription: "QQ官服 M7 棱镜攻势 极品",
  capturedAt: "2026-07-28T10:00:00+08:00",
  priceCny: 1888,
  loginPlatform: "qq",
  service: "official",
  totalAssetsM: 266,
  hafCoins: 28_880_000,
  evidence: [],
  m7PrismStatus: "peak",
  m7PrismQuality: "A",
  m7Evidence: [],
  m7RareFinishes: ["pearl", "iridescent", "candy"] as const,
  m7RareFinishEvidence: [
    { text: "珠光粉M7", truncated: false }
  ],
  redSkins: ["威龙"],
  redSkinCount: 1,
  redSkinUnnamed: false,
  requiredRedSkins: [
    "骇爪-维什戴尔",
    "露娜-黑天际线"
  ] as const,
  requiredRedSkinStatus: "complete",
  julangStatus: "owned",
  julangQuality: "极品",
  realNameStatus: "second_available",
  secondRealNameAvailable: true,
  recoveryCoverage: true,
  verificationAt: "2026-07-27T12:00:00+08:00",
  banNotes: [],
  parseWarnings: [],
  confidence: 100,
  eligibility: "eligible",
  score: null,
  possibleDuplicateKeys: [],
  scanStability: "stable",
  consecutiveUnchangedScans: 3
};

const currentScore = {
  total: 70,
  value: 80,
  safety: 10,
  dataQuality: 50,
  riskLevel: "low" as const,
  coverage: {
    knownSafetySignals: 1,
    totalSafetySignals: 1
  },
  parts: {
    m7: 15,
    redSkins: 25,
    julang: 15,
    price: 20,
    assets: 25,
    secondRealName: 10,
    recovery: 0,
    verification: 0
  },
  valueReasons: [],
  safetyReasons: [],
  reasons: []
};

describe("ListingSchema", () => {
  it("accepts a fully explicit normalized listing", () => {
    expect(ListingSchema.parse(validListing)).toEqual(validListing);
  });

  it("requires unknown states instead of blank strings", () => {
    expect(() =>
      ListingSchema.parse({ ...validListing, loginPlatform: "" })
    ).toThrow();
  });

  it("keeps the required red-skin status consistent with its exact labels", () => {
    expect(() => ListingSchema.parse({
      ...validListing,
      requiredRedSkins: ["骇爪-维什戴尔"]
    })).toThrow();
    expect(() => ListingSchema.parse({
      ...validListing,
      requiredRedSkinStatus: "partial"
    })).toThrow();
  });

  it("rejects confidence outside 0–100", () => {
    expect(() =>
      ListingSchema.parse({ ...validListing, confidence: 101 })
    ).toThrow();
  });

  it("defaults legacy snapshots without an M7 grade to null", () => {
    const legacy = { ...validListing };
    delete (legacy as Partial<typeof validListing>).m7PrismQuality;

    expect(ListingSchema.parse(legacy).m7PrismQuality).toBeNull();
  });

  it("defaults legacy snapshots without M7 rare finishes", () => {
    const {
      m7RareFinishes: _legacyFinishes,
      m7RareFinishEvidence: _legacyFinishEvidence,
      ...legacy
    } = validListing;

    expect(ListingSchema.parse(legacy)).toMatchObject({
      m7RareFinishes: [],
      m7RareFinishEvidence: []
    });
  });

  it("defaults legacy snapshots without scan stability", () => {
    const legacy = { ...validListing } as Partial<typeof validListing>;
    delete legacy.scanStability;
    delete legacy.consecutiveUnchangedScans;

    expect(ListingSchema.parse(legacy)).toMatchObject({
      scanStability: "unknown",
      consecutiveUnchangedScans: 0
    });
  });

  it("accepts the current value, safety, quality and risk score contract", () => {
    expect(
      ListingSchema.parse({
        ...validListing,
        score: currentScore
      }).score
    ).not.toBeNull();
  });

  it.each([
    ["m7", 16],
    ["redSkins", 26],
    ["julang", 16],
    ["price", 21],
    ["assets", 26]
  ] as const)("rejects %s above its value allocation", (part, value) => {
    const score = {
      ...currentScore,
      parts: {
        ...currentScore.parts,
        [part]: value
      }
    };

    expect(() =>
      ListingSchema.parse({ ...validListing, score })
    ).toThrow();
  });

  it.each([
    ["safety", { ...currentScore, safety: 11 }],
    ["secondRealName", {
      ...currentScore,
      parts: { ...currentScore.parts, secondRealName: 11 }
    }],
    ["recovery", {
      ...currentScore,
      parts: { ...currentScore.parts, recovery: 1 }
    }],
    ["verification", {
      ...currentScore,
      parts: { ...currentScore.parts, verification: 1 }
    }]
  ] as const)("rejects %s outside the current safety allocation", (_field, score) => {
    expect(() => ListingSchema.parse({ ...validListing, score })).toThrow();
  });

  it("requires the one-signal safety coverage contract", () => {
    const score = {
      ...currentScore,
      coverage: {
        knownSafetySignals: 0,
        totalSafetySignals: 1
      }
    };

    expect(ListingSchema.parse({ ...validListing, score }).score?.coverage)
      .toEqual({ knownSafetySignals: 0, totalSafetySignals: 1 });
    expect(() => ListingSchema.parse({
      ...validListing,
      score: {
        ...score,
        coverage: { knownSafetySignals: 2, totalSafetySignals: 1 }
      }
    })).toThrow();
    expect(() => ListingSchema.parse({
      ...validListing,
      score: {
        ...score,
        coverage: { knownSafetySignals: 1, totalSafetySignals: 2 }
      }
    })).toThrow();
  });
});
