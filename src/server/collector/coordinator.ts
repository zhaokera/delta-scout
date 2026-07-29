import { classifyListing } from "../../domain/classify.js";
import { calculateConfidence } from "../../domain/confidence.js";
import { markPossibleDuplicates } from "../../domain/duplicates.js";
import {
  parseJulang,
  parseM7,
  parseRedSkins,
  toEvidenceRecords
} from "../../domain/evidence.js";
import type {
  Listing,
  LoginPlatform,
  Service,
  SourceId
} from "../../domain/listing.js";
import { scoreEligibleListings } from "../../domain/score.js";
import {
  listingKey,
  normalizeListingUrl
} from "../../domain/url.js";
import type {
  ListingRepository,
  ScanState,
  SourceState,
  SourceRefreshStatusUpdate
} from "../repository.js";
import type {
  ListingDetail,
  ListingSummary,
  PageFetcher,
  SourceAdapter,
  SourceRequest
} from "./types.js";

interface CollectionLimits {
  maxPages: number;
  maxSummaries: number;
  maxDetails: number;
}

const DEFAULT_LIMITS: CollectionLimits = {
  maxPages: 100,
  maxSummaries: 2_000,
  maxDetails: 500
};

interface CoordinatorOptions {
  adapters: SourceAdapter[];
  fetcher: PageFetcher;
  repository: ListingRepository;
  now?: () => Date;
  limits?: Partial<CollectionLimits>;
}

interface CollectedSummary {
  summary: ListingSummary;
  detail: ListingDetail | null;
  detailAttempted: boolean;
  warnings: string[];
}

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

function inferLoginPlatform(text: string): LoginPlatform {
  if (/(?:^|[\s，,、/-])QQ(?:官服)?(?:$|[\s，,、/-])/i.test(text)) return "qq";
  if (/微信|WX/i.test(text)) return "wechat";
  return "unknown";
}

function inferService(text: string): Service {
  if (/QQ官服|官方服|官服/.test(text)) return "official";
  if (/渠道服|非官服/.test(text)) return "non_official";
  return "unknown";
}

function parseTotalAssetsM(text: string): number | null {
  const match = text.match(
    /总资产[】：:\s]*([\d.]+)\s*(亿|[mM]|万|[wW])?/
  );
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  if (match[2] === "亿") return value * 100;
  if (match[2]?.toLowerCase() === "m") return value;
  if (match[2] === "万" || match[2]?.toLowerCase() === "w") {
    return value / 100;
  }
  return value / 1_000_000;
}

function parseHafCoins(text: string): number | null {
  const match = text.match(
    /哈夫币[】：:\s]*([\d.]+)\s*(亿|万|[wW])?/
  );
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  if (match[2] === "亿") return value * 100_000_000;
  if (match[2] === "万" || match[2]?.toLowerCase() === "w") {
    return value * 10_000;
  }
  return value;
}

function shouldFetchDetail(summary: ListingSummary): boolean {
  return (
    (summary.priceCny === null || summary.priceCny <= 6_000) &&
    (summary.detailFetchHint === "m7_prism_query" ||
      (/M7/i.test(summary.rawText) && /棱镜/.test(summary.rawText)))
  );
}

function buildListing(
  collected: CollectedSummary,
  capturedAt: Date
): Listing {
  const { summary, detail, detailAttempted, warnings } = collected;
  const summaryEvidence = toEvidenceRecords(
    summary.rawText.split(/\r?\n+/)
  );
  const evidence = [
    ...summaryEvidence,
    ...(detail?.evidence ?? [])
  ].filter(
    (record, index, records) =>
      records.findIndex(({ text }) => text === record.text) === index
  );
  const combinedText = evidence.map(({ text }) => text).join("\n");
  const parsedM7 = parseM7(evidence);
  const m7 =
    summary.detailFetchHint === "m7_prism_query" &&
    detail === null &&
    parsedM7.status === "absent" &&
    parsedM7.evidence.length === 0
      ? { ...parsedM7, status: "unknown" as const }
      : parsedM7;
  const redSkins = parseRedSkins(evidence);
  const julang = parseJulang(evidence);
  const loginPlatform = detail
    ? detail.loginPlatform
    : inferLoginPlatform(combinedText);
  const service = detail
    ? detail.service
    : inferService(combinedText);

  const base: Listing = {
    key: listingKey(
      summary.source,
      summary.sourceListingId,
      summary.url
    ),
    source: summary.source,
    sourceListingId: summary.sourceListingId,
    url: summary.url,
    title: summary.title,
    originalDescription: combinedText,
    capturedAt: capturedAt.toISOString(),
    priceCny: summary.priceCny,
    loginPlatform,
    service,
    totalAssetsM: detail?.totalAssetsM ?? parseTotalAssetsM(combinedText),
    hafCoins: detail?.hafCoins ?? parseHafCoins(combinedText),
    evidence,
    m7PrismStatus: m7.status,
    m7PrismQuality: m7.quality ?? null,
    m7Evidence: m7.evidence,
    redSkins: redSkins.names,
    redSkinCount:
      redSkins.names.length > 0
        ? redSkins.names.length
        : redSkins.unnamed
          ? null
          : 0,
    redSkinUnnamed: redSkins.unnamed,
    julangStatus: julang.status,
    julangQuality: julang.quality ?? null,
    realNameStatus: detail?.realNameStatus ?? "unknown",
    secondRealNameAvailable:
      detail?.secondRealNameAvailable ?? null,
    recoveryCoverage: detail?.recoveryCoverage ?? null,
    verificationAt: detail?.verificationAt ?? null,
    banNotes: detail?.banNotes ?? [],
    parseWarnings: warnings,
    confidence: 0,
    eligibility: "needs_verification",
    score: null,
    possibleDuplicateKeys: [],
    scanStability: "unknown",
    consecutiveUnchangedScans: 0
  };

  const confidence = calculateConfidence(base);
  const classified = classifyListing({
    loginPlatform,
    service,
    priceCny: summary.priceCny,
    m7PrismStatus: m7.status
  });
  const eligibility =
    shouldFetchDetail(summary) &&
    (!detailAttempted || detail === null) &&
    classified === "eligible"
      ? "needs_verification"
      : classified;

  return { ...base, confidence, eligibility };
}

