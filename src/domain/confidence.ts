import type { Listing } from "./listing.js";

export function calculateConfidence(listing: Listing): number {
  let confidence = 0;

  if (
    listing.m7Evidence.length > 0 &&
    !["unknown", "conflicting"].includes(listing.m7PrismStatus)
  ) {
    confidence += 35;
  }
  if (listing.loginPlatform !== "unknown") {
    confidence += 15;
  }
  if (listing.priceCny !== null) {
    confidence += 15;
  }
  if (
    listing.secondRealNameAvailable !== null ||
    listing.recoveryCoverage !== null ||
    listing.verificationAt !== null
  ) {
    confidence += 15;
  }
  if (listing.totalAssetsM !== null || listing.hafCoins !== null) {
    confidence += 10;
  }
  if (
    listing.redSkins.length > 0 ||
    listing.redSkinUnnamed ||
    listing.julangStatus !== "unknown"
  ) {
    confidence += 10;
  }

  return Math.min(100, Math.max(0, Math.round(confidence)));
}
