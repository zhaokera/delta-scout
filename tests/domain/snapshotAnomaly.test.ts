import {
  evaluateSnapshotAnomaly,
  type SnapshotAnomalyGuard
} from "../../src/domain/snapshotAnomaly";

const baseline = {
  itemCount: 44,
  pagesScanned: 5
};

function pending(
  itemCount = 10,
  pagesScanned = 1
): SnapshotAnomalyGuard {
  return {
    baseline,
    observed: { itemCount, pagesScanned },
    confirmationCount: 1,
    firstDetectedAt: "2026-07-29T10:00:00.000Z",
    lastDetectedAt: "2026-07-29T10:00:00.000Z",
    reason: "items_and_pages_drop"
  };
}

describe("evaluateSnapshotAnomaly", () => {
  it("accepts normal variation without creating a guard", () => {
    expect(
      evaluateSnapshotAnomaly({
        complete: true,
        baseline,
        current: { itemCount: 30, pagesScanned: 4 },
        pending: null,
        observedAt: "2026-07-29T11:00:00.000Z"
      })
    ).toEqual({
      kind: "accept",
      reason: "normal",
      nextGuard: null
    });
  });

  it("requires a strict ratio drop and the absolute item threshold", () => {
    expect(
      evaluateSnapshotAnomaly({
        complete: true,
        baseline: { itemCount: 20, pagesScanned: 1 },
        current: { itemCount: 10, pagesScanned: 1 },
        pending: null,
        observedAt: "2026-07-29T11:00:00.000Z"
      }).kind
    ).toBe("accept");
    expect(
      evaluateSnapshotAnomaly({
        complete: true,
        baseline: { itemCount: 18, pagesScanned: 1 },
        current: { itemCount: 8, pagesScanned: 1 },
        pending: null,
        observedAt: "2026-07-29T11:00:00.000Z"
      }).kind
    ).toBe("quarantine");
  });

  it("quarantines a first large drop and starts confirmation at one", () => {
    expect(
      evaluateSnapshotAnomaly({
        complete: true,
        baseline,
        current: { itemCount: 10, pagesScanned: 1 },
        pending: null,
        observedAt: "2026-07-29T11:00:00.000Z"
      })
    ).toEqual({
      kind: "quarantine",
      reason: "suspect",
      nextGuard: {
        baseline,
        observed: { itemCount: 10, pagesScanned: 1 },
        confirmationCount: 1,
        firstDetectedAt: "2026-07-29T11:00:00.000Z",
        lastDetectedAt: "2026-07-29T11:00:00.000Z",
        reason: "items_and_pages_drop"
      }
    });
  });

  it("accepts a second complete scan in the same low range", () => {
    expect(
      evaluateSnapshotAnomaly({
        complete: true,
        baseline,
        current: { itemCount: 11, pagesScanned: 1 },
        pending: pending(),
        observedAt: "2026-07-29T12:00:00.000Z"
      })
    ).toEqual({
      kind: "accept",
      reason: "confirmed",
      nextGuard: null
    });
  });

  it("clears a pending guard when volume recovers", () => {
    expect(
      evaluateSnapshotAnomaly({
        complete: true,
        baseline,
        current: { itemCount: 43, pagesScanned: 5 },
        pending: pending(),
        observedAt: "2026-07-29T12:00:00.000Z"
      })
    ).toEqual({
      kind: "accept",
      reason: "recovered",
      nextGuard: null
    });
  });

  it("restarts confirmation for a materially different low range", () => {
    expect(
      evaluateSnapshotAnomaly({
        complete: true,
        baseline,
        current: { itemCount: 2, pagesScanned: 1 },
        pending: pending(15, 2),
        observedAt: "2026-07-29T12:00:00.000Z"
      })
    ).toEqual({
      kind: "quarantine",
      reason: "suspect",
      nextGuard: {
        baseline,
        observed: { itemCount: 2, pagesScanned: 1 },
        confirmationCount: 1,
        firstDetectedAt: "2026-07-29T12:00:00.000Z",
        lastDetectedAt: "2026-07-29T12:00:00.000Z",
        reason: "items_and_pages_drop"
      }
    });
  });

  it("does not advance or clear a guard for an incomplete scan", () => {
    const guard = pending();
    expect(
      evaluateSnapshotAnomaly({
        complete: false,
        baseline,
        current: { itemCount: 1, pagesScanned: 1 },
        pending: guard,
        observedAt: "2026-07-29T12:00:00.000Z"
      })
    ).toEqual({
      kind: "not_applicable",
      reason: "incomplete",
      nextGuard: guard
    });
  });

  it("can trigger on a large page drop even when item count is stable", () => {
    expect(
      evaluateSnapshotAnomaly({
        complete: true,
        baseline: { itemCount: 40, pagesScanned: 8 },
        current: { itemCount: 35, pagesScanned: 3 },
        pending: null,
        observedAt: "2026-07-29T12:00:00.000Z"
      }).kind
    ).toBe("quarantine");
  });
});
