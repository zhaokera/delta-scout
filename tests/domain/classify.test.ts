import { classifyListing } from "../../src/domain/classify";

describe("classifyListing", () => {
  it("requires QQ and 官服 as separate proven fields", () => {
    expect(
      classifyListing({
        loginPlatform: "qq",
        service: "official",
        priceCny: 5_999,
        m7PrismStatus: "peak"
      })
    ).toBe("eligible");

    expect(
      classifyListing({
        loginPlatform: "qq",
        service: "unknown",
        priceCny: 5_999,
        m7PrismStatus: "peak"
      })
    ).toBe("needs_verification");
  });

  it.each([
    ["wechat", "official", 5_999, "peak"],
    ["qq", "non_official", 5_999, "peak"],
    ["qq", "official", 6_001, "peak"],
    ["qq", "official", 5_999, "premium"],
    ["qq", "official", 5_999, "absent"]
  ] as const)(
    "rejects a known failed condition",
    (loginPlatform, service, priceCny, m7PrismStatus) => {
      expect(
        classifyListing({
          loginPlatform,
          service,
          priceCny,
          m7PrismStatus
        })
      ).toBe("rejected");
    }
  );

  it("prioritizes a known rejection over another unknown field", () => {
    expect(
      classifyListing({
        loginPlatform: "qq",
        service: "official",
        priceCny: 6_001,
        m7PrismStatus: "unknown"
      })
    ).toBe("rejected");
  });
});
