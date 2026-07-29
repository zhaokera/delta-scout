import type { Listing, SourceId } from "./listing.js";
import { compareRecommendations } from "./score.js";

export function selectBalancedCandidatePool(
  listings: Listing[],
  perSourceLimit = 10
): Listing[] {
  const orderedEligibleScored = listings
    .filter(
      (listing) =>
        listing.eligibility === "eligible" && listing.score !== null
    )
    .sort(compareRecommendations);

  const { selected } = orderedEligibleScored.reduce(
    (
      state: {
        selected: Listing[];
        seenKeys: Map<string, true>;
        sourceCounts: Map<SourceId, number>;
      },
      listing
    ) => {
      if (state.seenKeys.has(listing.key)) {
        return state;
      }
      state.seenKeys.set(listing.key, true);

      const sourceCount = state.sourceCounts.get(listing.source) ?? 0;
      if (sourceCount >= perSourceLimit) {
        return state;
      }
      state.sourceCounts.set(listing.source, sourceCount + 1);
      state.selected.push(listing);
      return state;
    },
    {
      selected: [],
      seenKeys: new Map<string, true>(),
      sourceCounts: new Map<SourceId, number>()
    }
  );

  return selected;
}

export function selectGlobalCandidatePool(
  listings: Listing[],
  limit = 30
): Listing[] {
  const seenKeys = new Set<string>();
  const selected: Listing[] = [];
  for (const listing of listings
    .filter(
      (candidate) =>
        candidate.eligibility === "eligible" &&
        candidate.score !== null
    )
    .sort(compareRecommendations)) {
    if (seenKeys.has(listing.key)) continue;
    seenKeys.add(listing.key);
    selected.push(listing);
    if (selected.length >= limit) break;
  }
  return selected;
}
