import type { Score } from "./listing.js";
import {
  MANUAL_REVIEW_REASON_LABELS,
  type ManualReviewReason,
  type ReviewedListing
} from "./manualReview.js";

const FEEDBACK_REASON_PREFIX = "人工偏好：";
const MAX_REASON_PENALTY = 4;
const MAX_TOTAL_PENALTY = 8;

const AUTOMATED_REASONS = new Set<ManualReviewReason>([
  "price_overvalued",
  "m7_low_value",
  "red_skins_mismatch",
  "safety_risk",
  "assets_low"
]);

type PreferenceScore = Pick<
  Score,
  "total" | "value" | "safety" | "dataQuality"
> & { preferenceAdjustment?: number };

function baseTotal(score: PreferenceScore): number {
  return Math.round(
    score.value * 0.55 +
    score.safety * 0.35 +
    score.dataQuality * 0.1
  );
}

export function manualPreferenceAdjustment(
  score: PreferenceScore
): number {
  return score.preferenceAdjustment ?? score.total - baseTotal(score);
}

function comparablePrice(
  candidate: ReviewedListing,
  rejected: ReviewedListing,
  ratio: number
): boolean {
  return (
    candidate.priceCny !== null &&
    rejected.priceCny !== null &&
    candidate.priceCny >= rejected.priceCny * ratio
  );
}

function skinSimilarity(
  candidate: ReviewedListing,
  rejected: ReviewedListing
): number {
  const rejectedSkins = new Set(rejected.redSkins);
  const union = new Set([...candidate.redSkins, ...rejected.redSkins]);
  if (union.size === 0) return 1;
  const intersection = candidate.redSkins.filter((skin) =>
    rejectedSkins.has(skin)
  ).length;
  return intersection / union.size;
}

function resemblesFeedback(
  candidate: ReviewedListing,
  rejected: ReviewedListing,
  reason: ManualReviewReason
): boolean {
  if (candidate.score === null || rejected.score === null) return false;
  switch (reason) {
    case "price_overvalued":
      return (
        comparablePrice(candidate, rejected, 0.9) &&
        candidate.score.value <= rejected.score.value + 8
      );
    case "m7_low_value":
      return (
        comparablePrice(candidate, rejected, 0.8) &&
        candidate.score.parts.m7 <= rejected.score.parts.m7
      );
    case "red_skins_mismatch":
      return skinSimilarity(candidate, rejected) >= 0.6;
    case "safety_risk":
      return (
        candidate.score.riskLevel !== "low" &&
        candidate.score.safety <= rejected.score.safety &&
        candidate.score.coverage.knownSafetySignals <=
          rejected.score.coverage.knownSafetySignals
      );
    case "assets_low":
      return (
        comparablePrice(candidate, rejected, 0.8) &&
        candidate.score.parts.assets <= rejected.score.parts.assets
      );
    case "seller_concern":
    case "other":
      return false;
  }
}

function activeFeedback(
  listings: readonly ReviewedListing[]
): ReviewedListing[] {
  return listings.filter(
    (listing) =>
      listing.manualReview !== null &&
      AUTOMATED_REASONS.has(listing.manualReview.reason) &&
      listing.score !== null
  );
}

export function applyManualPreferenceFeedback(
  listings: readonly ReviewedListing[],
  feedbackListings: readonly ReviewedListing[] = listings
): ReviewedListing[] {
  const feedback = activeFeedback(feedbackListings);
  return listings.map((listing) => {
    if (listing.score === null) return listing;
    const score = listing.score;
    const cleanTotal = score.total - score.preferenceAdjustment;
    const cleanReasons = score.reasons.filter(
      (reason) => !reason.startsWith(FEEDBACK_REASON_PREFIX)
    );
    if (listing.manualReview !== null || feedback.length === 0) {
      return {
        ...listing,
        score: {
          ...score,
          total: cleanTotal,
          preferenceAdjustment: 0,
          reasons: cleanReasons
        }
      };
    }

    const matches = new Map<ManualReviewReason, number>();
    for (const rejected of feedback) {
      const reason = rejected.manualReview?.reason;
      if (
        reason !== undefined &&
        resemblesFeedback(listing, rejected, reason)
      ) {
        matches.set(reason, (matches.get(reason) ?? 0) + 1);
      }
    }

    const penalties = [...matches.entries()]
      .map(([reason, count]) => ({
        reason,
        count,
        penalty: Math.min(MAX_REASON_PENALTY, count)
      }))
      .sort((left, right) =>
        left.reason.localeCompare(right.reason)
      );
    let remainingPenalty = MAX_TOTAL_PENALTY;
    const appliedPenalties = penalties.flatMap((item) => {
      const penalty = Math.min(item.penalty, remainingPenalty);
      remainingPenalty -= penalty;
      return penalty > 0 ? [{ ...item, penalty }] : [];
    });
    const totalPenalty = MAX_TOTAL_PENALTY - remainingPenalty;
    if (totalPenalty === 0) {
      return {
        ...listing,
        score: {
          ...score,
          total: cleanTotal,
          preferenceAdjustment: 0,
          reasons: cleanReasons
        }
      };
    }

    return {
      ...listing,
      score: {
        ...score,
        total: Math.max(0, cleanTotal - totalPenalty),
        preferenceAdjustment: -totalPenalty,
        reasons: [
          ...cleanReasons,
          ...appliedPenalties.map(
            ({ reason, count, penalty }) =>
              `${FEEDBACK_REASON_PREFIX}与 ${count} 个“${MANUAL_REVIEW_REASON_LABELS[reason]}”淘汰号特征相近，排名 -${penalty}`
          ),
          `${FEEDBACK_REASON_PREFIX}累计调整 -${totalPenalty}，最多 -${MAX_TOTAL_PENALTY}；不改变硬条件和安全等级`
        ]
      }
    };
  });
}
