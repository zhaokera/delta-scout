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
  redSkins: ["威龙"],
  redSkinCount: 1,
  redSkinUnnamed: false,
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

describe("ListingSchema", () => {
  it("accepts a fully explicit normalized listing", () => {
    expect(ListingSchema.parse(validListing)).toEqual(validListing);
  });

  it("requires unknown states instead of blank strings", () => {
    expect(() =>
      ListingSchema.parse({ ...validListing, loginPlatform: "" })
    ).toThrow();
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

  it("defaults legacy snapshots without scan stability", () => {
    const legacy = { ...validListing } as Partial<typeof validListing>;
    delete legacy.scanStability;
    delete legacy.consecutiveUnchangedScans;

    expect(ListingSchema.parse(legacy)).toMatchObject({
      scanStability: "unknown",
      consecutiveUnchangedScans: 0
    });
  });

  it("accepts the five-part recommendation score", () => {
    expect(
      ListingSchema.parse({
        ...validListing,
        score: {
          total: 70,
          parts: {
            safety: 20,
            skinValue: 25,
            price: 10,
            assets: 5,
            confidence: 10
          },
          reasons: []
        }
      }).score
    ).not.toBeNull();
  });
});