export class CollectionCoordinator {
  private readonly adapters: SourceAdapter[];
  private readonly fetcher: PageFetcher;
  private readonly repository: ListingRepository;
  private readonly now: () => Date;
  private readonly limits: CollectionLimits;
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

  private async refreshSource(
    adapter: SourceAdapter,
    refreshStartedAt: Date,
    onProgress?: ProgressListener
  ): Promise<RefreshSourceResult> {
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
    let consecutiveDetailFailures = 0;
    let consecutiveDetailFailureState: "blocked" | "failed" = "blocked";
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
        if (collected.length >= this.limits.maxSummaries) {
          summaryLimitReached = true;
          break;
        }
        for (const alias of aliases) {
          seenAliases.add(alias);
        }
        newItemCount += 1;
        const record: CollectedSummary = {
          summary: item,
          detail: item.embeddedDetail ?? null,
          detailAttempted: item.embeddedDetail !== undefined,
          warnings: []
        };
        collected.push(record);
        pageRecords.push(record);
      }

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
          shouldFetchDetail(item)
        ) {
          if (detailCount >= this.limits.maxDetails) {
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

      if (summaryLimitReached || detailLimitReached) {
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
        newItemCount === 0
      ) {
        if (parsed.items.length > 0 || next !== null) {
          partial = true;
          stopReason = "pagination_stalled";
        } else {
          stopReason = "end_of_pages";
        }
        break;
      }
      if (newItemCount === 0 && seenCountBeforePage > 0) {
        stopReason = "no_new_items";
        break;
      }
      if (next === null) {
        stopReason = "end_of_pages";
        break;
      }
      if (newItemCount === 0) {
        stopReason = "no_new_items";
        break;
      }
      if (seenRequests.has(requestFingerprint(next))) {
        stopReason = "repeated_request";
        break;
      }
      if (
        pages >= this.limits.maxPages ||
        collected.length >= this.limits.maxSummaries
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
    onProgress?: ProgressListener
  ): Promise<ScanState>;
  async refreshAll(
    runId?: number,
    onProgress?: ProgressListener
  ): Promise<void | ScanState> {
    if (this.refreshInProgress) {
      throw new Error("refresh_already_running");
    }
    this.refreshInProgress = true;
    try {
      const state = await this.performRefreshAll(runId, onProgress);
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

  private async performRefreshAll(
    runId?: number,
    onProgress?: ProgressListener
  ): Promise<ScanState> {
    const refreshStartedAt = this.now();
    const retainedListings = this.repository.getListings();
    const outcomes: RefreshSourceResult[] = [];
    let totalPages = 0;
    let totalSummaries = 0;
    let totalDetails = 0;
    for (const adapter of this.adapters) {
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
        result = await this.refreshSource(
          adapter,
          refreshStartedAt,
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
      outcomes.push(result);
      const sourcePages =
        "metadata" in result.statusUpdate
          ? result.statusUpdate.metadata.pagesScanned
          : 0;
      const sourceSummaries =
        result.kind === "fresh" ? result.listings.length : 0;
      totalPages += sourcePages;
      totalSummaries += sourceSummaries;
      totalDetails += sourceDetails;
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
    }

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
    if (runId === undefined) {
      this.repository.commitRefresh(
        nextListings,
        outcomes.map(({ statusUpdate }) => statusUpdate)
      );
    } else {
      this.repository.commitScanRefresh(
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
      roundState,
      message: roundState === "success" ? "刷新完成" : "部分来源异常"
    });
    return roundState;
  }
}
