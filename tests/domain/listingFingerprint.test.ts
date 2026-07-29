// @vitest-environment node
import { listingMaterialHash } from "../../src/domain/listingFingerprint";
import { makeListing, makeScore } from "./listingFactory";

describe("listingMaterialHash", () => {
  it("ignores display-only fields and normalizes unordered arrays", () => {
    const original = makeListing({
      redSkins: ["威龙", "骇爪"],
      banNotes: ["备注乙", "备注甲"],
      parseWarnings: ["警告乙", "警告甲"]
    });
    const displayChange = makeListing({
      ...original,
      title: "  新标题  ",
      capturedAt: "2026-07-29T10:00:00+08:00",
      score: makeScore(99),
      redSkins: ["骇爪", "威龙", "骇爪"],
      banNotes: ["备注甲", "备注乙"],
      parseWarnings: ["警告甲", "警告乙"]
    });

    expect(listingMaterialHash(displayChange)).toBe(
      listingMaterialHash(original)
    );
  });

  it.each([
    ["price", { priceCny: 1999 }],
    ["quality", { m7PrismQuality: "S" as const }],
    ["red skins", { redSkins: ["威龙", "骇爪"] }],
    ["Julang", { julangStatus: "absent" as const }],
    ["assets", { totalAssetsM: 999 }],
    ["real name", { secondRealNameAvailable: false }],
    ["recovery", { recoveryCoverage: false }],
    ["verification", { verificationAt: null }],
    ["confidence", { confidence: 80 }],
    ["warning", { parseWarnings: ["新警告"] }]
  ])("changes when the material %s changes", (_name, override) => {
    const original = makeListing();

    expect(listingMaterialHash(makeListing(override))).not.toBe(
      listingMaterialHash(original)
    );
  });
});
