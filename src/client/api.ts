import type {
  Eligibility,
  Listing,
  SourceId
} from "../domain/listing";

export type SourceState =
  | "idle"
  | "success"
  | "partial"
  | "blocked"
  | "failed";

export interface SourceStatusView {
  source: SourceId;
  state: SourceState;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  itemCount: number;
  error: string | null;
  stale: boolean;
}

export interface ScoutApi {
  getSources(): Promise<SourceStatusView[]>;
  getListings(status: Eligibility): Promise<Listing[]>;
  getListing(key: string): Promise<Listing>;
  refresh(): Promise<void>;
}

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
  getSources: () => requestJson<SourceStatusView[]>("/api/sources"),
  getListings: (status) =>
    requestJson<Listing[]>(
      `/api/listings?status=${encodeURIComponent(status)}`
    ),
  getListing: (key) =>
    requestJson<Listing>(
      `/api/listings/${encodeURIComponent(key)}`
    ),
  refresh: async () => {
    await requestJson("/api/refresh", { method: "POST" });
  }
};
