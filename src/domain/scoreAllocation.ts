export const VALUE_SCORE_MAX = {
  m7: 15,
  redSkins: 25,
  julang: 15,
  price: 20,
  assets: 25
} as const;

export const ASSET_VALUE_CNY_PER_M = 2;
export const ASSET_FULL_SCORE_VALUE_CNY = 1_000;

export const PRICE_AFFORDABILITY_SCORE_MAX = 10;
export const ASSET_RECOVERY_SCORE_MAX = 10;
export const ASSET_RECOVERY_FULL_SCORE_RATE = 0.6;

export const M7_PEAK_QUALITY_POINTS = {
  S: 12,
  A: 10,
  B: 8,
  C: 6
} as const;

export const M7_PREMIUM_S_POINTS = 5;
export const M7_RARE_FINISH_POINTS = 3;

export const SAFETY_SCORE_MAX = {
  secondRealName: 10,
  total: 10
} as const;

export const RECOMMENDATION_SCORE_WEIGHTS = {
  value: 0.8,
  safety: 0.1,
  dataQuality: 0.1
} as const;

export const RECOMMENDATION_RAW_MAX = 100;

export function normalizedRecommendationScore(
  value: number,
  safety: number,
  dataQuality: number
): number {
  const normalizedSafety =
    safety / SAFETY_SCORE_MAX.total * 100;
  const raw =
    value * RECOMMENDATION_SCORE_WEIGHTS.value +
    normalizedSafety * RECOMMENDATION_SCORE_WEIGHTS.safety +
    dataQuality * RECOMMENDATION_SCORE_WEIGHTS.dataQuality;
  return raw;
}
