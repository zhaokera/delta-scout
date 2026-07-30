import {
  buildListingHistorySnapshot,
  diffListingSnapshots,
  normalizeListingHistorySnapshot
} from "../../src/domain/listingHistory";
import { makeListing } from "./listingFactory";

describe("listing history snapshots", () => {
  it("keeps decision fields while excluding volatile evidence and scores", () => {
    const snapshot = buildListingHistorySnapshot(
      makeListing({
        title: "会变化的营销标题",
        capturedAt: "2026-07-29T10:00:00.000Z",
        evidence: [{ text: "很长的原始证据", truncated: false }],
        redSkins: ["威龙", "骇爪", "威龙"],
        parseWarnings: ["字段待复核", "字段待复核"]
      })
    );

    expect(snapshot).toEqual({
      priceCny: 1888,
      eligibility: "eligible",
      m7PrismStatus: "peak",
      m7PrismQuality: "A",
      m7RareFinishes: [],
      redSkins: ["威龙", "骇爪"],
      redSkinCount: 1,
      julangStatus: "owned",
      julangQuality: "极品",
      totalAssetsM: 266,
      hafCoins: 28_880_000,
      secondRealNameAvailable: true,
      recoveryCoverage: true,
      verificationAt: "2026-07-27T10:00:00+08:00",
      banNotes: [],
      confidence: 100,
      parseWarnings: ["字段待复核"]
    });
    expect(snapshot).not.toHaveProperty("title");
    expect(snapshot).not.toHaveProperty("evidence");
    expect(snapshot).not.toHaveProperty("score");
  });

  it("normalizes legacy finish fields and keeps their fixed order", () => {
    const snapshot = buildListingHistorySnapshot(
      makeListing({
        m7RareFinishes: ["candy", "pearl", "iridescent", "pearl"]
      })
    );
    const {
      m7RareFinishes: _legacyFinishes,
      ...legacy
    } = snapshot;

    expect(snapshot.m7RareFinishes).toEqual([
      "pearl",
      "iridescent",
      "candy"
    ]);
    expect(
      normalizeListingHistorySnapshot(legacy).m7RareFinishes
    ).toEqual([]);
    expect(
      diffListingSnapshots(
        legacy,
        buildListingHistorySnapshot(
          makeListing({ m7RareFinishes: [] })
        )
      )
    ).toEqual([]);
  });

  it("reports a newly discovered M7 rare finish", () => {
    const before = buildListingHistorySnapshot(
      makeListing({ m7RareFinishes: [] })
    );
    const after = buildListingHistorySnapshot(
      makeListing({ m7RareFinishes: ["pearl"] })
    );

    expect(diffListingSnapshots(before, after)).toContainEqual({
      field: "m7RareFinishes",
      label: "M7 稀有模板",
      before: "待核验",
      after: "珠光"
    });
  });

  it("returns no change when only array order differs", () => {
    const before = buildListingHistorySnapshot(
      makeListing({ redSkins: ["威龙", "骇爪"] })
    );
    const after = buildListingHistorySnapshot(
      makeListing({ redSkins: ["骇爪", "威龙"] })
    );

    expect(diffListingSnapshots(before, after)).toEqual([]);
  });

  it("formats a price change for direct display", () => {
    const before = buildListingHistorySnapshot(
      makeListing({ priceCny: 1888 })
    );
    const after = buildListingHistorySnapshot(
      makeListing({ priceCny: 2199 })
    );

    expect(diffListingSnapshots(before, after)).toContainEqual({
      field: "priceCny",
      label: "价格",
      before: "¥1,888",
      after: "¥2,199"
    });
  });

  it("explains M7, red-skin, Julang and safety changes", () => {
    const before = buildListingHistorySnapshot(
      makeListing({
        m7PrismQuality: "A",
        redSkins: ["威龙"],
        julangStatus: "unknown",
        secondRealNameAvailable: null,
        recoveryCoverage: null
      })
    );
    const after = buildListingHistorySnapshot(
      makeListing({
        m7PrismQuality: "S",
        redSkins: ["威龙", "骇爪"],
        julangStatus: "owned",
        secondRealNameAvailable: true,
        recoveryCoverage: true
      })
    );

    expect(diffListingSnapshots(before, after)).toEqual(
      expect.arrayContaining([
        {
          field: "m7PrismQuality",
          label: "M7 品质",
          before: "A",
          after: "S"
        },
        {
          field: "redSkins",
          label: "角色红皮",
          before: "威龙",
          after: "威龙、骇爪"
        },
        {
          field: "julangStatus",
          label: "巨浪状态",
          before: "待核验",
          after: "已拥有"
        },
        {
          field: "secondRealNameAvailable",
          label: "二次实名",
          before: "待核验",
          after: "可二次实名"
        },
        {
          field: "recoveryCoverage",
          label: "找回保障",
          before: "待核验",
          after: "支持包赔"
        }
      ])
    );
  });
});
