// @vitest-environment node

import {
  detailRequiredIds,
  evaluateNaturalEnd,
  evaluatePublishReadiness,
  validateFilterProof
} from "../../src/server/browserRefresh/completeness.js";
import type {
  BrowserFilterProof,
  BrowserListItem,
  BrowserLoadEvent
} from "../../src/server/browserRefresh/contracts.js";

const observedAt = "2026-07-30T10:00:00.000Z";
const validProof: BrowserFilterProof = {
  currentUrl:
    "https://www.jiaoyimao.com/jg2007840/f8845003-c8845004/o110/",
  gameLabel: "三角洲行动",
  platformLabel: "QQ",
  categoryLabel: "账号",
  activeFilterLabels: [],
  observedAt
};

function event(
  sequence: number,
  observedUniqueCount: number,
  newItemCount: number,
  overrides: Partial<BrowserLoadEvent> = {}
): BrowserLoadEvent {
  return {
    sequence,
    observedUniqueCount,
    newItemCount,
    visibleTotalCount: null,
    endMarkerVisible: false,
    loadingVisible: false,
    blockingState: "none",
    observedAt,
    ...overrides
  };
}

describe("browser refresh completeness", () => {
  it("requires visible proof for the broad game, platform, and category catalog", () => {
    expect(validateFilterProof(validProof)).toEqual({ kind: "ok" });
    for (const proof of [
      { ...validProof, gameLabel: "其他游戏" },
      { ...validProof, platformLabel: "微信" },
      { ...validProof, categoryLabel: "道具" },
      {
        ...validProof,
        currentUrl: "https://www.jiaoyimao.com/jg2007840/"
      },
      { ...validProof, activeFilterLabels: ["M7 棱镜攻势 极品S"] }
    ]) {
      expect(validateFilterProof(proof)).toEqual({
        kind: "invalid",
        reason: "filter_mismatch"
      });
    }
  });

  it("does not accept the canonical URL as a substitute for visible labels", () => {
    expect(validateFilterProof({
      ...validProof,
      gameLabel: "未知",
      platformLabel: "未知",
      categoryLabel: "未知",
      activeFilterLabels: []
    })).toEqual({ kind: "invalid", reason: "filter_mismatch" });
    expect(validateFilterProof({
      ...validProof,
      activeFilterLabels: ["极品S"]
    })).toEqual({ kind: "invalid", reason: "filter_mismatch" });
  });

  it("rejects every active item filter so M7 cannot become a hidden gate", () => {
    expect(validateFilterProof({
      ...validProof,
      activeFilterLabels: [
        "M7 棱镜攻势 极品S",
        "可二次实名"
      ]
    })).toEqual({ kind: "invalid", reason: "filter_mismatch" });
  });

  it("accepts two consecutive normal zero-growth observations", () => {
    expect(evaluateNaturalEnd([
      event(1, 4, 4),
      event(2, 4, 0),
      event(3, 4, 0)
    ])).toEqual({ kind: "complete", reason: "no_growth_twice" });
  });

  it("accepts an explicit end only when its visible total agrees", () => {
    expect(evaluateNaturalEnd([
      event(1, 4, 4, {
        visibleTotalCount: 4,
        endMarkerVisible: true
      })
    ])).toEqual({ kind: "complete", reason: "explicit_total" });
    expect(evaluateNaturalEnd([
      event(1, 4, 4, {
        visibleTotalCount: 5,
        endMarkerVisible: true
      })
    ])).toEqual({ kind: "incomplete", reason: "inconsistent_total" });
    expect(evaluateNaturalEnd([
      event(1, 4, 4, { visibleTotalCount: 5 }),
      event(2, 4, 0),
      event(3, 4, 0)
    ])).toEqual({ kind: "incomplete", reason: "inconsistent_total" });
  });

  it.each([
    [event(3, 2, 0), "sequence_gap"],
    [event(2, 0, 0), "unique_count_decreased"],
    [event(2, 3, 0), "new_item_count_inconsistent"],
    [event(2, 2, 0, { loadingVisible: true }), "loading_visible"],
    [event(2, 2, 0, { blockingState: "login" }), "login"],
    [event(2, 2, 0, { blockingState: "captcha" }), "captcha"],
    [event(2, 2, 0, { blockingState: "rate_limited" }), "rate_limited"],
    [event(2, 2, 0, { blockingState: "error" }), "error"]
  ])("rejects invalid or blocked final observations %#", (last, reason) => {
    expect(evaluateNaturalEnd([event(1, 2, 2), last])).toEqual({
      kind: "incomplete",
      reason
    });
  });

  it("enforces event and item safety limits", () => {
    const tooManyEvents = Array.from({ length: 101 }, (_, index) =>
      event(index + 1, 0, 0)
    );
    expect(evaluateNaturalEnd(tooManyEvents)).toEqual({
      kind: "incomplete",
      reason: "safety_limit"
    });
    expect(evaluateNaturalEnd([
      {
        ...event(1, 2_000, 2_000),
        endMarkerVisible: false
      }
    ])).toEqual({ kind: "incomplete", reason: "safety_limit" });
    expect(evaluateNaturalEnd([
      event(1, 1, 1, { visibleTotalCount: 2_000 })
    ])).toEqual({ kind: "incomplete", reason: "safety_limit" });
    expect(evaluateNaturalEnd([
      event(1, -1, -1)
    ])).toEqual({ kind: "incomplete", reason: "safety_limit" });
  });

  it("requires details only for unknown or budget-priced staged items", () => {
    const items = [
      staged("3", null),
      staged("1", 6_000),
      staged("2", 6_000.01)
    ];
    expect(detailRequiredIds(items)).toEqual(["3", "1"]);
  });

  it("requires valid proof, natural end, and every required detail", () => {
    const items = [staged("1", 5_000), staged("2", 7_000)];
    const events = [
      event(1, 2, 2),
      event(2, 2, 0),
      event(3, 2, 0)
    ];
    expect(evaluatePublishReadiness(
      validProof,
      events,
      items,
      new Set(["1"])
    )).toEqual({ kind: "ready" });
    expect(evaluatePublishReadiness(
      validProof,
      events,
      items,
      new Set()
    )).toEqual({
      kind: "not_ready",
      reason: "details_incomplete",
      missingDetailIds: ["1"]
    });
  });
});

function staged(
  sourceListingId: string,
  priceCny: number | null
): BrowserListItem {
  return {
    sourceListingId,
    url:
      `https://www.jiaoyimao.com/jg2007840/${sourceListingId}.html`,
    title: `商品 ${sourceListingId}`,
    rawText: "可见卡片",
    priceCny
  };
}
