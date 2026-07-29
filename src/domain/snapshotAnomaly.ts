export interface SnapshotVolume {
  itemCount: number;
  pagesScanned: number;
}

export type SnapshotAnomalyReason =
  | "items_drop"
  | "pages_drop"
  | "items_and_pages_drop";

export interface SnapshotAnomalyGuard {
  baseline: SnapshotVolume;
  observed: SnapshotVolume;
  confirmationCount: number;
  firstDetectedAt: string;
  lastDetectedAt: string;
  reason: SnapshotAnomalyReason;
}

export type SnapshotAnomalyDecision =
  | {
      kind: "accept";
      reason: "normal" | "recovered" | "confirmed";
      nextGuard: null;
    }
  | {
      kind: "quarantine";
      reason: "suspect";
      nextGuard: SnapshotAnomalyGuard;
    }
  | {
      kind: "not_applicable";
      reason: "incomplete";
      nextGuard: SnapshotAnomalyGuard | null;
    };

export interface SnapshotAnomalyInput {
  complete: boolean;
  baseline: SnapshotVolume;
  current: SnapshotVolume;
  pending: SnapshotAnomalyGuard | null;
  observedAt: string;
}

function dropReason(
  baseline: SnapshotVolume,
  current: SnapshotVolume
): SnapshotAnomalyReason | null {
  const itemDrop =
    baseline.itemCount - current.itemCount >= 10 &&
    current.itemCount < baseline.itemCount * 0.5;
  const pageDrop =
    baseline.pagesScanned - current.pagesScanned >= 2 &&
    current.pagesScanned < baseline.pagesScanned * 0.5;

  if (itemDrop && pageDrop) return "items_and_pages_drop";
  if (itemDrop) return "items_drop";
  if (pageDrop) return "pages_drop";
  return null;
}

function isNear(left: number, right: number, minimum: number): boolean {
  return Math.abs(left - right) <= Math.max(minimum, right * 0.2);
}

function isSameLowRange(
  current: SnapshotVolume,
  previous: SnapshotVolume
): boolean {
  return (
    isNear(current.itemCount, previous.itemCount, 3) &&
    isNear(current.pagesScanned, previous.pagesScanned, 1)
  );
}

export function evaluateSnapshotAnomaly(
  input: SnapshotAnomalyInput
): SnapshotAnomalyDecision {
  if (!input.complete) {
    return {
      kind: "not_applicable",
      reason: "incomplete",
      nextGuard: input.pending
    };
  }

  const effectiveBaseline = input.pending?.baseline ?? input.baseline;
  const reason = dropReason(effectiveBaseline, input.current);
  if (reason === null) {
    return {
      kind: "accept",
      reason: input.pending ? "recovered" : "normal",
      nextGuard: null
    };
  }

  if (
    input.pending &&
    isSameLowRange(input.current, input.pending.observed)
  ) {
    return {
      kind: "accept",
      reason: "confirmed",
      nextGuard: null
    };
  }

  return {
    kind: "quarantine",
    reason: "suspect",
    nextGuard: {
      baseline: effectiveBaseline,
      observed: input.current,
      confirmationCount: 1,
      firstDetectedAt:
        input.pending?.firstDetectedAt &&
        isSameLowRange(input.current, input.pending.observed)
          ? input.pending.firstDetectedAt
          : input.observedAt,
      lastDetectedAt: input.observedAt,
      reason
    }
  };
}
