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

const QUALITY_POINTS = {
  S: 27,
  A: 23,
  B: 18,
  C: 14
} as const;
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
  const quality =
    listing.m7PrismQuality === null
      ? "极品品质待核验"
      : `M7 极品${listing.m7PrismQuality}`;
  return quality;
}

function safetyParts(listing: Listing, now: Date) {
  const verificationAge = verificationAgeDays(listing, now);
  return {
    secondRealName:
      listing.secondRealNameAvailable === true ? 40 : 0,
    recovery: listing.recoveryCoverage === true ? 35 : 0,
    verification:
      verificationAge === null
        ? 0
        : verificationAge <= 7
          ? 25
          : verificationAge <= 30
            ? 15
            : 5,
    verificationAge
  };
}

function safetyCoverage(listing: Listing): number {
  return [
    listing.secondRealNameAvailable,
    listing.recoveryCoverage,
    listing.verificationAt
  ].filter((value) => value !== null).length;
}

function riskLevel(
  listing: Listing,
  safety: number,
  knownSafetySignals: number,
  verificationAge: number | null
): Score["riskLevel"] {
  if (
    listing.secondRealNameAvailable === false ||
    listing.recoveryCoverage === false ||
    listing.banNotes.length > 0
  ) {
    return "high";
  }
  if (knownSafetySignals === 0) return "unknown";
  if (
    knownSafetySignals < 3 ||
    verificationAge === null ||
    verificationAge > 30 ||
    safety < 75
  ) {
    return "medium";
  }
  return "low";
}

function booleanSafetyReason(
  value: boolean | null,
  positive: string,
  negative: string,
  unknown: string
): string {
  return value === true ? positive : value === false ? negative : unknown;
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
  const m7Quality =
    listing.m7PrismQuality === null
      ? 0
      : QUALITY_POINTS[listing.m7PrismQuality];
  const m7RareFinish = listing.m7RareFinishes.length > 0 ? 8 : 0;
  const combinedM7 = m7Quality + m7RareFinish;
  const m7 = combinedM7 > 35 ? 35 : combinedM7;
  const scoredRedSkinCount =
    listing.redSkins.length > 5 ? 5 : listing.redSkins.length;
  const redSkins = scoredRedSkinCount * 4;
  const julang = listing.julangStatus === "owned" ? 15 : 0;
  const value = m7 + redSkins + julang + price + assets;
  const safetyPartValues = safetyParts(listing, now);
  const safety =
    safetyPartValues.secondRealName +
    safetyPartValues.recovery +
    safetyPartValues.verification;
  const knownSafetySignals = safetyCoverage(listing);
  const dataQuality = listing.confidence;
  const calculatedRisk = riskLevel(
    listing,
    safety,
    knownSafetySignals,
    safetyPartValues.verificationAge
  );
  const total = Math.round(
    value * 0.55 + safety * 0.35 + dataQuality * 0.1
  );
  const julangReason =
    listing.julangStatus === "owned"
      ? "巨浪已拥有"
      : listing.julangStatus === "absent"
        ? "巨浪明确没有"
        : "巨浪待核验";
  const verificationReason =
    safetyPartValues.verificationAge === null
      ? "验号时间待核验"
      : `验号距今 ${Math.floor(safetyPartValues.verificationAge)} 天`;
  const valueReasons = [
    `${m7ValueReason(listing)}，品质价值 ${m7Quality.toFixed(1)}/27`,
    listing.m7RareFinishes.length > 0
      ? `M7 稀有模板：${listing.m7RareFinishes
          .map((finish) => M7_RARE_FINISH_LABELS[finish])
          .join(" · ")}，价值 ${m7RareFinish.toFixed(1)}/8`
      : "M7 稀有模板待核验，价值 0.0/8",
    `${listing.redSkins.length} 个已识别角色红皮，价值 ${redSkins.toFixed(1)}/20`,
    `${julangReason}，价值 ${julang.toFixed(1)}/15`,
    `价格合理性 ${price.toFixed(1)}/20`,
    `可核验资产 ${assets.toFixed(1)}/10`
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
      "支持找回包赔",
      "明确无包赔",
      "找回保障待核验"
    ),
    verificationReason,
    ...(listing.banNotes.length > 0
      ? [`存在封禁备注：${listing.banNotes.join("；")}`]
      : [])
  ];

  return {
    total,
    value,
    safety,
    dataQuality,
    riskLevel: calculatedRisk,
    coverage: {
      knownSafetySignals,
      totalSafetySignals: 3
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
      `购买安全 ${safety.toFixed(1)}/100`,
      `数据完整度 ${dataQuality.toFixed(1)}/100`,
      `综合分 = 价值 55% + 安全 35% + 数据 10%`
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
