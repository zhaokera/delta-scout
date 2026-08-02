import type { Listing, SourceId } from "./listing.js";
import { compareRecommendations } from "./score.js";

function isRecommendationCandidate(listing: Listing): boolean {
  return (
    listing.eligibility === "eligible" &&
    listing.score !== null &&
    listing.score.riskLevel !== "high"
  );
}

export function selectBalancedCandidatePool(
  listings: Listing[],
  perSourceLimit = 10
): Listing[] {
  const orderedEligibleScored = listings
    .filter(isRecommendationCandidate)
    .sort(compareRecommendations);

  const { selected } = orderedEligibleScored.reduce(
    (
      state: {
        selected: Listing[];
        sourceCounts: Map<SourceId, number>;
      },
      listing
    ) => {
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
      sourceCounts: new Map<SourceId, number>()
    }
  );

  return selected;
}

export function selectGlobalCandidatePool(
  listings: Listing[],
  limit = 30
): Listing[] {
  return listings
    .filter(isRecommendationCandidate)
    .sort(compareRecommendations)
    .slice(0, limit);
}
