import { z } from "zod";

import type { Listing } from "./listing.js";

export const ManualReviewReasonSchema = z.enum([
  "price_overvalued",
  "m7_low_value",
  "red_skins_mismatch",
  "safety_risk",
  "assets_low",
  "seller_concern",
  "other"
]);

export const MANUAL_REVIEW_REASON_LABELS = {
  price_overvalued: "价格虚高",
  m7_low_value: "M7 不值",
  red_skins_mismatch: "红皮不合适",
  safety_risk: "安全风险",
  assets_low: "资产不足",
  seller_concern: "卖家问题",
  other: "其他"
} as const satisfies Record<ManualReviewReason, string>;

const ManualExclusionInputSchema = z
  .strictObject({
    reason: ManualReviewReasonSchema,
    note: z.string().max(500).optional()
  })
  .transform(({ reason, note }) => ({
    reason,
    note: note?.trim() || null
  }))
  .superRefine((value, context) => {
    if (value.reason === "other" && value.note === null) {
      context.addIssue({
        code: "custom",
        path: ["note"],
        message: "选择其他时请填写说明"
      });
    }
  });

export function parseManualExclusionInput(value: unknown): ManualExclusionInput {
  return ManualExclusionInputSchema.parse(value);
}

export type ManualReviewReason = z.infer<typeof ManualReviewReasonSchema>;
export type ManualExclusionInput = z.infer<typeof ManualExclusionInputSchema>;

export interface ManualListingReview {
  excluded: true;
  reason: ManualReviewReason;
  note: string | null;
  reviewedAt: string;
}

export type ReviewedListing = Listing & {
  manualReview: ManualListingReview | null;
};
