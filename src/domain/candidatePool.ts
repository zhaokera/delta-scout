import type { Listing, SourceId } from "./listing.js";
import { compareRecommendations } from "./score.js";

function isRecommendationCandidate(listing: Listing): boolean {
  return (
    listing.eligibility === "eligible" &&
    listing.score !== null &&
    listing.score.riskLevel !== "high"
  );
}

function conflictsWithSelectedDuplicate(
  listing: Listing,
  selectedKeys: ReadonlySet<string>,
  blockedDuplicateKeys: ReadonlySet<string>
): boolean {
  return (
    selectedKeys.has(listing.key) ||
    blockedDuplicateKeys.has(listing.key) ||
    listing.possibleDuplicateKeys.some((key) => selectedKeys.has(key))
  );
}

function rememberSelected(
  listing: Listing,
  selectedKeys: Set<string>,
  blockedDuplicateKeys: Set<string>
): void {
  selectedKeys.add(listing.key);
  for (const key of listing.possibleDuplicateKeys) {
    blockedDuplicateKeys.add(key);
  }
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
        selectedKeys: Set<string>;
        blockedDuplicateKeys: Set<string>;
        sourceCounts: Map<SourceId, number>;
      },
      listing
    ) => {
      if (
        conflictsWithSelectedDuplicate(
          listing,
          state.selectedKeys,
          state.blockedDuplicateKeys
        )
      ) {
        return state;
      }

      const sourceCount = state.sourceCounts.get(listing.source) ?? 0;
      if (sourceCount >= perSourceLimit) {
        return state;
      }
      rememberSelected(
        listing,
        state.selectedKeys,
        state.blockedDuplicateKeys
      );
      state.sourceCounts.set(listing.source, sourceCount + 1);
      state.selected.push(listing);
      return state;
    },
    {
      selected: [],
      selectedKeys: new Set<string>(),
      blockedDuplicateKeys: new Set<string>(),
      sourceCounts: new Map<SourceId, number>()
    }
  );

  return selected;
}

export function selectGlobalCandidatePool(
  listings: Listing[],
  limit = 30
): Listing[] {
  const selectedKeys = new Set<string>();
  const blockedDuplicateKeys = new Set<string>();
  const selected: Listing[] = [];
  for (const listing of listings
    .filter(isRecommendationCandidate)
    .sort(compareRecommendations)) {
    if (
      conflictsWithSelectedDuplicate(
        listing,
        selectedKeys,
        blockedDuplicateKeys
      )
    ) continue;
    rememberSelected(listing, selectedKeys, blockedDuplicateKeys);
    selected.push(listing);
    if (selected.length >= limit) break;
  }
  return selected;
}
