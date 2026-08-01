import { classifyListing } from "../../src/domain/classify";

describe("classifyListing", () => {
  it.each([1_900, 3_999, 4_000])(
    "accepts the inclusive candidate price range at %s",
    (priceCny) => {
      expect(
        classifyListing({
          loginPlatform: "qq",
          service: "official",
          priceCny,
          requiredRedSkinStatus: "complete"
        })
      ).toBe("eligible");
    }
  );

  it("still requires a proven official service", () => {
    expect(
      classifyListing({
        loginPlatform: "qq",
        service: "unknown",
        priceCny: 3_999,
        requiredRedSkinStatus: "complete"
      })
    ).toBe("needs_verification");
  });

  it.each([
    ["wechat", "official", 3_999],
    ["qq", "non_official", 3_999],
    ["qq", "official", 1_899],
    ["qq", "official", 4_001]
  ] as const)(
    "rejects a known failed condition",
    (loginPlatform, service, priceCny) => {
      expect(
        classifyListing({
          loginPlatform,
          service,
          priceCny,
          requiredRedSkinStatus: "complete"
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
          priceCny: 3_999,
          requiredRedSkinStatus: "complete"
        }),
        label
      ).toBe("eligible");
    }
  });

  it.each([
    ["unknown", "official", 3_999],
    ["qq", "unknown", 3_999],
    ["qq", "official", null]
  ] as const)(
    "keeps an unknown hard condition pending",
    (loginPlatform, service, priceCny) => {
      expect(
        classifyListing({
          loginPlatform,
          service,
          priceCny,
          requiredRedSkinStatus: "complete"
        })
      ).toBe("needs_verification");
    }
  );

  it("prioritizes a known rejection over another unknown field", () => {
    expect(
      classifyListing({
        loginPlatform: "unknown",
        service: "official",
        priceCny: 1_899,
        requiredRedSkinStatus: "unknown"
      })
    ).toBe("rejected");
  });

  it.each(["unknown", "partial"] as const)(
    "keeps an unproven required red-skin condition pending at %s",
    (requiredRedSkinStatus) => {
      expect(classifyListing({
        loginPlatform: "qq",
        service: "official",
        priceCny: 3_999,
        requiredRedSkinStatus
      })).toBe("needs_verification");
    }
  );

  it("rejects an explicitly missing required red skin", () => {
    expect(classifyListing({
      loginPlatform: "qq",
      service: "official",
      priceCny: 3_999,
      requiredRedSkinStatus: "missing"
    })).toBe("rejected");
  });
});
