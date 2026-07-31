import { classifyListing } from "../../src/domain/classify";

describe("classifyListing", () => {
  it("requires QQ and 官服 as separate proven fields", () => {
    expect(
      classifyListing({
        loginPlatform: "qq",
        service: "official",
        priceCny: 5_999,
        m7PrismStatus: "peak",
        m7PrismQuality: "S"
      })
    ).toBe("eligible");

    expect(
      classifyListing({
        loginPlatform: "qq",
        service: "unknown",
        priceCny: 5_999,
        m7PrismStatus: "peak",
        m7PrismQuality: "S"
      })
    ).toBe("needs_verification");
  });

  it.each([
    ["wechat", "official", 5_999, "peak", "S"],
    ["qq", "non_official", 5_999, "peak", "S"],
    ["qq", "official", 6_001, "peak", "S"],
    ["qq", "official", 5_999, "premium", "A"],
    ["qq", "official", 5_999, "premium", "B"],
    ["qq", "official", 5_999, "premium", "C"],
    ["qq", "official", 5_999, "absent", null]
  ] as const)(
    "rejects a known failed condition",
    (
      loginPlatform,
      service,
      priceCny,
      m7PrismStatus,
      m7PrismQuality
    ) => {
      expect(
        classifyListing({
          loginPlatform,
          service,
          priceCny,
          m7PrismStatus,
          m7PrismQuality
        })
      ).toBe("rejected");
    }
  );

  it("admits premium S but keeps premium without a proven grade pending", () => {
    expect(
      classifyListing({
        loginPlatform: "qq",
        service: "official",
        priceCny: 5_999,
        m7PrismStatus: "premium",
        m7PrismQuality: "S"
      })
    ).toBe("eligible");

    expect(
      classifyListing({
        loginPlatform: "qq",
        service: "official",
        priceCny: 5_999,
        m7PrismStatus: "premium",
        m7PrismQuality: null
      })
    ).toBe("needs_verification");
  });

  it("prioritizes a known rejection over another unknown field", () => {
    expect(
      classifyListing({
        loginPlatform: "qq",
        service: "official",
        priceCny: 6_001,
        m7PrismStatus: "unknown",
        m7PrismQuality: null
      })
    ).toBe("rejected");
  });
});
