import type { Listing, Score } from "./listing.js";
import {
  CANDIDATE_PRICE_MAX_CNY,
  CANDIDATE_PRICE_MIN_CNY
} from "./priceRange.js";
import {
  ASSET_FULL_SCORE_VALUE_CNY,
  ASSET_RECOVERY_FULL_SCORE_RATE,
  ASSET_RECOVERY_SCORE_MAX,
  ASSET_VALUE_CNY_PER_M,
  M7_PEAK_QUALITY_POINTS,
  M7_PREMIUM_S_POINTS,
  M7_RARE_FINISH_POINTS,
  normalizedRecommendationScore,
  PRICE_AFFORDABILITY_SCORE_MAX,
  SAFETY_SCORE_MAX,
  VALUE_SCORE_MAX
} from "./scoreAllocation.js";

type AssetValuationInput = Pick<
  Listing,
  "totalAssetsM" | "hafCoins" | "priceCny"
>;

type PotentialScoreInput = Pick<
  Listing,
  "m7PrismStatus" | "m7PrismQuality" | "julangStatus"
> & {
  score: Pick<
    Score,
    "total" | "preferenceAdjustment" | "value" | "safety" | "dataQuality"
  > | null;
};

type RecommendationScoreInput = Pick<Score, "total" | "exactTotal">;

function priceAffordabilityPoints(priceCny: number | null): number {
  if (priceCny === null) return 0;
  const range = CANDIDATE_PRICE_MAX_CNY - CANDIDATE_PRICE_MIN_CNY;
  const normalized =
    (CANDIDATE_PRICE_MAX_CNY - priceCny) / range;
  const bounded = normalized < 0 ? 0 : normalized > 1 ? 1 : normalized;
  return bounded * PRICE_AFFORDABILITY_SCORE_MAX;
}

const M7_RARE_FINISH_LABELS = {
  pearl: "珠光 M7",
  iridescent: "炫彩 M7",
  candy: "糖果 M7"
} as const;

function verificationAgeDays(listing: Listing, now: Date): number | null {
  if (listing.verificationAt === null) return null;
  return Math.max(
    0,
    (now.getTime() - Date.parse(listing.verificationAt)) / 86_400_000
  );
}

function m7ValueReason(listing: Listing): string {
  if (listing.m7PrismStatus === "absent") return "M7 未发现";
  if (listing.m7PrismStatus === "unknown") return "M7 待核验";
  if (listing.m7PrismStatus === "conflicting") return "M7 证据冲突";
  if (listing.m7PrismQuality === null) {
    return listing.m7PrismStatus === "premium"
      ? "M7 优品品质待核验"
      : "M7 极品品质待核验";
  }
  const label =
    listing.m7PrismStatus === "premium" ? "优品" : "极品";
  return `M7 ${label}${listing.m7PrismQuality}`;
}

function safetyParts(listing: Listing, now: Date) {
  const verificationAge = verificationAgeDays(listing, now);
  return {
    secondRealName:
      listing.secondRealNameAvailable === true
        ? SAFETY_SCORE_MAX.secondRealName
        : 0,
    recovery: 0 as const,
    // Verification time stays visible as purchase context, but it is not
    // comparable across platforms and must never change the recommendation.
    verification: 0 as const,
    verificationAge
  };
}

function safetyCoverage(listing: Listing): number {
  return listing.secondRealNameAvailable === null ? 0 : 1;
}

function riskLevel(listing: Listing): Score["riskLevel"] {
  if (
    listing.secondRealNameAvailable === false ||
    listing.banNotes.length > 0
  ) {
    return "high";
  }
  return listing.secondRealNameAvailable === null ? "unknown" : "low";
}

function booleanSafetyReason(
  value: boolean | null,
  positive: string,
  negative: string,
  unknown: string
): string {
  return value === true ? positive : value === false ? negative : unknown;
}

function assetValue(listing: AssetValuationInput): {
  sourceM: number | null;
  estimatedCny: number;
  points: number;
  usedHafCoinFallback: boolean;
} {
  const usedHafCoinFallback =
    listing.totalAssetsM === null && listing.hafCoins !== null;
  const sourceM = listing.totalAssetsM ?? (
    listing.hafCoins === null ? null : listing.hafCoins / 1_000_000
  );
  const estimatedCny = (sourceM ?? 0) * ASSET_VALUE_CNY_PER_M;
  const uncappedPoints =
    estimatedCny / ASSET_FULL_SCORE_VALUE_CNY * VALUE_SCORE_MAX.assets;
  return {
    sourceM,
    estimatedCny,
    points: uncappedPoints > VALUE_SCORE_MAX.assets
      ? VALUE_SCORE_MAX.assets
      : uncappedPoints,
    usedHafCoinFallback
  };
}

