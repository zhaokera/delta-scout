import {
  BROWSER_REFRESH_LIMITS,
  JiaoyimaoFilterUrlSchema,
  type BrowserFilterProof,
  type BrowserListItem,
  type BrowserLoadEvent
} from "./contracts.js";

export type FilterProofResult =
  | { kind: "ok" }
  | { kind: "invalid"; reason: "filter_mismatch" };

export type NaturalEndReason =
  | "no_events"
  | "sequence_gap"
  | "unique_count_decreased"
  | "new_item_count_inconsistent"
  | "inconsistent_total"
  | "loading_visible"
  | "login"
  | "captcha"
  | "rate_limited"
  | "error"
  | "not_at_end"
  | "safety_limit";

export type NaturalEndResult =
  | {
      kind: "complete";
      reason: "explicit_total" | "explicit_end" | "no_growth_twice";
    }
  | { kind: "incomplete"; reason: NaturalEndReason };

export type PublishReadiness =
  | { kind: "ready" }
  | {
      kind: "not_ready";
      reason:
        | "filter_mismatch"
        | "list_incomplete"
        | "details_incomplete"
        | "safety_limit";
      missingDetailIds?: string[];
      naturalEndReason?: NaturalEndReason;
    };

function normalized(value: string): string {
  return value.replace(/\s+/gu, "").toUpperCase();
}

export function validateFilterProof(
  proof: BrowserFilterProof
): FilterProofResult {
  const gradeLabels = proof.m7FilterLabels.map(normalized);
  const valid =
    JiaoyimaoFilterUrlSchema.safeParse(proof.currentUrl).success &&
    normalized(proof.gameLabel) === normalized("三角洲行动") &&
    normalized(proof.platformLabel) === "QQ" &&
    normalized(proof.categoryLabel) === normalized("账号") &&
    ["极品S", "极品A", "极品B", "极品C"].every((grade) =>
      gradeLabels.some((label) =>
        label.includes("M7") &&
        label.includes(normalized("棱镜攻势")) &&
        label.includes(normalized(grade))
      )
    );
  return valid
    ? { kind: "ok" }
    : { kind: "invalid", reason: "filter_mismatch" };
}

export function evaluateNaturalEnd(
  events: readonly BrowserLoadEvent[]
): NaturalEndResult {
  if (events.length === 0) {
    return { kind: "incomplete", reason: "no_events" };
  }
  if (events.length >= BROWSER_REFRESH_LIMITS.maxLoadEvents) {
    return { kind: "incomplete", reason: "safety_limit" };
  }

  let previousCount = 0;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (
      event.sequence > BROWSER_REFRESH_LIMITS.maxLoadEvents ||
      event.observedUniqueCount < 0 ||
      event.observedUniqueCount >= BROWSER_REFRESH_LIMITS.maxUniqueItems ||
      event.newItemCount < 0 ||
      event.newItemCount >= BROWSER_REFRESH_LIMITS.maxUniqueItems ||
      (
        event.visibleTotalCount !== null &&
        (
          event.visibleTotalCount < 0 ||
          event.visibleTotalCount >=
            BROWSER_REFRESH_LIMITS.maxUniqueItems
        )
      )
    ) {
      return { kind: "incomplete", reason: "safety_limit" };
    }
    if (event.sequence !== index + 1) {
      return { kind: "incomplete", reason: "sequence_gap" };
    }
    if (event.observedUniqueCount < previousCount) {
      return {
        kind: "incomplete",
        reason: "unique_count_decreased"
      };
    }
    if (event.newItemCount !== event.observedUniqueCount - previousCount) {
      return {
        kind: "incomplete",
        reason: "new_item_count_inconsistent"
      };
    }
    if (
      event.visibleTotalCount !== null &&
      event.visibleTotalCount < event.observedUniqueCount
    ) {
      return { kind: "incomplete", reason: "inconsistent_total" };
    }
    previousCount = event.observedUniqueCount;
  }

  const last = events.at(-1)!;
  if (last.loadingVisible) {
    return { kind: "incomplete", reason: "loading_visible" };
  }
  if (last.blockingState !== "none") {
    return { kind: "incomplete", reason: last.blockingState };
  }
  if (
    last.visibleTotalCount !== null &&
    last.visibleTotalCount !== last.observedUniqueCount
  ) {
    return { kind: "incomplete", reason: "inconsistent_total" };
  }
  if (
    last.visibleTotalCount !== null &&
    last.visibleTotalCount === last.observedUniqueCount
  ) {
    return { kind: "complete", reason: "explicit_total" };
  }
  let latestVisibleTotal: number | null = null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].visibleTotalCount !== null) {
      latestVisibleTotal = events[index].visibleTotalCount;
      break;
    }
  }
  if (
    latestVisibleTotal !== null &&
    latestVisibleTotal !== last.observedUniqueCount
  ) {
    return { kind: "incomplete", reason: "inconsistent_total" };
  }
  if (last.endMarkerVisible) {
    return { kind: "complete", reason: "explicit_end" };
  }

  const previous = events.at(-2);
  if (
    previous &&
    previous.sequence + 1 === last.sequence &&
    previous.newItemCount === 0 &&
    last.newItemCount === 0 &&
    previous.observedUniqueCount === last.observedUniqueCount &&
    !previous.loadingVisible &&
    previous.blockingState === "none"
  ) {
    return { kind: "complete", reason: "no_growth_twice" };
  }
  return { kind: "incomplete", reason: "not_at_end" };
}

export function detailRequiredIds(
  items: readonly BrowserListItem[]
): string[] {
  return items
    .filter((item) => item.priceCny === null || item.priceCny <= 6_000)
    .map((item) => item.sourceListingId);
}

export function evaluatePublishReadiness(
  proof: BrowserFilterProof | null,
  events: readonly BrowserLoadEvent[],
  items: readonly BrowserListItem[],
  completedDetailIds: ReadonlySet<string>
): PublishReadiness {
  if (proof === null || validateFilterProof(proof).kind !== "ok") {
    return { kind: "not_ready", reason: "filter_mismatch" };
  }
  const naturalEnd = evaluateNaturalEnd(events);
  if (naturalEnd.kind === "incomplete") {
    return naturalEnd.reason === "safety_limit"
      ? { kind: "not_ready", reason: "safety_limit" }
      : {
          kind: "not_ready",
          reason: "list_incomplete",
          naturalEndReason: naturalEnd.reason
        };
  }
  const finalObservedCount = events.at(-1)?.observedUniqueCount ?? 0;
  if (new Set(items.map((item) => item.sourceListingId)).size !== finalObservedCount) {
    return {
      kind: "not_ready",
      reason: "list_incomplete",
      naturalEndReason: "not_at_end"
    };
  }
  const missingDetailIds = detailRequiredIds(items).filter(
    (id) => !completedDetailIds.has(id)
  );
  return missingDetailIds.length === 0
    ? { kind: "ready" }
    : {
        kind: "not_ready",
        reason: "details_incomplete",
        missingDetailIds
      };
}
