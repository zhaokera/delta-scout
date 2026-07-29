import type { Listing, Score } from "./listing.js";
import { buildMidrankPercentiles } from "./percentile.js";

interface NormalizationStats {
  prices: Map<number, number>;
  totalAssets: Map<number, number>;
  hafCoins: Map<number, number>;
}

function buildNormalizationStats(
  candidates: Listing[]
): NormalizationStats {
  return {
    prices: buildMidrankPercentiles(
      candidates.map(({ priceCny }) => priceCny)
    ),
    totalAssets: buildMidrankPercentiles(
      candidates.map(({ totalAssetsM }) => totalAssetsM)
    ),
    hafCoins: buildMidrankPercentiles(
      candidates.map(({ hafCoins }) => hafCoins)
    )
  };
}

function percentile(
  value: number | null,
  percentiles: Map<number, number>
): number {
  return value === null ? 0 : (percentiles.get(value) ?? 0);
}

function safetyScore(listing: Listing, now: Date): number {
  let score = 0;
  if (listing.secondRealNameAvailable === true) {
    score += 12;
  }
  if (listing.recoveryCoverage === true) {
    score += 8;
  }
  if (listing.verificationAt !== null) {
    const ageDays = Math.max(
      0,
      (now.getTime() - Date.parse(listing.verificationAt)) / 86_400_000
    );
    score += ageDays <= 7 ? 10 : ageDays <= 30 ? 6 : 2;
  }
  return score;
}

const QUALITY_POINTS = {
  S: 14,
  A: 11,
  B: 8,
  C: 5
} as const;

function skinValueScore(listing: Listing): number {
  const scoredRedSkinCount =
    listing.redSkins.length > 4 ? 4 : listing.redSkins.length;
  return (
    (listing.m7PrismQuality === null
      ? 0
      : QUALITY_POINTS[listing.m7PrismQuality]) +
    scoredRedSkinCount * 2.5 +
    (listing.julangStatus === "owned" ? 6 : 0)
  );
}

function skinValueReason(listing: Listing): string {
  const quality =
    listing.m7PrismQuality === null
      ? "极品品质待核验"
      : `M7 极品${listing.m7PrismQuality}`;
  const julang =
    listing.julangStatus === "owned"
      ? "巨浪已拥有"
      : listing.julangStatus === "absent"
        ? "巨浪明确没有"
        : "巨浪待核验";
  return `${quality}；${listing.redSkins.length} 个已识别角色红皮；${julang}`;
}

function scoreOne(
  listing: Listing,
  stats: NormalizationStats,
  now: Date
): Score {
  const price =
    listing.priceCny === null
      ? 0
      : (1 - percentile(listing.priceCny, stats.prices)) * 20;
  const hasAssets =
    listing.totalAssetsM !== null || listing.hafCoins !== null;
  const assets =
    percentile(listing.totalAssetsM, stats.totalAssets) * 6 +
    percentile(listing.hafCoins, stats.hafCoins) * 3 +
    (hasAssets ? 1 : 0);
  const safety = safetyScore(listing, now);
  const skinValue = skinValueScore(listing);
  const confidence = (listing.confidence / 100) * 10;
  const total = Math.round(
    safety + skinValue + price + assets + confidence
  );

  return {
    total,
    parts: { safety, skinValue, price, assets, confidence },
    reasons: [
      `安全信息 ${safety.toFixed(1)}/30`,
      `皮肤价值 ${skinValue.toFixed(1)}/30（${skinValueReason(listing)}）`,
      `价格合理性 ${price.toFixed(1)}/20`,
      `可核验资产 ${assets.toFixed(1)}/10`,
      `数据置信度 ${confidence.toFixed(1)}/10`
    ]
  };
}

export function compareRecommendations(left: Listing, right: Listing): number {
  const totalDifference =
    (right.score?.total ?? -1) - (left.score?.total ?? -1);
  if (totalDifference !== 0) return totalDifference;
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
  const stats = buildNormalizationStats(candidates);
  return candidates
    .map((listing) => ({
      ...listing,
      score: scoreOne(listing, stats, now)
    }))
    .sort(compareRecommendations);
}