export function assetRecoveryRate(
  listing: AssetValuationInput
): number | null {
  if (listing.priceCny === null || listing.priceCny <= 0) return null;
  return assetValue(listing).estimatedCny / listing.priceCny;
}

function potentialValueUpside(listing: PotentialScoreInput): number {
  const m7Potential =
    listing.m7PrismStatus === "unknown" ||
    listing.m7PrismStatus === "conflicting" ||
    ((listing.m7PrismStatus === "premium" ||
      listing.m7PrismStatus === "peak") &&
      listing.m7PrismQuality === null)
      ? VALUE_SCORE_MAX.m7
      : 0;
  const julangPotential =
    listing.julangStatus === "unknown" ? VALUE_SCORE_MAX.julang : 0;
  return m7Potential + julangPotential;
}

export function potentialRecommendationScore(
  listing: PotentialScoreInput
): number | null {
  if (listing.score === null) return null;
  const uncappedPotentialValue =
    listing.score.value + potentialValueUpside(listing);
  const potentialValue = uncappedPotentialValue > 100
    ? 100
    : uncappedPotentialValue;
  const potentialTotal = normalizedRecommendationScore(
    potentialValue,
    listing.score.safety,
    listing.score.dataQuality
  );
  const adjustedTotal = potentialTotal + listing.score.preferenceAdjustment;
  const boundedTotal = adjustedTotal < 0
    ? 0
    : adjustedTotal > 100
      ? 100
      : adjustedTotal;
  return Math.round(boundedTotal * 10) / 10;
}

export function preciseRecommendationScore(
  score: RecommendationScoreInput
): number {
  return score.exactTotal ?? score.total;
}

