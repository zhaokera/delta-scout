import {
  buildPanzhiBrowserListings,
  mergePanzhiQuickListings,
  PanzhiBrowserSnapshotSchema
} from "../panzhiBrowserSnapshot.js";
import {
  type CommitScanRefreshContext,
  ListingRepository,
  type SynchronousCallGuard,
  SynchronousTransactionError
} from "../repository.js";

export type PanzhiSnapshotPublishState =
  | "success"
  | "partial"
  | "quarantined";

export interface PanzhiSnapshotPublishResult {
  source: "panzhi";
  mode: "quick" | "deep";
  state: PanzhiSnapshotPublishState;
  scanRunId: number;
  observedItemCount: number;
  publishedItemCount: number;
  preservedItemCount: number;
  droppedByPrice: number;
  published: boolean;
}

export type PanzhiSnapshotPublisherErrorCode =
  "panzhi_complete_snapshot_required";

export class PanzhiSnapshotPublisherError extends Error {
  constructor(
    readonly code: PanzhiSnapshotPublisherErrorCode,
    message: string
  ) {
    super(message);
    this.name = "PanzhiSnapshotPublisherError";
  }
}

export type PanzhiSnapshotBeforeCommit<Result = void> = (
  result: PanzhiSnapshotPublishResult
) => Result;

function isNativeAsyncFunction(operation: unknown): boolean {
  if (typeof operation !== "function") return false;
  return (
    operation.constructor?.name === "AsyncFunction" ||
    Object.prototype.toString.call(operation) === "[object AsyncFunction]"
  );
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" && value !== null) ||
    typeof value === "function"
  ) && typeof (value as { then?: unknown }).then === "function";
}

export class PanzhiSnapshotPublisher {
  constructor(private readonly repository: ListingRepository) {}

  publish<HookResult = void>(
    input: unknown,
    capturedAt: Date,
    beforeCommit?: PanzhiSnapshotBeforeCommit<HookResult>,
    ..._synchronousOnly: SynchronousCallGuard<HookResult>
  ): PanzhiSnapshotPublishResult {
    // Completion hooks may only perform synchronous writes against the same
    // SQLite connection. Network calls and messages cannot be rolled back.
    if (beforeCommit && isNativeAsyncFunction(beforeCommit)) {
      throw new SynchronousTransactionError("before_commit");
    }
    const snapshot = PanzhiBrowserSnapshotSchema.parse(input);
    const built = buildPanzhiBrowserListings(snapshot, capturedAt);
    const mode = snapshot.mode ?? "deep";

    return this.repository.runInTransaction(() => {
      const previousPanzhi = mode === "quick"
        ? this.repository.getListings().filter(
            ({ source }) => source === "panzhi"
          )
        : [];
      const hasCompleteBaseline = mode === "quick"
        ? this.repository.hasCompletePublishedSourceSnapshot("panzhi")
        : false;
      if (mode === "quick" && !hasCompleteBaseline) {
        throw new PanzhiSnapshotPublisherError(
          "panzhi_complete_snapshot_required",
          "首次使用盼之时需要先完成一次完整快照"
        );
      }

      const observedSourceListingIds = snapshot.items.map(
        ({ sourceListingId }) => sourceListingId
      );
      const observedIdSet = new Set(observedSourceListingIds);
      const listings = mode === "quick"
        ? mergePanzhiQuickListings(
            previousPanzhi,
            built.listings,
            observedSourceListingIds
          )
        : built.listings;
      const preservedItemCount = mode === "quick"
        ? previousPanzhi.filter(({ sourceListingId }) =>
            sourceListingId === null || !observedIdSet.has(sourceListingId)
          ).length
        : 0;
      const previousPages = this.repository.getSourceStatuses().find(
        ({ source }) => source === "panzhi"
      )?.pagesScanned ?? 0;
      const coveragePages = mode === "quick"
        ? Math.max(previousPages, snapshot.loadActionCount)
        : snapshot.loadActionCount;
      const sourceState = snapshot.stopReason === "captcha_required"
        ? "partial" as const
        : "success" as const;
      const runId = this.repository.startScopedScan("panzhi", capturedAt);
      let result: PanzhiSnapshotPublishResult | undefined;

      this.repository.commitScanRefresh(
        runId,
        listings,
        [
          {
            source: "panzhi",
            state: sourceState,
            attemptedAt: capturedAt,
            itemCount: listings.length,
            metadata: {
              pagesScanned: coveragePages,
              stopReason: snapshot.stopReason,
              error: sourceState === "partial"
                ? "captcha_required"
                : null,
              observedItemCount: snapshot.items.length,
              coverage: mode === "quick" ? "incremental" : "full",
              observedListingKeys: built.listings.map(({ key }) => key)
            }
          }
        ],
        capturedAt,
        (context: CommitScanRefreshContext) => {
          const published = context.publishedSources.includes("panzhi");
          result = {
            source: "panzhi",
            mode,
            state: published ? sourceState : "quarantined",
            scanRunId: context.runId,
            observedItemCount: snapshot.items.length,
            publishedItemCount: published ? listings.length : 0,
            preservedItemCount: published ? preservedItemCount : 0,
            droppedByPrice: built.droppedByPrice,
            published
          };
          const hookResult = beforeCommit?.(result);
          if (isThenable(hookResult)) {
            throw new SynchronousTransactionError("before_commit");
          }
        }
      );

      if (result === undefined) {
        throw new Error("盼之浏览器快照发布未生成结果");
      }
      return result;
    });
  }
}
