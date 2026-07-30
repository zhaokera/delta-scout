import type {
  Listing,
  SourceId
} from "../domain/listing";
import type {
  ListingFieldChange,
  ListingHistorySnapshot
} from "../domain/listingHistory";

export type ListingView =
  | "pool"
  | "eligible"
  | "needs_verification"
  | "rejected";
export type PoolMode = "balanced" | "global";

export type SourceState =
  | "idle"
  | "success"
  | "partial"
  | "blocked"
  | "failed";

export type SourceCompletion =
  | "complete"
  | "partial"
  | "blocked"
  | "failed"
  | "idle";

export interface SourceStatusView {
  source: SourceId;
  state: SourceState;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  pagesScanned: number;
  itemCount: number;
  eligibleCount: number;
  candidateCount: number;
  balancedCandidateCount: number;
  globalCandidateCount: number;
  stopReason: string | null;
  completion: SourceCompletion;
  error: string | null;
  stale: boolean;
  anomaly:
    | { state: "clear" }
    | {
        state: "suspect";
        baselineItemCount: number;
        baselinePagesScanned: number;
        observedItemCount: number;
        observedPagesScanned: number;
        confirmationCount: number;
        firstDetectedAt: string;
        lastDetectedAt: string;
        reason: string;
      };
}

export type RefreshState =
  | "idle"
  | "running"
  | "success"
  | "partial"
  | "failed";

export interface RefreshStatusView {
  runId: number | null;
  state: RefreshState;
  startedAt: string | null;
  finishedAt: string | null;
  source: SourceId | null;
  phase:
    | "discover"
    | "list"
    | "detail"
    | "score"
    | "commit"
    | null;
  page: number;
  summaries: number;
  details: number;
  message: string | null;
  error: string | null;
  lastSnapshotAt: string | null;
}

export type JiaoyimaoBrowserRefreshState =
  | "awaiting_codex"
  | "collecting_list"
  | "collecting_details"
  | "awaiting_user_verification"
  | "cooling_down"
  | "validating"
  | "committing"
  | "success"
  | "quarantined"
  | "paused"
  | "failed"
  | "cancelled"
  | "expired";

export interface JiaoyimaoBrowserRefreshJob {
  id: string;
  source: "jiaoyimao";
  state: JiaoyimaoBrowserRefreshState;
  stage: string;
  reason: string | null;
  claimedAt: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  expiresAt: string;
  listBatchCursor: number;
  detailCompletedCount: number;
  detailRequiredCount: number;
  uniqueItemCount: number;
  itemCount: number;
  loadActionCount: number;
  cooldownAttempt: number;
  cooldownUntil: string | null;
  nextActionAt: string | null;
  actionPermitExpiresAt: string | null;
  actionPermitConsumedAt: string | null;
  filterUrl: string | null;
  lastError: string | null;
  scanRunId: number | null;
  publishedRunId: number | null;
}

export interface StartedJiaoyimaoBrowserRefresh {
  jobId: string;
  state: "awaiting_codex";
  claimCode: string;
  expiresAt: string;
}

export interface JiaoyimaoBrowserRefreshConflict {
  activeKind: "all_sources" | "browser";
  message: string;
}

export interface ScanHistoryResponse {
  runs: Array<{
    id: number;
    startedAt: string;
    finishedAt: string | null;
    state: "running" | "success" | "partial" | "failed";
    error: string | null;
    scope: "all_sources" | "single_source";
    requestedSource: SourceId | null;
    sources: Array<{
      source: SourceId;
      state: Exclude<SourceState, "idle">;
      pagesScanned: number;
      observedItemCount: number;
      eligibleCount: number;
      balancedCandidateCount: number;
      globalCandidateCount: number;
      stopReason: string | null;
      error: string | null;
      anomalyState: string;
      published: boolean;
    }>;
  }>;
}