function scoreOne(
  listing: Listing,
  now: Date
): Score {
  const priceAffordability = priceAffordabilityPoints(
    listing.priceCny
  );
  const assetValueResult = assetValue(listing);
  const recoveryRate = assetRecoveryRate(listing);
  const uncappedRecoveryPoints = recoveryRate === null
    ? 0
    : recoveryRate / ASSET_RECOVERY_FULL_SCORE_RATE *
      ASSET_RECOVERY_SCORE_MAX;
  const recoveryPoints = uncappedRecoveryPoints > ASSET_RECOVERY_SCORE_MAX
    ? ASSET_RECOVERY_SCORE_MAX
    : uncappedRecoveryPoints;
  const price = priceAffordability + recoveryPoints;
  const assets = assetValueResult.points;
  const m7Quality =
    listing.m7PrismQuality === null
      ? 0
      : listing.m7PrismStatus === "premium"
        ? listing.m7PrismQuality === "S"
          ? M7_PREMIUM_S_POINTS
          : 0
        : M7_PEAK_QUALITY_POINTS[listing.m7PrismQuality];
  const m7RareFinish = listing.m7RareFinishes.length > 0
    ? M7_RARE_FINISH_POINTS
    : 0;
  const combinedM7 = m7Quality + m7RareFinish;
  const m7 = combinedM7 > VALUE_SCORE_MAX.m7
    ? VALUE_SCORE_MAX.m7
    : combinedM7;
  const scoredRedSkinCount =
    listing.redSkins.length > 5 ? 5 : listing.redSkins.length;
  const redSkins =
    scoredRedSkinCount * (VALUE_SCORE_MAX.redSkins / 5);
  const julang = listing.julangStatus === "owned"
    ? VALUE_SCORE_MAX.julang
    : 0;
  const value = m7 + redSkins + julang + price + assets;
  const safetyPartValues = safetyParts(listing, now);
  const safety =
    safetyPartValues.secondRealName +
    safetyPartValues.recovery +
    safetyPartValues.verification;
  const knownSafetySignals = safetyCoverage(listing);
  const dataQuality = listing.confidence;
  const calculatedRisk = riskLevel(listing);
  const normalizedTotal = normalizedRecommendationScore(
    value,
    safety,
    dataQuality
  );
  const exactTotal = Math.round(normalizedTotal * 10) / 10;
  const total = Math.round(normalizedTotal);
  const julangReason =
    listing.julangStatus === "owned"
      ? "巨浪已拥有"
      : listing.julangStatus === "absent"
        ? "巨浪明确没有"
        : "巨浪待核验";
  const verificationReason =
    safetyPartValues.verificationAge === null
      ? "验号时间仅作参考，不参与评分：待人工核验"
      : `验号时间仅作参考，不参与评分：距今 ${Math.floor(safetyPartValues.verificationAge)} 天`;
  const valueReasons = [
    `${m7ValueReason(listing)}，品质价值 ${m7Quality.toFixed(1)}/${M7_PEAK_QUALITY_POINTS.S}`,
    listing.m7RareFinishes.length > 0
      ? `M7 稀有模板：${listing.m7RareFinishes
          .map((finish) => M7_RARE_FINISH_LABELS[finish])
          .join(" · ")}，价值 ${m7RareFinish.toFixed(1)}/${M7_RARE_FINISH_POINTS}`
      : `M7 稀有模板未发现，价值 0.0/${M7_RARE_FINISH_POINTS}`,
    `${listing.redSkins.length} 个已识别角色红皮，价值 ${redSkins.toFixed(1)}/${VALUE_SCORE_MAX.redSkins}`,
    `${julangReason}，价值 ${julang.toFixed(1)}/${VALUE_SCORE_MAX.julang}`,
    `价格位置 ${priceAffordability.toFixed(1)}/${PRICE_AFFORDABILITY_SCORE_MAX}；资产回收率 ${recoveryRate === null ? "待核验" : `${(recoveryRate * 100).toFixed(0)}%`}，性价比 ${recoveryPoints.toFixed(1)}/${ASSET_RECOVERY_SCORE_MAX}；价格综合 ${price.toFixed(1)}/${VALUE_SCORE_MAX.price}`,
    assetValueResult.sourceM === null
      ? `总资产待核验，资产价值 0.0/${VALUE_SCORE_MAX.assets}`
      : `${assetValueResult.usedHafCoinFallback ? "仅按哈夫币折算" : "总资产"} ${assetValueResult.sourceM.toFixed(1)}M，按 ¥${ASSET_VALUE_CNY_PER_M}/M 估值约 ¥${assetValueResult.estimatedCny.toFixed(0)}，资产价值 ${assets.toFixed(1)}/${VALUE_SCORE_MAX.assets}`
  ];
  const safetyReasons = [
    booleanSafetyReason(
      listing.secondRealNameAvailable,
      "可二次实名",
      "不可二次实名",
      "二次实名待核验"
    ),
    booleanSafetyReason(
      listing.recoveryCoverage,
      "永久包赔仅作参考，不参与评分：页面显示支持",
      "永久包赔仅作参考，不参与评分：页面显示不支持",
      "永久包赔仅作参考，不参与评分：信息未知"
    ),
    verificationReason,
    ...(listing.banNotes.length > 0
      ? [`存在封禁备注：${listing.banNotes.join("；")}`]
      : [])
  ];

  return {
    total,
    exactTotal,
    preferenceAdjustment: 0,
    value,
    safety,
    dataQuality,
    riskLevel: calculatedRisk,
    coverage: {
      knownSafetySignals,
      totalSafetySignals: 1
    },
    parts: {
      m7,
      redSkins,
      julang,
      price,
      assets,
      secondRealName: safetyPartValues.secondRealName,
      recovery: safetyPartValues.recovery,
      verification: safetyPartValues.verification
    },
    valueReasons,
    safetyReasons,
    reasons: [
      `账号价值 ${value.toFixed(1)}/100`,
      `购买安全 ${safety.toFixed(1)}/${SAFETY_SCORE_MAX.total}`,
      `数据完整度 ${dataQuality.toFixed(1)}/100`,
      `综合分按价值 80% + 安全 10% + 数据 10% 计算；安全只看能否二次实名，验号时间与永久包赔不计分`,
      potentialValueUpside(listing) > 0
        ? `待核验价值潜力 +${potentialValueUpside(listing).toFixed(1)}，不直接计入确定分`
        : "当前未识别额外待核验价值潜力"
    ]
  };
}

export function compareRecommendations(left: Listing, right: Listing): number {
  const totalDifference =
    (right.score?.total ?? -1) - (left.score?.total ?? -1);
  if (totalDifference !== 0) return totalDifference;
  const preciseDifference =
    (right.score === null ? -1 : preciseRecommendationScore(right.score)) -
    (left.score === null ? -1 : preciseRecommendationScore(left.score));
  if (preciseDifference !== 0) return preciseDifference;
  const potentialDifference =
    (potentialRecommendationScore(right) ?? -1) -
    (potentialRecommendationScore(left) ?? -1);
  if (potentialDifference !== 0) return potentialDifference;
  if (right.confidence !== left.confidence) {
    return right.confidence - left.confidence;
  }
  if ((left.priceCny ?? Infinity) !== (right.priceCny ?? Infinity)) {
    return (left.priceCny ?? Infinity) - (right.priceCny ?? Infinity);
  }
  const capturedDifference = Date.parse(right.capturedAt) - Date.parse(left.capturedAt);
  if (capturedDifference !== 0) return capturedDifference;
  return left.url.localeCompare(right.url);
}

export function scoreEligibleListings(
  listings: Listing[],
  now = new Date()
): Listing[] {
  const candidates = listings.filter(
    ({ eligibility }) => eligibility === "eligible"
  );
  return candidates
    .map((listing) => ({
      ...listing,
      score: scoreOne(listing, now)
    }))
    .sort(compareRecommendations);
}
