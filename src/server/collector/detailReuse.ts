import type { Listing } from "../../domain/listing.js";
import type { ListingDetail, ListingSummary } from "./types.js";

export const TOP_CANDIDATE_DETAIL_MAX_AGE_MS =
  6 * 60 * 60 * 1_000;
export const STABLE_DETAIL_MAX_AGE_MS =
  24 * 60 * 60 * 1_000;

function compactVisibleText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function evidenceTimestamp(listing: Listing): number {
  // `verificationAt` is the seller report's displayed verification time, not
  // the moment this collector fetched the detail page. Cache freshness must be
  // based on our own observation time; deep refreshes still bypass reuse.
  return Date.parse(listing.capturedAt);
}

export function listingDetailFromListing(
  listing: Listing
): ListingDetail {
  return {
    evidence: listing.evidence,
    loginPlatform: listing.loginPlatform,
    service: listing.service,
    totalAssetsM: listing.totalAssetsM,
    hafCoins: listing.hafCoins,
    realNameStatus: listing.realNameStatus,
    secondRealNameAvailable: listing.secondRealNameAvailable,
    recoveryCoverage: listing.recoveryCoverage,
    verificationAt: listing.verificationAt,
    banNotes: listing.banNotes
  };
}

export function detailReuseMaxAge(listing: Listing): number {
  const score = listing.score?.exactTotal ?? listing.score?.total ?? 0;
  return score >= 60 || listing.eligibility !== "eligible"
    ? TOP_CANDIDATE_DETAIL_MAX_AGE_MS
    : STABLE_DETAIL_MAX_AGE_MS;
}

export function canReuseListingDetail(
  listing: Listing,
  summary: Pick<
    ListingSummary,
    "source" | "sourceListingId" | "title" | "rawText" | "priceCny"
  >,
  now: Date,
  maximumAgeMs = detailReuseMaxAge(listing)
): boolean {
  const verifiedAt = evidenceTimestamp(listing);
  const age = now.getTime() - verifiedAt;
  const cardText = compactVisibleText(summary.rawText);
  const storedText = compactVisibleText(listing.originalDescription);
  return (
    listing.source === summary.source &&
    listing.sourceListingId === summary.sourceListingId &&
    age >= 0 &&
    age <= maximumAgeMs &&
    compactVisibleText(listing.title) ===
      compactVisibleText(summary.title) &&
    cardText.length >= 4 &&
    storedText.includes(cardText) &&
    listing.parseWarnings.length === 0 &&
    listing.secondRealNameAvailable !== null &&
    listing.evidence.length > 0
  );
}
