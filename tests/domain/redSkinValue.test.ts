import { redSkinValuation } from "../../src/domain/redSkinValue";
import { makeListing } from "./listingFactory";

describe("redSkinValuation", () => {
  it("values the two target skins at ¥300 and other red skins at ¥250", () => {
    const result = redSkinValuation(makeListing({
      evidence: [
        { text: "露娜-黑·天际线 骇爪-维什戴尔", truncated: false },
        { text: "骇爪-水墨云图 威龙-凌霄戍卫", truncated: false }
      ],
      redSkins: ["露娜", "骇爪", "威龙"],
      requiredRedSkins: ["骇爪-维什戴尔", "露娜-黑天际线"]
    }));

    expect(result.estimatedCny).toBe(1_100);
    expect(result.items.map(({ label, valueCny }) => [label, valueCny])).toEqual([
      ["露娜-黑天际线", 300],
      ["骇爪-维什戴尔", 300],
      ["骇爪-水墨云图", 250],
      ["威龙-凌霄戍卫", 250]
    ]);
  });

  it("does not double count aliases, repeated evidence, or character fallbacks", () => {
    const result = redSkinValuation(makeListing({
      evidence: [
        { text: "骇爪-维什戴尔", truncated: false },
        { text: "麦晓雯·维什戴尔", truncated: false }
      ],
      redSkins: ["骇爪", "骇爪"],
      requiredRedSkins: ["骇爪-维什戴尔"]
    }));

    expect(result.estimatedCny).toBe(300);
    expect(result.items).toHaveLength(1);
  });

  it("uses ¥250 for a named red character whose exact skin is unknown", () => {
    const result = redSkinValuation(makeListing({
      evidence: [{ text: "威龙 红皮", truncated: false }],
      redSkins: ["威龙"],
      requiredRedSkins: []
    }));

    expect(result).toMatchObject({
      estimatedCny: 250,
      items: [{
        label: "威龙-红皮（具体款式待核验）",
        valueCny: 250,
        exactSkin: false
      }]
    });
  });

  it("does not value an explicitly missing exact skin", () => {
    const result = redSkinValuation(makeListing({
      evidence: [
        { text: "没有露娜-黑天际线，骇爪没有水墨云图", truncated: false }
      ],
      redSkins: [],
      requiredRedSkins: []
    }));

    expect(result).toEqual({ items: [], estimatedCny: 0 });
  });
});
