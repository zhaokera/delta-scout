import {
  ListingSchema,
  type Listing
} from "../domain/listing.js";

export function parseStoredListing(payload: string): Listing {
  const raw = JSON.parse(payload) as unknown;
  const parsed = ListingSchema.safeParse(raw);
  if (parsed.success) {
    return parsed.data;
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
      return withoutLegacyScore.data;
    }
  }

  return ListingSchema.parse(raw);
}
