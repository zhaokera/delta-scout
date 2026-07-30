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

const SAFE_API_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  refresh_conflict: "另一个刷新任务正在进行",
  invalid_browser_payload: "浏览器刷新请求格式无效",
  browser_payload_too_large: "浏览器刷新请求超过大小限制",
  browser_refresh_failed: "交易猫浏览器刷新操作失败",
  browser_job_not_found: "交易猫浏览器刷新任务不存在",
  browser_job_conflict: "交易猫浏览器刷新任务已存在",
  browser_job_expired: "交易猫浏览器刷新任务已过期",
  bridge_unauthorized: "浏览器桥接授权无效或已过期",
  invalid_transition: "当前任务状态不允许此操作",
  filter_mismatch: "页面筛选条件与目标不一致",
  staging_invalid: "浏览器采集数据无效",
  list_incomplete: "列表采集尚未完成",
  details_incomplete: "详情采集尚未完成",
  safety_limit: "浏览器采集已达到安全上限",
  cooldown_active: "浏览器采集仍在冷却中",
  action_too_early: "尚未到下一次浏览器操作时间",
  action_permit_required: "本次操作缺少一次性许可",
  action_permit_invalid: "一次性操作许可无效或已过期"
};

const SENSITIVE_ERROR_PATTERN =
  /claim[\s_-]*code|bridge[\s_-]*token|action[\s_-]*permit|credential|secret|token|password|captcha|cookie|local[\s_-]*storage|验证码(?:答案|结果|内容)?\s*[:=]/i;

const SENSITIVE_ERROR_KEY_PARTS = [
  "credential",
  "claimcode",
  "bridgetoken",
  "actionpermit",
  "token",
  "secret",
  "password",
  "captcha",
  "cookie",
  "localstorage",
  "session",
  "auth"
] as const;

const ERROR_VALUE_SCAN_LIMITS = {
  depth: 6,
  nodes: 256,
  children: 64,
  values: 32
} as const;

function isSensitiveErrorKey(key: string): boolean {
  const normalized = key
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return SENSITIVE_ERROR_KEY_PARTS.some((part) =>
    normalized.includes(part)
  );
}

function collectSensitiveErrorValues(payload: object): {
  values: string[];
  incomplete: boolean;
} {
  const values: string[] = [];
  const seen = new WeakSet<object>();
  let visitedNodes = 0;
  let incomplete = false;

  const visit = (
    value: unknown,
    depth: number,
    inheritedSensitive: boolean
  ): void => {
    if (
      depth > ERROR_VALUE_SCAN_LIMITS.depth ||
      visitedNodes >= ERROR_VALUE_SCAN_LIMITS.nodes ||
      values.length >= ERROR_VALUE_SCAN_LIMITS.values
    ) {
      incomplete = true;
      return;
    }
    visitedNodes += 1;
    if (typeof value === "string") {
      const candidate = value.trim();
      if (inheritedSensitive && candidate.length > 0) {
        if (candidate.length > 160) {
          incomplete = true;
        } else {
          values.push(candidate);
        }
      }
      return;
    }
    if (value === null || value === undefined) return;
    if (typeof value !== "object") {
      if (inheritedSensitive) incomplete = true;
      return;
    }
    if (inheritedSensitive) {
      if (Array.isArray(value)) {
        if (value.length > 0) incomplete = true;
        return;
      }
      for (const key in value) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
          incomplete = true;
          return;
        }
      }
      return;
    }
    if (seen.has(value)) {
      incomplete = true;
      return;
    }
    seen.add(value);

    if (Array.isArray(value)) {
      if (value.length > ERROR_VALUE_SCAN_LIMITS.children) {
        incomplete = true;
      }
      const length = Math.min(
        value.length,
        ERROR_VALUE_SCAN_LIMITS.children
      );
      for (let index = 0; index < length; index += 1) {
        visit(value[index], depth + 1, inheritedSensitive);
      }
      return;
    }

    let childCount = 0;
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      if (
        childCount >= ERROR_VALUE_SCAN_LIMITS.children ||
        visitedNodes >= ERROR_VALUE_SCAN_LIMITS.nodes ||
        values.length >= ERROR_VALUE_SCAN_LIMITS.values
      ) {
        incomplete = true;
        break;
      }
      childCount += 1;
      if (key.length > 256) {
        incomplete = true;
        continue;
      }
      let child: unknown;
      try {
        child = (value as Record<string, unknown>)[key];
      } catch {
        incomplete = true;
        continue;
      }
      visit(
        child,
        depth + 1,
        inheritedSensitive || isSensitiveErrorKey(key)
      );
    }
  };

  visit(payload, 0, false);
  return { values, incomplete };
}

function safeApiErrorMessage(
  payload: unknown,
  status: number
): string {
  const fallback = `请求失败（${status}）`;
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return fallback;
  }
  const candidate = payload as Record<string, unknown>;
  const code = candidate.error;
  if (typeof code === "string" && SAFE_API_ERROR_MESSAGES[code]) {
    return SAFE_API_ERROR_MESSAGES[code];
  }
  const message = candidate.message;
  if (
    typeof message !== "string" ||
    message.length === 0 ||
    message.length > 160 ||
    message.trim() !== message ||
    /[\u0000-\u001F\u007F]/.test(message) ||
    SENSITIVE_ERROR_PATTERN.test(message)
  ) {
    return fallback;
  }
  const sensitiveScan = collectSensitiveErrorValues(payload);
  if (
    sensitiveScan.incomplete ||
    sensitiveScan.values.some((value) => message.includes(value))
  ) {
    return fallback;
  }
  return message;
}

async function requestJson<T>(
  input: string,
  init?: RequestInit
): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    throw new Error(safeApiErrorMessage(payload, response.status));
  }
  return response.json() as Promise<T>;
}

function postBrowserJson<T>(
  input: string,
  body: Record<string, never> = {}
): Promise<T> {
  return requestJson<T>(input, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
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
    postBrowserJson<StartedJiaoyimaoBrowserRefresh>(
      "/api/sources/jiaoyimao/browser-refresh"
    ),
  cancelJiaoyimaoBrowserRefresh: (jobId) =>
    postBrowserJson<JiaoyimaoBrowserRefreshJob>(
      `/api/sources/jiaoyimao/browser-refresh/${
        encodeURIComponent(jobId)
      }/cancel`
    ),
  keepWaitingForJiaoyimaoBrowserRefresh: (jobId) =>
    postBrowserJson<JiaoyimaoBrowserRefreshJob>(
      `/api/sources/jiaoyimao/browser-refresh/${
        encodeURIComponent(jobId)
      }/keep-waiting`
    )
};
