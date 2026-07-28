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

const MAX_PAGES = 3;
const MAX_SUMMARIES = 60;
const MAX_DETAILS = 20;

interface CoordinatorOptions {
  adapters: SourceAdapter[];
  fetcher: PageFetcher;
  repository: ListingRepository;
  now?: () => Date;
}

interface CollectedSummary {
  summary: ListingSummary;
  detail: ListingDetail | null;
  detailAttempted: boolean;
  warnings: string[];
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
    /M7/i.test(summary.rawText) &&
    /棱镜/.test(summary.rawText)
  );
}

function buildListing(
  collected: CollectedSummary,
  capturedAt: Date
): Listing {
  const { summary, detail, detailAttempted, warnings } = collected;
  const summaryEvidence = toEvidenceRecords([summary.rawText]);
  const evidence = [
    ...summaryEvidence,
    ...(detail?.evidence ?? [])
  ].filter(
    (record, index, records) =>
      records.findIndex(({ text }) => text === record.text) === index
  );
  const combinedText = evidence.map(({ text }) => text).join("\n");
  const m7 = parseM7(evidence);
  const redSkins = parseRedSkins(evidence);
  const julang = parseJulang(evidence);
  const loginPlatform =
    detail?.loginPlatform === "unknown" || !detail
      ? inferLoginPlatform(combinedText)
      : detail.loginPlatform;
  const service =
    detail?.service === "unknown" || !detail
      ? inferService(combinedText)
      : detail.service;

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

  constructor(options: CoordinatorOptions) {
    this.adapters = options.adapters;
    this.fetcher = options.fetcher;
    this.repository = options.repository;
    this.now = options.now ?? (() => new Date());
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

  private async refreshSource(adapter: SourceAdapter): Promise<void> {
    const entry = await this.fetcher.fetchPage(
      { url: adapter.entryUrl },
      adapter.source
    );
    if (entry.kind !== "ok") {
      this.failSource(adapter.source, entry);
      return;
    }

    const discovery = adapter.discoverCatalog(entry.html, "三角洲行动");
    if (discovery.kind === "blocked") {
      this.repository.markSourceFailure(
        adapter.source,
        discovery.reason,
        this.now(),
        "blocked"
      );
      return;
    }

    const collected: CollectedSummary[] = [];
    const seen = new Set<string>();
    const seenRequests = new Set<string>();
    let listRequest: SourceRequest | null = discovery.request;
    let pages = 0;
    let detailCount = 0;
    let partial = false;

    while (
      listRequest &&
      pages < MAX_PAGES &&
      collected.length < MAX_SUMMARIES
    ) {
      const currentRequest = listRequest;
      const requestFingerprint = [
        currentRequest.options?.method ?? "GET",
        currentRequest.url,
        currentRequest.options?.body ?? ""
      ].join("\n");
      if (seenRequests.has(requestFingerprint)) break;
      seenRequests.add(requestFingerprint);
      const page = await this.fetcher.fetchPage(
        currentRequest,
        adapter.source
      );
      if (page.kind !== "ok") {
        if (collected.length === 0) {
          this.failSource(adapter.source, page);
          return;
        }
        partial = true;
        break;
      }
      const parsed = adapter.parseList(page.html);
      if (parsed.kind === "blocked") {
        if (collected.length === 0) {
          this.repository.markSourceFailure(
            adapter.source,
            parsed.reason,
            this.now(),
            "blocked"
          );
          return;
        }
        partial = true;
        break;
      }

      pages += 1;
      if (parsed.items.length + collected.length > MAX_SUMMARIES) {
        partial = true;
      }
      for (const item of parsed.items) {
        const identity = item.sourceListingId ?? item.url;
        if (seen.has(identity)) continue;
        if (collected.length >= MAX_SUMMARIES) {
          partial = true;
          break;
        }
        seen.add(identity);
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
          if (detailCount >= MAX_DETAILS) {
            partial = true;
            record.warnings.push("达到详情采集上限，待人工核验");
            continue;
          }
          detailCount += 1;
          record.detailAttempted = true;
          const detailPage = await this.fetcher.fetchPage(
            adapter.detailRequest(item),
            adapter.source
          );
          if (detailPage.kind !== "ok") {
            record.warnings.push(
              detailPage.kind === "blocked"
                ? `详情自动采集受阻：${detailPage.reason}`
                : `详情获取失败：${detailPage.error}`
            );
            continue;
          }
          const detail = adapter.parseDetail(detailPage.html, item);
          if (detail.kind === "blocked") {
            record.warnings.push(`详情解析受阻：${detail.reason}`);
          } else {
            record.detail = detail.detail;
          }
        }
      }

      const next = adapter.nextPage(page.html, currentRequest);
      if (
        collected.length >= MAX_SUMMARIES ||
        (pages >= MAX_PAGES && next !== null)
      ) {
        if (next !== null) partial = true;
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
      capturedAt
    );
  }

  async refreshAll(): Promise<void> {
    for (const adapter of this.adapters) {
      try {
        await this.refreshSource(adapter);
      } catch (error) {
        this.repository.markSourceFailure(
          adapter.source,
          error instanceof Error ? error.message : "未知采集错误",
          this.now(),
          "failed"
        );
      }
    }

    const withDuplicates = markPossibleDuplicates(
      this.repository.getListings()
    );
    const scored = scoreEligibleListings(withDuplicates, this.now());
    const scores = new Map(scored.map((listing) => [listing.key, listing.score]));
    this.repository.updateDerivedListings(
      withDuplicates.map((listing) => ({
        ...listing,
        score: scores.get(listing.key) ?? null
      }))
    );
  }
}
