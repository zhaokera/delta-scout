import { createHash } from "node:crypto";
import type { Listing } from "./listing.js";
import { normalizeM7RareFinishes } from "./listingHistory.js";

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) =>
    left.localeCompare(right, "zh-CN")
  );
}

export function listingMaterialHash(listing: Listing): string {
  const m7RareFinishes = normalizeM7RareFinishes(
    listing.m7RareFinishes
  );
  const material = {
    priceCny: listing.priceCny,
    eligibility: listing.eligibility,
    m7PrismStatus: listing.m7PrismStatus,
    m7PrismQuality: listing.m7PrismQuality,
    ...(m7RareFinishes.length > 0 ? { m7RareFinishes } : {}),
    redSkins: sortedUnique(listing.redSkins),
    redSkinCount: listing.redSkinCount,
    redSkinUnnamed: listing.redSkinUnnamed,
    julangStatus: listing.julangStatus,
    julangQuality: listing.julangQuality,
    totalAssetsM: listing.totalAssetsM,
    hafCoins: listing.hafCoins,
    secondRealNameAvailable: listing.secondRealNameAvailable,
    recoveryCoverage: listing.recoveryCoverage,
    verificationAt: listing.verificationAt,
    banNotes: sortedUnique(listing.banNotes),
    confidence: listing.confidence,
    parseWarnings: sortedUnique(listing.parseWarnings)
  };
  return createHash("sha256")
    .update(JSON.stringify(material))
    .digest("hex");
}
