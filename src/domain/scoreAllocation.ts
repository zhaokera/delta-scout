export const VALUE_SCORE_MAX = {
  m7: 15,
  redSkins: 30,
  julang: 20,
  price: 25,
  assets: 10
} as const;

export const M7_PEAK_QUALITY_POINTS = {
  S: 12,
  A: 10,
  B: 8,
  C: 6
} as const;

export const M7_PREMIUM_S_POINTS = 5;
export const M7_RARE_FINISH_POINTS = 3;

export const SAFETY_SCORE_MAX = {
  secondRealName: 40,
  verification: 25,
  total: 65
} as const;

export const RECOMMENDATION_SCORE_WEIGHTS = {
  value: 0.55,
  safety: 0.35,
  dataQuality: 0.1
} as const;

export const RECOMMENDATION_RAW_MAX =
  100 * RECOMMENDATION_SCORE_WEIGHTS.value +
  SAFETY_SCORE_MAX.total * RECOMMENDATION_SCORE_WEIGHTS.safety +
  100 * RECOMMENDATION_SCORE_WEIGHTS.dataQuality;

export function normalizedRecommendationScore(
  value: number,
  safety: number,
  dataQuality: number
): number {
  const raw =
    value * RECOMMENDATION_SCORE_WEIGHTS.value +
    safety * RECOMMENDATION_SCORE_WEIGHTS.safety +
    dataQuality * RECOMMENDATION_SCORE_WEIGHTS.dataQuality;
  return (raw / RECOMMENDATION_RAW_MAX) * 100;
}
