// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  buildPanzhiBrowserListings,
  PanzhiBrowserSnapshotSchema,
  type PanzhiBrowserSnapshot
} from "../../src/server/panzhiBrowserSnapshot.js";

const observedAt = "2026-08-01T08:00:00.000Z";

function snapshot(
  overrides: Partial<PanzhiBrowserSnapshot> = {}
): PanzhiBrowserSnapshot {
  return {
    filterProof: {
      currentUrl: "https://www.pzds.com/goodsList/391/6",
      gameLabel: "三角洲行动",
      minPriceInput: "1900",
      maxPriceInput: "4000",
      operatorSkinFilter: {
        fieldId: "22858",
        fieldLabel: "特战干员外观",
        fieldType: "CHECKBOX",
        mappingField: "22858",
        searchType: "ALL",
        searchTypeLabel: "全部都要有",
        selectedOptions: [
          {
            optionId: "1038173",
            label: "骇爪-维什戴尔",
            metadataCode: "SA200018"
          },
          {
            optionId: "1035794",
            label: "露娜-黑天际线",
            metadataCode: "SA200003"
          }
        ]
      },
      observedAt
    },
    loadActionCount: 4,
    observedUniqueCount: 2,
    stopReason: "no_growth_twice",
    items: [
      {
        sourceListingId: "SA2INRANGE",
        url: "https://www.pzds.com/goodsDetails/SA2INRANGE/6",
        title: "M7 棱镜攻势账号",
        rawText:
          "总资产365M 哈夫币478w M7棱镜攻势(极品B) " +
          "骇爪-维什戴尔 露娜-黑天际线 " +
          "QQ可二次实名 找回包赔 ¥ 2888",
        priceCny: 2888
      },
      {
        sourceListingId: "SA2PINNED",
        url: "https://www.pzds.com/goodsDetails/SA2PINNED/6",
        title: "原生筛选页置顶越界商品",
        rawText: "QQ不可二次实名 ¥ 50000",
        priceCny: 50000
      }
    ],
    ...overrides
  };
}

describe("Panzhi browser native-filter snapshot", () => {
  it("accepts exact native filter proof and drops pinned price outliers", () => {
    const parsed = PanzhiBrowserSnapshotSchema.parse(snapshot());
    const built = buildPanzhiBrowserListings(
      parsed,
      new Date(observedAt)
    );

    expect(built.droppedByPrice).toBe(1);
    expect(built.listings).toHaveLength(1);
    expect(built.listings[0]).toMatchObject({
      source: "panzhi",
      sourceListingId: "SA2INRANGE",
      priceCny: 2888,
      loginPlatform: "qq",
      service: "official",
      eligibility: "eligible",
      m7PrismStatus: "peak",
      m7PrismQuality: "B",
      realNameStatus: "second_available",
      secondRealNameAvailable: true,
      recoveryCoverage: true
    });
  });

  it("accepts a captcha stop without claiming a natural end", () => {
    expect(PanzhiBrowserSnapshotSchema.parse(snapshot({
      stopReason: "captcha_required"
    })).stopReason).toBe("captcha_required");
  });

  it("accepts the exact required operator skins in either selection order", () => {
    const proof = snapshot().filterProof;
    expect(PanzhiBrowserSnapshotSchema.parse(snapshot({
      filterProof: {
        ...proof,
        operatorSkinFilter: {
          ...proof.operatorSkinFilter,
          selectedOptions: [
            proof.operatorSkinFilter.selectedOptions[1],
            proof.operatorSkinFilter.selectedOptions[0]
          ]
        }
      }
    })).filterProof.operatorSkinFilter.searchType).toBe("ALL");
  });

  it.each([
    ["wrong minimum", { filterProof: {
      ...snapshot().filterProof,
      minPriceInput: "1000"
    } }],
    ["query-bearing catalog URL", { filterProof: {
      ...snapshot().filterProof,
      currentUrl:
        "https://www.pzds.com/goodsList/391/6?minPrice=1900"
    } }],
    ["wrong operator skin field", { filterProof: {
      ...snapshot().filterProof,
      operatorSkinFilter: {
        ...snapshot().filterProof.operatorSkinFilter,
        fieldId: "22859"
      }
    } }],
    ["OR semantics for operator skins", { filterProof: {
      ...snapshot().filterProof,
      operatorSkinFilter: {
        ...snapshot().filterProof.operatorSkinFilter,
        searchType: "ONE",
        searchTypeLabel: "有一个就行"
      }
    } }],
    ["a missing required operator skin", { filterProof: {
      ...snapshot().filterProof,
      operatorSkinFilter: {
        ...snapshot().filterProof.operatorSkinFilter,
        selectedOptions: [
          snapshot().filterProof.operatorSkinFilter.selectedOptions[0]
        ]
      }
    } }],
    ["a duplicate required operator skin", { filterProof: {
      ...snapshot().filterProof,
      operatorSkinFilter: {
        ...snapshot().filterProof.operatorSkinFilter,
        selectedOptions: [
          snapshot().filterProof.operatorSkinFilter.selectedOptions[0],
          snapshot().filterProof.operatorSkinFilter.selectedOptions[0]
        ]
      }
    } }],
    ["a mismatched operator skin metadata code", { filterProof: {
      ...snapshot().filterProof,
      operatorSkinFilter: {
        ...snapshot().filterProof.operatorSkinFilter,
        selectedOptions: [
          snapshot().filterProof.operatorSkinFilter.selectedOptions[0],
          {
            ...snapshot().filterProof.operatorSkinFilter.selectedOptions[1],
            metadataCode: "SA200018"
          }
        ]
      }
    } }],
    ["duplicate listing id", {
      items: [snapshot().items[0], {
        ...snapshot().items[0],
        url: "https://www.pzds.com/goodsDetails/SA2INRANGE/6"
      }]
    }],
    ["mismatched observed count", { observedUniqueCount: 3 }]
  ])("rejects %s", (_label, overrides) => {
    expect(() => PanzhiBrowserSnapshotSchema.parse(
      snapshot(overrides as Partial<PanzhiBrowserSnapshot>)
    )).toThrow();
  });
});
