import type { Listing, Score } from "./listing.js";

function normalize(value: number | null, values: number[]): number {
  if (value === null || values.length === 0) {
    return 0;
  }
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  if (minimum === maximum) {
    return 0.5;
  }
  return (value - minimum) / (maximum - minimum);
}

function safetyScore(listing: Listing, now: Date): number {
  let score = 0;
  if (listing.secondRealNameAvailable === true) {
    score += 15;
  }
  if (listing.recoveryCoverage === true) {
    score += 10;
  }
  if (listing.verificationAt !== null) {
    const ageDays = Math.max(
      0,
      (now.getTime() - Date.parse(listing.verificationAt)) / 86_400_000
    );
    score += ageDays <= 7 ? 10 : ageDays <= 30 ? 6 : 2;
  }
  if (
    listing.secondRealNameAvailable !== null &&
    listing.recoveryCoverage !== null &&
    listing.verificationAt !== null
  ) {
    score += 5;
  }
  return score;
}

function scoreOne(
  listing: Listing,
  candidates: Listing[],
  now: Date
): Score {
  const prices = candidates
    .map(({ priceCny }) => priceCny)
    .filter((value): value is number => value !== null);
  const totalAssets = candidates
    .map(({ totalAssetsM }) => totalAssetsM)
    .filter((value): value is number => value !== null);
  const hafCoins = candidates
    .map(({ hafCoins: value }) => value)
    .filter((value): value is number => value !== null);

  const price =
    listing.priceCny === null
      ? 0
      : (1 - normalize(listing.priceCny, prices)) * 25;
  const hasAssets =
    listing.totalAssetsM !== null || listing.hafCoins !== null;
  const assets =
    normalize(listing.totalAssetsM, totalAssets) * 12 +
    normalize(listing.hafCoins, hafCoins) * 5 +
    (hasAssets ? 3 : 0);
  const safety = safetyScore(listing, now);
  const confidence = (listing.confidence / 100) * 15;
  const total = Math.round(safety + price + assets + confidence);

  return {
    total,
    parts: { safety, price, assets, confidence },
    reasons: [
      `安全信息 ${safety.toFixed(1)}/40`,
      `价格合理性 ${price.toFixed(1)}/25`,
      `可核验资产 ${assets.toFixed(1)}/20`,
      `数据置信度 ${confidence.toFixed(1)}/15`
    ]
  };
}

export function compareRecommendations(left: Listing, right: Listing): number {
  const totalDifference = (right.score?.total ?? 0) - (left.score?.total ?? 0);
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
  return candidates
    .map((listing) => ({
      ...listing,
      score: scoreOne(listing, candidates, now)
    }))
    .sort(compareRecommendations);
}
