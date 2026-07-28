import type { Listing, SourceId } from "./listing.js";

const SOURCE_ORDER: readonly SourceId[] = [
  "jiaoyimao",
  "panzhi",
  "pxb7"
];
const MAX_ASSET_DIFFERENCE_M = 0.5;

interface DuplicateCandidate {
  index: number;
  key: string;
  totalAssetsM: number;
}

function evidenceSignature(
  listing: Listing,
  predicate: (text: string) => boolean
): string | null {
  const matching = listing.evidence
    .map(({ text }) => text.trim())
    .filter(predicate)
    .sort();
  return matching.length > 0 ? JSON.stringify(matching) : null;
}

function strictEvidenceSignature(listing: Listing): string | null {
  const signatures = [
    listing.m7Evidence.length > 0
      ? JSON.stringify(
          listing.m7Evidence.map(({ text }) => text.trim()).sort()
        )
      : null,
    evidenceSignature(listing, (text) => /红皮|红色品质/.test(text)),
    evidenceSignature(listing, (text) => text.includes("巨浪"))
  ];
  return signatures.every(
    (signature): signature is string => signature !== null
  )
    ? JSON.stringify(signatures)
    : null;
}

function compareCandidates(
  left: DuplicateCandidate,
  right: DuplicateCandidate
): number {
  const assetDifference = left.totalAssetsM - right.totalAssetsM;
  return assetDifference !== 0
    ? assetDifference
    : left.key.localeCompare(right.key);
}

function lowerBound(
  candidates: DuplicateCandidate[],
  totalAssetsM: number
): number {
  let lower = 0;
  let upper = candidates.length;
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    if (candidates[middle].totalAssetsM < totalAssetsM) {
      lower = middle + 1;
    } else {
      upper = middle;
    }
  }
  return lower;
}

function nearestCandidate(
  candidates: DuplicateCandidate[],
  totalAssetsM: number
): DuplicateCandidate | null {
  const insertion = lowerBound(candidates, totalAssetsM);
  const neighbors = [
    candidates[insertion],
    candidates[insertion - 1]
  ].filter(
    (candidate): candidate is DuplicateCandidate =>
      candidate !== undefined
  );
  let nearest: DuplicateCandidate | null = null;
  let nearestDistance = Infinity;
  for (const candidate of neighbors) {
    const distance = Math.abs(candidate.totalAssetsM - totalAssetsM);
    if (
      distance < nearestDistance ||
      (distance === nearestDistance &&
        nearest !== null &&
        candidate.key.localeCompare(nearest.key) < 0)
    ) {
      nearest = candidate;
      nearestDistance = distance;
    }
  }
  return nearestDistance <= MAX_ASSET_DIFFERENCE_M ? nearest : null;
}

export function markPossibleDuplicates(listings: Listing[]): Listing[] {
  const duplicateKeys = Array.from(
    { length: listings.length },
    () => [] as string[]
  );
  const buckets = new Map<
    string,
    Map<SourceId, DuplicateCandidate[]>
  >();

  listings.forEach((listing, index) => {
    if (listing.totalAssetsM === null || listing.hafCoins === null) {
      return;
    }
    const signature = strictEvidenceSignature(listing);
    if (signature === null) return;
    const bucketKey = JSON.stringify([listing.hafCoins, signature]);
    const bucket =
      buckets.get(bucketKey) ??
      new Map<SourceId, DuplicateCandidate[]>();
    const candidates = bucket.get(listing.source) ?? [];
    candidates.push({
      index,
      key: listing.key,
      totalAssetsM: listing.totalAssetsM
    });
    bucket.set(listing.source, candidates);
    buckets.set(bucketKey, bucket);
  });

  for (const bucket of buckets.values()) {
    for (const candidates of bucket.values()) {
      candidates.sort(compareCandidates);
    }
    for (const source of SOURCE_ORDER) {
      for (const candidate of bucket.get(source) ?? []) {
        for (const otherSource of SOURCE_ORDER) {
          if (otherSource === source) continue;
          const nearest = nearestCandidate(
            bucket.get(otherSource) ?? [],
            candidate.totalAssetsM
          );
          if (nearest !== null) {
            duplicateKeys[candidate.index].push(nearest.key);
          }
        }
      }
    }
  }

  return listings.map((listing, index) => ({
    ...listing,
    possibleDuplicateKeys: duplicateKeys[index]
  }));
}
