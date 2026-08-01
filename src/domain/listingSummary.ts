import type { Score } from "./listing.js";
import type { ReviewedListing } from "./manualReview.js";

export type ListingSummaryScore = Omit<
  Score,
  "valueReasons" | "safetyReasons" | "reasons"
>;

export type ReviewedListingSummary = Omit<
  ReviewedListing,
  | "originalDescription"
  | "evidence"
  | "m7Evidence"
  | "m7RareFinishEvidence"
  | "banNotes"
  | "parseWarnings"
  | "score"
> & {
  detailLevel?: "summary";
  evidenceCount?: number;
  m7EvidenceCount?: number;
  m7RareFinishEvidenceCount?: number;
  banNoteCount?: number;
  parseWarningCount?: number;
  score: ListingSummaryScore | null;
};

export function summarizeReviewedListing(
  listing: ReviewedListing
): ReviewedListingSummary {
  const summaryScore = listing.score === null
    ? null
    : (({
        valueReasons: _valueReasons,
        safetyReasons: _safetyReasons,
        reasons: _reasons,
        ...score
      }) => score)(listing.score);
  const {
    originalDescription: _originalDescription,
    evidence,
    m7Evidence,
    m7RareFinishEvidence,
    banNotes,
    parseWarnings,
    score: _score,
    ...summary
  } = listing;
  return {
    ...summary,
    detailLevel: "summary",
    evidenceCount: evidence.length,
    m7EvidenceCount: m7Evidence.length,
    m7RareFinishEvidenceCount: m7RareFinishEvidence.length,
    banNoteCount: banNotes.length,
    parseWarningCount: parseWarnings.length,
    score: summaryScore
  };
}

export function isReviewedListingSummary(
  listing: unknown
): listing is ReviewedListingSummary {
  return (
    listing !== null &&
    typeof listing === "object" &&
    "detailLevel" in listing &&
    listing.detailLevel === "summary"
  );
}
