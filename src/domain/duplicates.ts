import type { Listing } from "./listing.js";

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

function isPossibleDuplicate(left: Listing, right: Listing): boolean {
  if (
    left.source === right.source ||
    left.totalAssetsM === null ||
    right.totalAssetsM === null ||
    Math.abs(left.totalAssetsM - right.totalAssetsM) > 0.5 ||
    left.hafCoins === null ||
    right.hafCoins === null ||
    left.hafCoins !== right.hafCoins
  ) {
    return false;
  }

  const leftSignatures = [
    JSON.stringify(left.m7Evidence.map(({ text }) => text.trim()).sort()),
    evidenceSignature(left, (text) => /红皮|红色品质/.test(text)),
    evidenceSignature(left, (text) => text.includes("巨浪"))
  ];
  const rightSignatures = [
    JSON.stringify(right.m7Evidence.map(({ text }) => text.trim()).sort()),
    evidenceSignature(right, (text) => /红皮|红色品质/.test(text)),
    evidenceSignature(right, (text) => text.includes("巨浪"))
  ];

  return (
    leftSignatures.every((signature) => signature !== null && signature !== "[]") &&
    leftSignatures.every(
      (signature, index) => signature === rightSignatures[index]
    )
  );
}

export function markPossibleDuplicates(listings: Listing[]): Listing[] {
  const duplicateKeys = new Map<string, string[]>();
  for (const listing of listings) {
    duplicateKeys.set(listing.key, []);
  }

  for (let leftIndex = 0; leftIndex < listings.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < listings.length;
      rightIndex += 1
    ) {
      const left = listings[leftIndex];
      const right = listings[rightIndex];
      if (isPossibleDuplicate(left, right)) {
        duplicateKeys.get(left.key)?.push(right.key);
        duplicateKeys.get(right.key)?.push(left.key);
      }
    }
  }

  return listings.map((listing) => ({
    ...listing,
    possibleDuplicateKeys: duplicateKeys.get(listing.key) ?? []
  }));
}
