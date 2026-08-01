import type { Listing, SourceId } from "./listing.js";

type FilterableListing = Pick<
  Listing,
  | "source"
  | "priceCny"
  | "redSkins"
  | "redSkinCount"
  | "julangStatus"
  | "m7PrismQuality"
  | "secondRealNameAvailable"
  | "recoveryCoverage"
  | "verificationAt"
  | "scanStability"
>;

export interface ListingFilters {
  source: SourceId | "all";
  secondRealName: boolean;
  recoveryCoverage: boolean;
  redSkin: string;
  julang: "all" | "owned" | "absent" | "unknown";
  m7Quality: "all" | "S" | "A" | "B" | "C";
  minRedSkinCount: 0 | 1 | 2 | 3 | 4;
  evidenceCompleteness: "all" | "complete" | "unknown";
  stability: "all" | "stable" | "new" | "changed";
}

export function hasCompleteKeyEvidence(
  listing: FilterableListing
): boolean {
  return (
    listing.priceCny !== null &&
    listing.m7PrismQuality !== null &&
    listing.secondRealNameAvailable !== null &&
    listing.recoveryCoverage !== null &&
    listing.verificationAt !== null
  );
}

function normalizeSearch(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/gu, "");
}

export function matchesListingFilters(
  listing: FilterableListing,
  filters: ListingFilters
): boolean {
  const redSkinQuery = normalizeSearch(filters.redSkin);
  const completeEvidence = hasCompleteKeyEvidence(listing);

  return (
    (filters.source === "all" || listing.source === filters.source) &&
    (!filters.secondRealName ||
      listing.secondRealNameAvailable === true) &&
    (!filters.recoveryCoverage || listing.recoveryCoverage === true) &&
    (redSkinQuery.length === 0 ||
      listing.redSkins.some((name) =>
        normalizeSearch(name).includes(redSkinQuery)
      )) &&
    (filters.julang === "all" ||
      listing.julangStatus === filters.julang) &&
    (filters.m7Quality === "all" ||
      listing.m7PrismQuality === filters.m7Quality) &&
    filters.minRedSkinCount <= (listing.redSkinCount ?? 0) &&
    (filters.evidenceCompleteness === "all" ||
      (filters.evidenceCompleteness === "complete"
        ? completeEvidence
        : !completeEvidence)) &&
    (filters.stability === "all" ||
      listing.scanStability === filters.stability)
  );
}
