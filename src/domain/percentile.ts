export function buildMidrankPercentiles(
  values: Array<number | null>
): Map<number, number> {
  const sorted = values
    .filter(
      (value): value is number =>
        value !== null && Number.isFinite(value)
    )
    .sort((left, right) => left - right);

  if (sorted.length === 0) {
    return new Map();
  }
  if (sorted.length === 1) {
    return new Map([[sorted[0], 0.5]]);
  }

  const percentiles = new Map<number, number>();
  for (let start = 0; start < sorted.length; ) {
    let end = start;
    while (
      end + 1 < sorted.length &&
      sorted[end + 1] === sorted[start]
    ) {
      end += 1;
    }
    percentiles.set(
      sorted[start],
      (start + end) / 2 / (sorted.length - 1)
    );
    start = end + 1;
  }
  return percentiles;
}
