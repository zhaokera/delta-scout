import { markPossibleDuplicates } from "../../domain/duplicates.js";
import type {
  Listing,
  SourceId
} from "../../domain/listing.js";
import { scoreEligibleListings } from "../../domain/score.js";
import { normalizeListingUrl } from "../../domain/url.js";
import type {
  ListingRepository,
  ScanState,
  SourceState,
  SourceRefreshStatusUpdate
} from "../repository.js";
import type {
  ListingSummary,
  PageFetcher,
  SourceAdapter,
  SourceRequest
} from "./types.js";
import {
  buildListing,
  shouldFetchListingDetail,
  type CollectedListingInput
} from "./buildListing.js";
import {
  canReuseListingDetail,
  listingDetailFromListing
} from "./detailReuse.js";

export type RefreshMode = "quick" | "deep";

interface CollectionLimits {
  maxPages: number;
  maxSummaries: number;
  maxDetails: number;
}

const DEFAULT_LIMITS: CollectionLimits = {
  maxPages: 100,
  maxSummaries: 2_000,
  // A broad catalog can require one detail check per summary to prove the
  // QQ/official eligibility fields. Keep both caps aligned so the detail
  // guard cannot truncate an otherwise valid full-catalog scan.
  maxDetails: 2_000
};
const MIN_SUCCESSFUL_DETAILS_FOR_PARTIAL_CIRCUIT = 20;

interface CoordinatorOptions {
  adapters: SourceAdapter[];
  fetcher: PageFetcher;
  repository: ListingRepository;
  now?: () => Date;
  limits?: Partial<CollectionLimits>;
  limitsBySource?: Partial<
    Record<SourceId, Partial<CollectionLimits>>
  >;
}

type CollectedSummary = CollectedListingInput;

export type RefreshProgressEvent =
  | {
      type: "source_start";
      phase: "discover";
      source: SourceId;
      page: 0;
      summaries: 0;
      details: 0;
      message: string;
    }
  | {
      type: "list_page";
      phase: "list";
      source: SourceId;
      page: number;
      summaries: number;
      details: number;
      message: string;
    }
  | {
      type: "detail_progress";
      phase: "detail";
      source: SourceId;
      page: number;
      summaries: number;
      details: number;
      message: string;
    }
  | {
      type: "source_complete";
      phase: "list";
      source: SourceId;
      page: number;
      summaries: number;
      details: number;
      sourceState: Exclude<SourceState, "idle">;
      message: string;
    }
  | {
      type: "score" | "commit";
      phase: "score" | "commit";
      source: null;
      page: number;
      summaries: number;
      details: number;
      message: string;
    }
  | {
      type: "complete";
      phase: null;
      source: null;
      page: number;
      summaries: number;
      details: number;
      roundState: ScanState;
      message: string;
    };

type ProgressListener = (event: RefreshProgressEvent) => void;

type RefreshSourceResult =
  | {
      kind: "fresh";
      source: SourceId;
      listings: Listing[];
      statusUpdate: SourceRefreshStatusUpdate;
    }
  | {
      kind: "failed";
      source: SourceId;
      statusUpdate: SourceRefreshStatusUpdate;
    };

type StopReason =
  | "end_of_pages"
  | "no_new_items"
  | "pagination_stalled"
  | "repeated_request"
  | "safety_limit"
  | "error";

function positiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} 必须是正整数`);
  }
  return value;
}

function canonicalRequestUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    url.searchParams.sort();
    return url.toString();
  } catch {
    return value;
  }
}

function requestFingerprint(request: SourceRequest): string {
  return [
    request.options?.method ?? "GET",
    canonicalRequestUrl(request.url),
    request.options?.body ?? ""
  ].join("\n");
}

function listingAliases(summary: ListingSummary): string[] {
  let canonicalUrl = summary.url;
  try {
    canonicalUrl = normalizeListingUrl(summary.url);
  } catch {
    // A stable exact URL still prevents accidental empty-ID collisions.
  }
  return [
    `${summary.source}\nurl\n${canonicalUrl}`,
    ...(summary.sourceListingId === null
      ? []
      : [`${summary.source}\nid\n${summary.sourceListingId}`])
  ];
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : fallback;
}

export class CollectionCoordinator {
  private readonly adapters: SourceAdapter[];
  private readonly fetcher: PageFetcher;
  private readonly repository: ListingRepository;
  private readonly now: () => Date;
  private readonly limits: CollectionLimits;
  private readonly limitsBySource = new Map<
    SourceId,
    CollectionLimits
  >();
  private refreshInProgress = false;

  constructor(options: CoordinatorOptions) {
    this.adapters = options.adapters;
    this.fetcher = options.fetcher;
    this.repository = options.repository;
    this.now = options.now ?? (() => new Date());
    const limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.limits = {
      maxPages: positiveLimit(limits.maxPages, "maxPages"),
      maxSummaries: positiveLimit(limits.maxSummaries, "maxSummaries"),
      maxDetails: positiveLimit(limits.maxDetails, "maxDetails")
    };
    for (const [source, overrides] of Object.entries(
      options.limitsBySource ?? {}
    ) as Array<[SourceId, Partial<CollectionLimits>]>) {
      const sourceLimits = { ...this.limits, ...overrides };
      this.limitsBySource.set(source, {
        maxPages: positiveLimit(
          sourceLimits.maxPages,
          `${source}.maxPages`
        ),
        maxSummaries: positiveLimit(
          sourceLimits.maxSummaries,
          `${source}.maxSummaries`
        ),
        maxDetails: positiveLimit(
          sourceLimits.maxDetails,
          `${source}.maxDetails`
        )
      });
    }
  }

  private failedSource(
    source: SourceId,
    result: Exclude<
      Awaited<ReturnType<PageFetcher["fetchPage"]>>,
      { kind: "ok" }
    >
  ): RefreshSourceResult {
    return {
      kind: "failed",
      source,
      statusUpdate: {
        source,
        state: result.kind === "blocked" ? "blocked" : "failed",
        attemptedAt: this.now(),
        error: result.kind === "blocked" ? result.reason : result.error
      }
    };
  }

  private failedSourceFromError(
    source: SourceId,
    error: unknown,
    fallback: string
  ): RefreshSourceResult {
    return {
      kind: "failed",
      source,
      statusUpdate: {
        source,
        state: "failed",
        attemptedAt: this.now(),
        error: errorMessage(error, fallback)
      }
    };
  }

  private async collectSource(
    adapter: SourceAdapter,
    refreshStartedAt: Date,
    mode: RefreshMode,
    previousById: ReadonlyMap<string, Listing>,
    onProgress?: ProgressListener
  ): Promise<RefreshSourceResult> {
    if (adapter.requiresBrowserSnapshot) {
      return {
        kind: "failed",
        source: adapter.source,
        statusUpdate: {
          source: adapter.source,
          state: "blocked",
          attemptedAt: this.now(),
          error: "browser_snapshot_required"
        }
      };
    }
    const limits =
      this.limitsBySource.get(adapter.source) ?? this.limits;
    const entry = await this.fetcher.fetchPage(
      { url: adapter.entryUrl },
      adapter.source
    );
    if (entry.kind !== "ok") {
      return this.failedSource(adapter.source, entry);
    }

    const discovery = adapter.discoverCatalog(entry.html, "三角洲行动");
    if (discovery.kind === "blocked") {
      return {
        kind: "failed",
        source: adapter.source,
        statusUpdate: {
          source: adapter.source,
          state: "blocked",
          attemptedAt: this.now(),
          error: discovery.reason
        }
      };
    }

    const collected: CollectedSummary[] = [];
    const seenAliases = new Set<string>();
    const seenRequests = new Set<string>();
    let listRequest: SourceRequest | null = discovery.request;
    let pages = 0;
    let detailCount = 0;
    let successfulDetailCount = 0;
    let consecutivePagesWithoutNewItems = 0;
    let consecutiveDetailFailures = 0;
    let consecutiveDetailFailureState: "blocked" | "failed" = "blocked";
    let detailCircuitOpen = false;
    let partial = false;
    let stopReason: StopReason | null = null;
    let sourceError: string | null = null;
    const recordDetailFailure = (
      state: "blocked" | "failed",
      error: string
    ): RefreshSourceResult | null => {
      partial = true;
      sourceError = error;
      consecutiveDetailFailures += 1;
      if (state === "failed") {
        consecutiveDetailFailureState = "failed";
      }
      if (consecutiveDetailFailures < 3) return null;
      if (
        successfulDetailCount >=
        MIN_SUCCESSFUL_DETAILS_FOR_PARTIAL_CIRCUIT
      ) {
        detailCircuitOpen = true;
        return null;
      }
      return {
        kind: "failed",
        source: adapter.source,
        statusUpdate: {
          source: adapter.source,
          state: consecutiveDetailFailureState,
          attemptedAt: this.now(),
          error
        }
      };
    };

    while (listRequest) {
      const currentRequest = listRequest;
      const fingerprint = requestFingerprint(currentRequest);
      if (seenRequests.has(fingerprint)) {
        stopReason = "repeated_request";
        break;
      }
      seenRequests.add(fingerprint);

      let page: Awaited<ReturnType<PageFetcher["fetchPage"]>>;
      try {
        page = await this.fetcher.fetchPage(
          currentRequest,
          adapter.source
        );
      } catch (error) {
        page = {
          kind: "failed",
          url: currentRequest.url,
          error: errorMessage(error, "list_fetch_failed")
        };
      }
      if (page.kind !== "ok") {
        if (pages === 0) {
          return this.failedSource(adapter.source, page);
        }
        partial = true;
        stopReason = "error";
        sourceError =
          page.kind === "blocked" ? page.reason : page.error;
        break;
      }

      let parsed: ReturnType<SourceAdapter["parseList"]>;
      try {
        parsed = adapter.parseList(page.html);
      } catch (error) {
        const reason = errorMessage(error, "list_parse_failed");
        if (pages === 0) {
          return this.failedSourceFromError(
            adapter.source,
            error,
            "list_parse_failed"
          );
        }
        partial = true;
        stopReason = "error";
        sourceError = reason;
        break;
      }
      if (parsed.kind === "blocked") {
        if (pages === 0) {
          return {
            kind: "failed",
            source: adapter.source,
            statusUpdate: {
              source: adapter.source,
              state: "blocked",
              attemptedAt: this.now(),
              error: parsed.reason
            }
          };
        }
        partial = true;
        stopReason = "error";
        sourceError = parsed.reason;
        break;
      }

      pages += 1;
      const seenCountBeforePage = seenAliases.size;
      let newItemCount = 0;
      let summaryLimitReached = false;
      let detailLimitReached = false;
      const pageRecords: CollectedSummary[] = [];
      for (const item of parsed.items) {
        const aliases = listingAliases(item);
        if (aliases.some((alias) => seenAliases.has(alias))) {
          for (const alias of aliases) {
            seenAliases.add(alias);
          }
          continue;
        }
        if (collected.length >= limits.maxSummaries) {
          summaryLimitReached = true;
          break;
        }
        for (const alias of aliases) {
          seenAliases.add(alias);
        }
        newItemCount += 1;
        const previous = item.sourceListingId === null
          ? undefined
          : previousById.get(item.sourceListingId);
        const reusableDetail =
          mode === "quick" &&
          item.embeddedDetail === undefined &&
          previous &&
          canReuseListingDetail(
            previous,
            item,
            refreshStartedAt
          )
            ? listingDetailFromListing(previous)
            : null;
        const record: CollectedSummary = {
          summary: item,
          detail: item.embeddedDetail ?? reusableDetail,
          detailAttempted:
            item.embeddedDetail !== undefined || reusableDetail !== null,
          warnings: []
        };
        collected.push(record);
        pageRecords.push(record);
      }
      consecutivePagesWithoutNewItems = newItemCount === 0
        ? consecutivePagesWithoutNewItems + 1
        : 0;

      onProgress?.({
        type: "list_page",
        phase: "list",
        source: adapter.source,
        page: pages,
        summaries: collected.length,
        details: detailCount,
        message: `已解析第 ${pages} 页`
      });

      for (const record of pageRecords) {
        const item = record.summary;
        if (
          item.embeddedDetail === undefined &&
          record.detail === null &&
          shouldFetchListingDetail(item)
        ) {
          if (detailCircuitOpen) {
            record.warnings.push(
              "详情连续受阻，本轮停止后续详情请求"
            );
            continue;
          }
          if (detailCount >= limits.maxDetails) {
            detailLimitReached = true;
            record.warnings.push("达到详情采集上限，待人工核验");
            continue;
          }
          detailCount += 1;
          record.detailAttempted = true;
          try {
            let detailPage: Awaited<
              ReturnType<PageFetcher["fetchPage"]>
            >;
            try {
              const detailRequest = adapter.detailRequest(item);
              detailPage = await this.fetcher.fetchPage(
                detailRequest,
                adapter.source
              );
            } catch (error) {
              const reason = errorMessage(error, "detail_fetch_failed");
              record.warnings.push(`详情获取失败：${reason}`);
              const failure = recordDetailFailure("failed", reason);
              if (failure) return failure;
              continue;
            }
            if (detailPage.kind !== "ok") {
              const reason =
                detailPage.kind === "blocked"
                  ? detailPage.reason
                  : detailPage.error;
              record.warnings.push(
                detailPage.kind === "blocked"
                  ? `详情自动采集受阻：${reason}`
                  : `详情获取失败：${reason}`
              );
              const failure = recordDetailFailure(
                detailPage.kind === "blocked" ? "blocked" : "failed",
                reason
              );
              if (failure) return failure;
              continue;
            }
            let detail: ReturnType<SourceAdapter["parseDetail"]>;
            try {
              detail = adapter.parseDetail(detailPage.html, item);
            } catch (error) {
              const reason = errorMessage(error, "detail_parse_failed");
              record.warnings.push(`详情解析失败：${reason}`);
              const failure = recordDetailFailure("failed", reason);
              if (failure) return failure;
              continue;
            }
            if (detail.kind === "blocked") {
              record.warnings.push(`详情解析受阻：${detail.reason}`);
              const failure = recordDetailFailure(
                "blocked",
                detail.reason
              );
              if (failure) return failure;
            } else {
              record.detail = detail.detail;
              successfulDetailCount += 1;
              consecutiveDetailFailures = 0;
              consecutiveDetailFailureState = "blocked";
            }
          } finally {
            onProgress?.({
              type: "detail_progress",
              phase: "detail",
              source: adapter.source,
              page: pages,
              summaries: collected.length,
              details: detailCount,
              message: `已核验 ${detailCount} 条详情`
            });
          }
        }
      }

      if (detailLimitReached) {
        partial = true;
        sourceError ??= "detail_limit_reached";
      }
      if (summaryLimitReached) {
        partial = true;
        stopReason = "safety_limit";
        break;
      }

      let next: SourceRequest | null;
      try {
        next = adapter.nextPage(page.html, currentRequest);
      } catch (error) {
        partial = true;
        stopReason = "error";
        sourceError = errorMessage(error, "next_page_failed");
        break;
      }
      if (
        adapter.strictPaginationProgress &&
        pages > 1 &&
        consecutivePagesWithoutNewItems >=
          (adapter.maxConsecutivePagesWithoutNewItems ?? 1)
      ) {
        if (parsed.items.length > 0 || next !== null) {
          partial = true;
          stopReason = "pagination_stalled";
        } else {
          stopReason = "end_of_pages";
        }
        break;
      }
      if (
        newItemCount === 0 &&
        seenCountBeforePage > 0 &&
        !adapter.allowPagesWithoutNewItems
      ) {
        stopReason = "no_new_items";
        break;
      }
      if (next === null) {
        stopReason = "end_of_pages";
        break;
      }
      if (
        newItemCount === 0 &&
        !adapter.allowPagesWithoutNewItems
      ) {
        stopReason = "no_new_items";
        break;
      }
      if (seenRequests.has(requestFingerprint(next))) {
        stopReason = "repeated_request";
        break;
      }
      if (
        pages >= limits.maxPages ||
        collected.length >= limits.maxSummaries
      ) {
        partial = true;
        stopReason = "safety_limit";
        break;
      }
      listRequest = next;
    }

    const observedCapturedAt = this.now();
    const capturedAt =
      observedCapturedAt.getTime() < refreshStartedAt.getTime()
        ? new Date(refreshStartedAt.getTime())
        : observedCapturedAt;
    const listings = collected.map((record) =>
      buildListing(record, capturedAt)
    );
    return {
      kind: "fresh",
      source: adapter.source,
      listings,
      statusUpdate: {
        source: adapter.source,
        state: partial ? "partial" : "success",
        attemptedAt: capturedAt,
        itemCount: listings.length,
        metadata: {
          pagesScanned: pages,
          stopReason: stopReason ?? "end_of_pages",
          error: sourceError
        }
      }
    };
  }

  async refreshAll(): Promise<void>;
  async refreshAll(
    runId: number,
    onProgress?: ProgressListener,
    mode?: RefreshMode
  ): Promise<ScanState>;
  async refreshAll(
    runId?: number,
    onProgress?: ProgressListener,
    mode: RefreshMode = "deep"
  ): Promise<void | ScanState> {
    if (this.refreshInProgress) {
      throw new Error("refresh_already_running");
    }
    this.refreshInProgress = true;
    try {
      const state = await this.performRefreshAdapters(
        this.adapters,
        runId,
        onProgress,
        mode
      );
      if (runId === undefined) return;
      return state;
    } catch (error) {
      if (runId !== undefined) {
        this.repository.failScan(
          runId,
          errorMessage(error, "刷新失败"),
          this.now()
        );
      }
      throw error;
    } finally {
      this.refreshInProgress = false;
    }
  }

  async refreshSource(
    source: SourceId,
    runId: number,
    mode: RefreshMode = "quick",
    onProgress?: ProgressListener
  ): Promise<ScanState> {
    if (this.refreshInProgress) {
      throw new Error("refresh_already_running");
    }
    const adapter = this.adapters.find(
      (candidate) => candidate.source === source
    );
    if (!adapter) throw new Error(`unknown_source:${source}`);
    this.refreshInProgress = true;
    try {
      return await this.performRefreshAdapters(
        [adapter],
        runId,
        onProgress,
        mode
      );
    } catch (error) {
      this.repository.failScan(
        runId,
        errorMessage(error, "刷新失败"),
        this.now()
      );
      throw error;
    } finally {
      this.refreshInProgress = false;
    }
  }

  private async performRefreshAdapters(
    adapters: SourceAdapter[],
    runId?: number,
    onProgress?: ProgressListener,
    mode: RefreshMode = "deep"
  ): Promise<ScanState> {
    const refreshStartedAt = this.now();
    const retainedListings = this.repository.getListings();
    const sourceResults = await Promise.all(adapters.map(async (
      adapter
    ) => {
      let result: RefreshSourceResult;
      let sourceDetails = 0;
      onProgress?.({
        type: "source_start",
        phase: "discover",
        source: adapter.source,
        page: 0,
        summaries: 0,
        details: 0,
        message: "正在发现公开目录"
      });
      try {
        await this.fetcher.beginSource?.(adapter.source);
        const previousById = new Map(
          retainedListings
            .filter(
              (listing) =>
                listing.source === adapter.source &&
                listing.sourceListingId !== null
            )
            .map((listing) => [listing.sourceListingId!, listing] as const)
        );
        result = await this.collectSource(
          adapter,
          refreshStartedAt,
          mode,
          previousById,
          (event) => {
            if (event.type === "detail_progress") {
              sourceDetails = event.details;
            }
            onProgress?.(event);
          }
        );
      } catch (error) {
        result = this.failedSourceFromError(
          adapter.source,
          error,
          "未知采集错误"
        );
      } finally {
        try {
          await this.fetcher.endSource?.(adapter.source);
        } catch (error) {
          result = this.failedSourceFromError(
            adapter.source,
            error,
            "来源会话清理失败"
          );
        }
      }
      const sourcePages =
        "metadata" in result.statusUpdate
          ? result.statusUpdate.metadata.pagesScanned
          : 0;
      const sourceSummaries =
        result.kind === "fresh" ? result.listings.length : 0;
      onProgress?.({
        type: "source_complete",
        phase: "list",
        source: adapter.source,
        page: sourcePages,
        summaries: sourceSummaries,
        details: sourceDetails,
        sourceState: result.statusUpdate.state,
        message: "来源扫描结束"
      });
      return {
        result,
        sourcePages,
        sourceSummaries,
        sourceDetails
      };
    }));
    const outcomes = sourceResults.map(({ result }) => result);
    const totalPages = sourceResults.reduce(
      (total, source) => total + source.sourcePages,
      0
    );
    const totalSummaries = sourceResults.reduce(
      (total, source) => total + source.sourceSummaries,
      0
    );
    const totalDetails = sourceResults.reduce(
      (total, source) => total + source.sourceDetails,
      0
    );

    const freshOutcomes = outcomes.filter(
      (
        outcome
      ): outcome is Extract<RefreshSourceResult, { kind: "fresh" }> =>
        outcome.kind === "fresh"
    );
    const freshListings = freshOutcomes.flatMap(
      ({ listings }) => listings
    );
    const roundState: ScanState =
      freshOutcomes.length === 0
        ? "failed"
        : outcomes.every(
              ({ statusUpdate }) => statusUpdate.state === "success"
            )
          ? "success"
          : "partial";

    if (runId !== undefined && freshOutcomes.length === 0) {
      this.repository.finalizeFailedScan(
        runId,
        outcomes.map(({ statusUpdate }) => statusUpdate),
        "没有来源取得新鲜数据",
        this.now()
      );
      onProgress?.({
        type: "complete",
        phase: null,
        source: null,
        page: totalPages,
        summaries: 0,
        details: totalDetails,
        roundState: "failed",
        message: "刷新失败"
      });
      return "failed";
    }

    const freshWithDuplicates = markPossibleDuplicates(freshListings);
    onProgress?.({
      type: "score",
      phase: "score",
      source: null,
      page: totalPages,
      summaries: totalSummaries,
      details: totalDetails,
      message: "正在统一评分"
    });
    const scored = scoreEligibleListings(freshWithDuplicates, this.now());
    const scores = new Map(scored.map((listing) => [listing.key, listing.score]));
    const freshDerived = freshWithDuplicates.map((listing) => ({
      ...listing,
      score: scores.get(listing.key) ?? null
    }));
    const replacedSources = new Set(
      freshOutcomes.map(({ source }) => source)
    );
    const retainedWithoutDerivedData = retainedListings
      .filter((listing) => !replacedSources.has(listing.source))
      .map((listing) => ({
        ...listing,
        score: null,
        possibleDuplicateKeys: []
      }));

    const nextListings = [
      ...retainedWithoutDerivedData,
      ...freshDerived
    ];
    onProgress?.({
      type: "commit",
      phase: "commit",
      source: null,
      page: totalPages,
      summaries: totalSummaries,
      details: totalDetails,
      message: "正在发布新快照"
    });
    let publishedState = roundState;
    if (runId === undefined) {
      this.repository.commitRefresh(
        nextListings,
        outcomes.map(({ statusUpdate }) => statusUpdate)
      );
    } else {
      publishedState = this.repository.commitScanRefresh(
        runId,
        nextListings,
        outcomes.map(({ statusUpdate }) => statusUpdate),
        this.now()
      );
    }
    onProgress?.({
      type: "complete",
      phase: null,
      source: null,
      page: totalPages,
      summaries: totalSummaries,
      details: totalDetails,
      roundState: publishedState,
      message:
        publishedState === "success" ? "刷新完成" : "部分来源异常"
    });
    return publishedState;
  }
}
