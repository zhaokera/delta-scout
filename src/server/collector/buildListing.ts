import { classifyListing } from "../../domain/classify.js";
import { calculateConfidence } from "../../domain/confidence.js";
import {
  parseJulang,
  parseM7,
  parseM7RareFinishes,
  parseRedSkins,
  toEvidenceRecords
} from "../../domain/evidence.js";
import type {
  Listing,
  LoginPlatform,
  Service
} from "../../domain/listing.js";
import { listingKey } from "../../domain/url.js";
import type { ListingDetail, ListingSummary } from "./types.js";

export interface CollectedListingInput {
  summary: ListingSummary;
  detail: ListingDetail | null;
  detailAttempted: boolean;
  warnings: string[];
}

function inferLoginPlatform(text: string): LoginPlatform {
  if (/(?:^|[\s，,、/-])QQ(?:官服)?(?:$|[\s，,、/-])/i.test(text)) {
    return "qq";
  }
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

export function shouldFetchListingDetail(
  summary: ListingSummary
): boolean {
  return (
    (summary.priceCny === null || summary.priceCny <= 6_000) &&
    (summary.detailFetchHint === "m7_prism_query" ||
      (/M7/i.test(summary.rawText) && /棱镜/.test(summary.rawText)))
  );
}

export function buildListing(
  collected: CollectedListingInput,
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
  const rareM7 = parseM7RareFinishes(evidence);
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
    m7RareFinishes: rareM7.finishes,
    m7RareFinishEvidence: rareM7.evidence,
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
    shouldFetchListingDetail(summary) &&
    (!detailAttempted || detail === null) &&
    classified === "eligible"
      ? "needs_verification"
      : classified;

  return { ...base, confidence, eligibility };
}
