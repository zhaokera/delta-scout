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
import { listingKey } from "../../domain/url.js";
import type { ListingRepository } from "../repository.js";
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

interface RefreshSourceResult {
  source: SourceId;
  fresh: boolean;
}

type StopReason =
  | "end_of_pages"
  | "no_new_items"
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
    possibleDuplicateKeys: []
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

  private failSource(
    source: SourceId,
    result: Exclude<
      Awaited<ReturnType<PageFetcher["fetchPage"]>>,
      { kind: "ok" }
    >
  ): void {
    if (result.kind === "blocked") {
      this.repository.markSourceFailure(
        source,
        result.reason,
        this.now(),
        "blocked"
      );
    } else {
      this.repository.markSourceFailure(
        source,
        result.error,
        this.now(),
        "failed"
      );
    }
  }

  private async refreshSource(
    adapter: SourceAdapter
  ): Promise<RefreshSourceResult> {
    const entry = await this.fetcher.fetchPage(
      { url: adapter.entryUrl },
      adapter.source
    );
    if (entry.kind !== "ok") {
      this.failSource(adapter.source, entry);
      return { source: adapter.source, fresh: false };
    }

    const discovery = adapter.discoverCatalog(entry.html, "三角洲行动");
    if (discovery.kind === "blocked") {
      this.repository.markSourceFailure(
        adapter.source,
        discovery.reason,
        this.now(),
        "blocked"
      );
      return { source: adapter.source, fresh: false };
    }

    const collected: CollectedSummary[] = [];
    const seen = new Set<string>();
    const seenRequests = new Set<string>();
    let listRequest: SourceRequest | null = discovery.request;
    let pages = 0;
    let detailCount = 0;
    let partial = false;
    let stopReason: StopReason | null = null;
    let sourceError: string | null = null;

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
          this.failSource(adapter.source, page);
          return { source: adapter.source, fresh: false };
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
          this.repository.markSourceFailure(
            adapter.source,
            reason,
            this.now(),
            "failed"
          );
          return { source: adapter.source, fresh: false };
        }
        partial = true;
        stopReason = "error";
        sourceError = reason;
        break;
      }
      if (parsed.kind === "blocked") {
        if (pages === 0) {
          this.repository.markSourceFailure(
            adapter.source,
            parsed.reason,
            this.now(),
            "blocked"
          );
          return { source: adapter.source, fresh: false };
        }
        partial = true;
        stopReason = "error";
        sourceError = parsed.reason;
        break;
      }

      pages += 1;
      const seenCountBeforePage = seen.size;
      let newItemCount = 0;
      let summaryLimitReached = false;
      let detailLimitReached = false;
      for (const item of parsed.items) {
        const identity = listingKey(
          item.source,
          item.sourceListingId,
          item.url
        );
        if (seen.has(identity)) continue;
        if (collected.length >= this.limits.maxSummaries) {
          summaryLimitReached = true;
          break;
        }
        seen.add(identity);
        newItemCount += 1;
        const record: CollectedSummary = {
          summary: item,
          detail: item.embeddedDetail ?? null,
          detailAttempted: item.embeddedDetail !== undefined,
          warnings: []
        };
        collected.push(record);

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
          let detailPage: Awaited<ReturnType<PageFetcher["fetchPage"]>>;
          try {
            const detailRequest = adapter.detailRequest(item);
            detailPage = await this.fetcher.fetchPage(
              detailRequest,
              adapter.source
            );
          } catch (error) {
            record.warnings.push(
              `详情获取失败：${errorMessage(error, "detail_fetch_failed")}`
            );
            continue;
          }
          if (detailPage.kind !== "ok") {
            record.warnings.push(
              detailPage.kind === "blocked"
                ? `详情自动采集受阻：${detailPage.reason}`
                : `详情获取失败：${detailPage.error}`
            );
            continue;
          }
          let detail: ReturnType<SourceAdapter["parseDetail"]>;
          try {
            detail = adapter.parseDetail(detailPage.html, item);
          } catch (error) {
            record.warnings.push(
              `详情解析失败：${errorMessage(error, "detail_parse_failed")}`
            );
            continue;
          }
          if (detail.kind === "blocked") {
            record.warnings.push(`详情解析受阻：${detail.reason}`);
          } else {
            record.detail = detail.detail;
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

    const capturedAt = this.now();
    const listings = collected.map((record) =>
      buildListing(record, capturedAt)
    );
    this.repository.replaceSourceSnapshot(
      adapter.source,
      listings,
      partial ? "partial" : "success",
      capturedAt,
      {
        pagesScanned: pages,
        stopReason: stopReason ?? "end_of_pages",
        error: sourceError
      }
    );
    return { source: adapter.source, fresh: true };
  }

  async refreshAll(): Promise<void> {
    const refreshStartedAt = this.now();
    const freshSources = new Set<SourceId>();
    for (const adapter of this.adapters) {
      try {
        const result = await this.refreshSource(adapter);
        if (result.fresh) {
          freshSources.add(result.source);
        }
      } catch (error) {
        this.repository.markSourceFailure(
          adapter.source,
          errorMessage(error, "未知采集错误"),
          this.now(),
          "failed"
        );
      }
    }

    const retainedListings = this.repository.getListings();
    const freshListings = retainedListings.filter(
      (listing) =>
        freshSources.has(listing.source) &&
        Date.parse(listing.capturedAt) >= refreshStartedAt.getTime()
    );
    const freshWithDuplicates = markPossibleDuplicates(freshListings);
    const scored = scoreEligibleListings(freshWithDuplicates, this.now());
    const scores = new Map(scored.map((listing) => [listing.key, listing.score]));
    const freshDerived = new Map(
      freshWithDuplicates.map((listing) => [
        listing.key,
        {
          ...listing,
          score: scores.get(listing.key) ?? null
        }
      ])
    );
    this.repository.updateDerivedListings(
      retainedListings.map(
        (listing) =>
          freshDerived.get(listing.key) ?? {
            ...listing,
            score: null,
            possibleDuplicateKeys: []
          }
      )
    );
  }
}
