export const CANDIDATE_PRICE_MIN_CNY = 1_900;
export const CANDIDATE_PRICE_MAX_CNY = 4_000;

export function isCandidatePriceCny(priceCny: number): boolean {
  return (
    priceCny >= CANDIDATE_PRICE_MIN_CNY &&
    priceCny <= CANDIDATE_PRICE_MAX_CNY
  );
}

export function requiresCandidateDetail(
  priceCny: number | null
): boolean {
  return priceCny === null || isCandidatePriceCny(priceCny);
}