export interface ListingHistoryView {
  key: string;
  source: SourceId;
  availability: "active" | "removed" | "unknown";
  lastSeenAt: string | null;
  observations: Array<{
    runId: number;
    observedAt: string;
    availability: "active" | "removed";
    priceCny: number | null;
    snapshot: ListingHistorySnapshot;
    changes: ListingFieldChange[];
  }>;
}

export interface ScoutApi {
  getSources(mode?: PoolMode): Promise<SourceStatusView[]>;
  getListings(view: ListingView, mode?: PoolMode): Promise<Listing[]>;
  getListing(key: string): Promise<Listing>;
  getListingHistory(key: string, limit?: number): Promise<ListingHistoryView>;
  startRefresh(): Promise<{ runId: number; state: "running" }>;
  getRefreshStatus(): Promise<RefreshStatusView>;
  getScanHistory(limit?: number): Promise<ScanHistoryResponse>;
  getCurrentJiaoyimaoBrowserRefresh():
    Promise<JiaoyimaoBrowserRefreshJob | null>;
  startJiaoyimaoBrowserRefresh():
    Promise<StartedJiaoyimaoBrowserRefresh>;
  cancelJiaoyimaoBrowserRefresh(
    jobId: string
  ): Promise<JiaoyimaoBrowserRefreshJob>;
  keepWaitingForJiaoyimaoBrowserRefresh(
    jobId: string
  ): Promise<JiaoyimaoBrowserRefreshJob>;
}

const LISTING_QUERIES: Record<ListingView, string> = {
  pool: "view=pool&status=eligible",
  eligible: "view=all&status=eligible",
  needs_verification: "view=all&status=needs_verification",
  rejected: "view=all&status=rejected"
};

async function requestJson<T>(
  input: string,
  init?: RequestInit
): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { message?: string }
      | null;
    throw new Error(payload?.message ?? `请求失败（${response.status}）`);
  }
  return response.json() as Promise<T>;
}

export const httpScoutApi: ScoutApi = {
  getSources: (mode = "balanced") =>
    requestJson<SourceStatusView[]>(`/api/sources?mode=${mode}`),
  getListings: (view, mode = "balanced") =>
    requestJson<Listing[]>(
      `/api/listings?${LISTING_QUERIES[view]}${
        view === "pool" && mode === "global" ? "&mode=global" : ""
      }`
    ),
  getListing: (key) =>
    requestJson<Listing>(
      `/api/listings/${encodeURIComponent(key)}`
    ),
  getListingHistory: (key, limit = 20) =>
    requestJson<ListingHistoryView>(
      `/api/listings/${encodeURIComponent(key)}/history?limit=${limit}`
    ),
  startRefresh: () =>
    requestJson<{ runId: number; state: "running" }>("/api/refresh", {
      method: "POST"
    }),
  getRefreshStatus: () =>
    requestJson<RefreshStatusView>("/api/refresh-status"),
  getScanHistory: (limit = 10) =>
    requestJson<ScanHistoryResponse>(
      `/api/scan-history?limit=${limit}`
    ),
  getCurrentJiaoyimaoBrowserRefresh: () =>
    requestJson<JiaoyimaoBrowserRefreshJob | null>(
      "/api/sources/jiaoyimao/browser-refresh/current"
    ),
  startJiaoyimaoBrowserRefresh: () =>
    requestJson<StartedJiaoyimaoBrowserRefresh>(
      "/api/sources/jiaoyimao/browser-refresh",
      { method: "POST" }
    ),
  cancelJiaoyimaoBrowserRefresh: (jobId) =>
    requestJson<JiaoyimaoBrowserRefreshJob>(
      `/api/sources/jiaoyimao/browser-refresh/${
        encodeURIComponent(jobId)
      }/cancel`,
      { method: "POST" }
    ),
  keepWaitingForJiaoyimaoBrowserRefresh: (jobId) =>
    requestJson<JiaoyimaoBrowserRefreshJob>(
      `/api/sources/jiaoyimao/browser-refresh/${
        encodeURIComponent(jobId)
      }/keep-waiting`,
      { method: "POST" }
    )
};
