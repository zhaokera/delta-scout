import {
  selectGlobalCandidatePool
} from "../domain/candidatePool.js";
import type { Listing, SourceId } from "../domain/listing.js";
import { assetRecoveryRate } from "../domain/score.js";

export type RefreshEventType =
  | "new_top10"
  | "price_drop"
  | "asset_recovery_up"
  | "valuable_m7"
  | "removed"
  | "safety_changed";

export type RefreshEventSeverity =
  | "info"
  | "opportunity"
  | "warning";

export interface DetectedRefreshEvent {
  runId: number;
  source: SourceId | null;
  listingKey: string | null;
  type: RefreshEventType;
  severity: RefreshEventSeverity;
  title: string;
  message: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface StoredRefreshEvent extends DetectedRefreshEvent {
  id: number;
  acknowledged: boolean;
}

const SOURCE_LABELS: Record<SourceId, string> = {
  jiaoyimao: "交易猫",
  panzhi: "盼之",
  pxb7: "螃蟹"
};

function price(value: number | null): string {
  return value === null
    ? "价格待核验"
    : `¥${value.toLocaleString("zh-CN", {
        maximumFractionDigits: 2
      })}`;
}

function safetyFingerprint(listing: Listing): string {
  return JSON.stringify({
    secondRealNameAvailable: listing.secondRealNameAvailable,
    recoveryCoverage: listing.recoveryCoverage,
    banNotes: [...listing.banNotes].sort()
  });
}

function rareFinishFingerprint(listing: Listing): string {
  return [...listing.m7RareFinishes].sort().join("|");
}

function pushEvent(
  target: DetectedRefreshEvent[],
  event: Omit<DetectedRefreshEvent, "runId" | "createdAt">,
  runId: number,
  createdAt: string
): void {
  target.push({ ...event, runId, createdAt });
}

export function detectRefreshEvents({
  runId,
  before,
  after,
  refreshedSources,
  removalSources = refreshedSources,
  createdAt
}: {
  runId: number;
  before: Listing[];
  after: Listing[];
  refreshedSources: ReadonlySet<SourceId>;
  removalSources?: ReadonlySet<SourceId>;
  createdAt: Date;
}): DetectedRefreshEvent[] {
  if (before.length === 0 || refreshedSources.size === 0) return [];

  const at = createdAt.toISOString();
  const events: DetectedRefreshEvent[] = [];
  const beforeByKey = new Map(before.map((listing) => [listing.key, listing]));
  const afterByKey = new Map(after.map((listing) => [listing.key, listing]));

  const oldTop10 = new Set(
    selectGlobalCandidatePool(before).slice(0, 10).map(({ key }) => key)
  );
  selectGlobalCandidatePool(after)
    .slice(0, 10)
    .forEach((listing, index) => {
      if (oldTop10.has(listing.key)) return;
      pushEvent(events, {
        source: listing.source,
        listingKey: listing.key,
        type: "new_top10",
        severity: "opportunity",
        title: `新进入全局 Top ${index + 1}`,
        message:
          `${SOURCE_LABELS[listing.source]} ${listing.sourceListingId ?? listing.key}` +
          ` 以 ${price(listing.priceCny)} 进入全局前十`,
        details: {
          rank: index + 1,
          priceCny: listing.priceCny,
          score: listing.score?.exactTotal ?? listing.score?.total ?? null
        }
      }, runId, at);
    });

  for (const listing of after) {
    if (!refreshedSources.has(listing.source)) continue;
    const previous = beforeByKey.get(listing.key);
    if (!previous) continue;

    if (
      previous.priceCny !== null &&
      listing.priceCny !== null &&
      previous.priceCny - listing.priceCny >= 100
    ) {
      pushEvent(events, {
        source: listing.source,
        listingKey: listing.key,
        type: "price_drop",
        severity: "opportunity",
        title: `降价 ¥${Math.round(previous.priceCny - listing.priceCny)}`,
        message:
          `${SOURCE_LABELS[listing.source]} ${listing.sourceListingId ?? listing.key}` +
          ` 从 ${price(previous.priceCny)} 降至 ${price(listing.priceCny)}`,
        details: {
          beforePriceCny: previous.priceCny,
          afterPriceCny: listing.priceCny
        }
      }, runId, at);
    }

    const previousRecovery = assetRecoveryRate(previous);
    const currentRecovery = assetRecoveryRate(listing);
    if (
      previousRecovery !== null &&
      currentRecovery !== null &&
      currentRecovery - previousRecovery >= 0.1
    ) {
      pushEvent(events, {
        source: listing.source,
        listingKey: listing.key,
        type: "asset_recovery_up",
        severity: "opportunity",
        title: "资产回收率明显提升",
        message:
          `${SOURCE_LABELS[listing.source]} ${listing.sourceListingId ?? listing.key}` +
          ` 的资产回收率由 ${Math.round(previousRecovery * 100)}%` +
          ` 提升至 ${Math.round(currentRecovery * 100)}%`,
        details: {
          beforeRate: previousRecovery,
          afterRate: currentRecovery
        }
      }, runId, at);
    }

    const previousRare = rareFinishFingerprint(previous);
    const currentRare = rareFinishFingerprint(listing);
    if (currentRare.length > 0 && currentRare !== previousRare) {
      pushEvent(events, {
        source: listing.source,
        listingKey: listing.key,
        type: "valuable_m7",
        severity: "opportunity",
        title: "发现高价值 M7 材质",
        message:
          `${SOURCE_LABELS[listing.source]} ${listing.sourceListingId ?? listing.key}` +
          ` 出现 ${listing.m7RareFinishes.join("、")}`,
        details: {
          before: previous.m7RareFinishes,
          after: listing.m7RareFinishes
        }
      }, runId, at);
    }

    if (safetyFingerprint(previous) !== safetyFingerprint(listing)) {
      pushEvent(events, {
        source: listing.source,
        listingKey: listing.key,
        type: "safety_changed",
        severity: "warning",
        title: "安全信息发生变化",
        message:
          `${SOURCE_LABELS[listing.source]} ${listing.sourceListingId ?? listing.key}` +
          " 的实名、包赔或封禁信息发生变化，需要重新验号",
        details: {
          before: JSON.parse(safetyFingerprint(previous)),
          after: JSON.parse(safetyFingerprint(listing))
        }
      }, runId, at);
    }
  }

  for (const previous of before) {
    if (
      !removalSources.has(previous.source) ||
      afterByKey.has(previous.key)
    ) {
      continue;
    }
    pushEvent(events, {
      source: previous.source,
      listingKey: previous.key,
      type: "removed",
      severity: "warning",
      title: "候选已不在最新快照",
      message:
        `${SOURCE_LABELS[previous.source]} ${previous.sourceListingId ?? previous.key}` +
        " 可能已下架或不再满足平台筛选条件",
      details: { previousPriceCny: previous.priceCny }
    }, runId, at);
  }

  return events;
}
