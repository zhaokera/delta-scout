import type {
  LoginPlatform,
  RealNameStatus,
  Service,
  SourceId
} from "../../domain/listing.js";
import type { EvidenceRecord } from "../../domain/evidence.js";

export interface ListingSummary {
  source: SourceId;
  sourceListingId: string | null;
  url: string;
  title: string;
  rawText: string;
  priceCny: number | null;
  embeddedDetail?: ListingDetail;
}

export interface ListingDetail {
  evidence: EvidenceRecord[];
  loginPlatform: LoginPlatform;
  service: Service;
  totalAssetsM: number | null;
  hafCoins: number | null;
  realNameStatus: RealNameStatus;
  secondRealNameAvailable: boolean | null;
  recoveryCoverage: boolean | null;
  verificationAt: string | null;
  banNotes: string[];
}

export interface PublicRequestOptions {
  method?: "GET" | "POST";
  accept?: string;
  contentType?: string;
  origin?: string;
  referer?: string;
  body?: string;
}

export interface SourceRequest {
  url: string;
  options?: PublicRequestOptions;
}

export type DiscoveryResult =
  | { kind: "ok"; request: SourceRequest }
  | { kind: "blocked"; reason: string };

export type ListParseResult =
  | { kind: "ok"; items: ListingSummary[] }
  | { kind: "blocked"; reason: string };

export type DetailParseResult =
  | { kind: "ok"; detail: ListingDetail }
  | { kind: "blocked"; reason: string };

export interface SourceAdapter {
  source: SourceId;
  entryUrl: string;
  discoverCatalog(html: string, query: string): DiscoveryResult;
  parseList(html: string): ListParseResult;
  nextPage(
    html: string,
    currentRequest: SourceRequest
  ): SourceRequest | null;
  detailRequest(summary: ListingSummary): SourceRequest;
  parseDetail(html: string, summary: ListingSummary): DetailParseResult;
}

export type FetchResult =
  | { kind: "ok"; url: string; status: number; html: string }
  | { kind: "blocked"; url: string; reason: string }
  | { kind: "failed"; url: string; error: string };

export interface PageFetcher {
  fetchPage(
    request: SourceRequest,
    source: SourceId
  ): Promise<FetchResult>;
}
