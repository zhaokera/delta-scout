import type {
  Listing,
  SourceId
} from "../domain/listing";

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
}

export interface ScoutApi {
  getSources(mode?: PoolMode): Promise<SourceStatusView[]>;
  getListings(view: ListingView, mode?: PoolMode): Promise<Listing[]>;
  getListing(key: string): Promise<Listing>;
  refresh(): Promise<void>;
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
  refresh: async () => {
    await requestJson("/api/refresh", { method: "POST" });
  }
};
