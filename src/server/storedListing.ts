import {
  ListingSchema,
  type Listing
} from "../domain/listing.js";

function repairLegacyBillionAssetUnit(listing: Listing): Listing {
  if (listing.totalAssetsM !== null && listing.totalAssetsM >= 1) {
    return listing;
  }
  const match = `${listing.title}\n${listing.originalDescription}`.match(
    /总资产[】：:\s]*([\d.]+)\s*[bB](?![A-Za-z])/u
  );
  if (!match) return listing;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) return listing;
  return { ...listing, totalAssetsM: value * 1_000 };
}

function normalizeStoredListing(listing: Listing): Listing {
  return repairLegacyBillionAssetUnit(listing);
}

export function parseStoredListing(payload: string): Listing {
  const raw = JSON.parse(payload) as unknown;
  const parsed = ListingSchema.safeParse(raw);
  if (parsed.success) {
    return normalizeStoredListing(parsed.data);
  }

  if (
    typeof raw === "object" &&
    raw !== null &&
    "score" in raw &&
    raw.score !== null
  ) {
    const withoutLegacyScore = ListingSchema.safeParse({
      ...raw,
      score: null
    });
    if (withoutLegacyScore.success) {
      return normalizeStoredListing(withoutLegacyScore.data);
    }
  }

  return normalizeStoredListing(ListingSchema.parse(raw));
}
