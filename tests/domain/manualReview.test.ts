import { describe, expect, it } from "vitest";

import {
  MANUAL_REVIEW_REASON_LABELS,
  ManualReviewReasonSchema,
  parseManualExclusionInput
} from "../../src/domain/manualReview";

describe("manual review reasons", () => {
  it("defines every approved reason and its Chinese label", () => {
    const reasons = [
      "price_overvalued",
      "m7_low_value",
      "red_skins_mismatch",
      "safety_risk",
      "assets_low",
      "seller_concern",
      "other"
    ] as const;

    expect(reasons.map((reason) => ManualReviewReasonSchema.parse(reason)))
      .toEqual(reasons);
    expect(MANUAL_REVIEW_REASON_LABELS).toEqual({
      price_overvalued: "价格虚高",
      m7_low_value: "M7 不值",
      red_skins_mismatch: "红皮不合适",
      safety_risk: "安全风险",
      assets_low: "资产不足",
      seller_concern: "卖家问题",
      other: "其他"
    });
  });
});

describe("parseManualExclusionInput", () => {
  it("trims a supplied note", () => {
    expect(
      parseManualExclusionInput({
        reason: "price_overvalued",
        note: "  同价位有更安全的号  "
      })
    ).toEqual({
      reason: "price_overvalued",
      note: "同价位有更安全的号"
    });
  });

  it("normalizes omitted and whitespace-only optional notes to null", () => {
    expect(
      parseManualExclusionInput({ reason: "m7_low_value" })
    ).toEqual({
      reason: "m7_low_value",
      note: null
    });
    expect(
      parseManualExclusionInput({
        reason: "seller_concern",
        note: "   "
      })
    ).toEqual({
      reason: "seller_concern",
      note: null
    });
  });

  it("requires a non-empty note for the other reason", () => {
    expect(() =>
      parseManualExclusionInput({
        reason: "other",
        note: "   "
      })
    ).toThrow("选择其他时请填写说明");
  });

  it("rejects notes longer than 500 characters", () => {
    expect(() =>
      parseManualExclusionInput({
        reason: "assets_low",
        note: "x".repeat(501)
      })
    ).toThrow();
  });

  it("rejects unsupported reasons and unknown fields", () => {
    expect(() =>
      parseManualExclusionInput({
        reason: "unknown"
      })
    ).toThrow();
    expect(() =>
      parseManualExclusionInput({
        reason: "safety_risk",
        hidden: true
      })
    ).toThrow();
  });
});
