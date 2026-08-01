import { classifyListing } from "../../src/domain/classify";

describe("classifyListing", () => {
  it("requires only QQ, 官服 and an in-budget price", () => {
    expect(
      classifyListing({
        loginPlatform: "qq",
        service: "official",
        priceCny: 5_999
      })
    ).toBe("eligible");

    expect(
      classifyListing({
        loginPlatform: "qq",
        service: "unknown",
        priceCny: 5_999
      })
    ).toBe("needs_verification");
  });

  it.each([
    ["wechat", "official", 5_999],
    ["qq", "non_official", 5_999],
    ["qq", "official", 6_001]
  ] as const)(
    "rejects a known failed condition",
    (loginPlatform, service, priceCny) => {
      expect(
        classifyListing({
          loginPlatform,
          service,
          priceCny
        })
      ).toBe("rejected");
    }
  );

  it("does not use M7 status or quality as an admission condition", () => {
    for (const label of ["极品 S", "优品 A", "未发现", "证据冲突"]) {
      expect(
        classifyListing({
          loginPlatform: "qq",
          service: "official",
          priceCny: 5_999
        }),
        label
      ).toBe("eligible");
    }
  });

  it.each([
    ["unknown", "official", 5_999],
    ["qq", "unknown", 5_999],
    ["qq", "official", null]
  ] as const)(
    "keeps an unknown hard condition pending",
    (loginPlatform, service, priceCny) => {
      expect(
        classifyListing({ loginPlatform, service, priceCny })
      ).toBe("needs_verification");
    }
  );

  it("prioritizes a known rejection over another unknown field", () => {
    expect(
      classifyListing({
        loginPlatform: "qq",
        service: "official",
        priceCny: 6_001
      })
    ).toBe("rejected");
  });
});
