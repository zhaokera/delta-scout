import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import { readFileSync } from "node:fs";
import { StrictMode } from "react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { App } from "../../src/client/App";
import type {
  JiaoyimaoBrowserRefreshJob,
  ListingView,
  PoolMode,
  RefreshStatusView,
  ScoutApi,
  SourceStatusView
} from "../../src/client/api";
import {
  httpScoutApi,
  ScoutApiError
} from "../../src/client/api";
import type { Listing, SourceId } from "../../src/domain/listing";
import { buildListingHistorySnapshot } from "../../src/domain/listingHistory";
import type {
  ManualExclusionInput,
  ReviewedListing
} from "../../src/domain/manualReview";
import { makeListing, makeScore } from "../domain/listingFactory";

function makeSourceStatus(
  overrides: Partial<SourceStatusView> & { source: SourceId }
): SourceStatusView {
  return {
    state: "success",
    lastAttemptAt: "2026-07-28T10:00:00.000Z",
    lastSuccessAt: "2026-07-28T10:00:00.000Z",
    pagesScanned: 5,
    itemCount: 30,
    eligibleCount: 3,
    candidateCount: 3,
    balancedCandidateCount: 3,
    globalCandidateCount: 3,
    stopReason: "end_of_pages",
    completion: "complete",
    error: null,
    stale: false,
    anomaly: { state: "clear" },
    ...overrides
  };
}

function asReviewedListing(
  listing: Listing | ReviewedListing
): ReviewedListing {
  return {
    ...listing,
    manualReview:
      "manualReview" in listing ? listing.manualReview : null
  };
}

function makeApi({
  sources = [],
  getSources = async () => sources,
  getListings = async () => [],
  getListing,
  getListingHistory,
  startRefresh = async () => ({ runId: 1, state: "running" as const }),
  getRefreshStatus = async () => makeRefreshStatus(),
  getScanHistory = async () => ({ runs: [] }),
  excludeListing,
  restoreListing,
  getCurrentJiaoyimaoBrowserRefresh = async () => null,
  startJiaoyimaoBrowserRefresh = async () => ({
    jobId: "browser-job-1",
    state: "awaiting_codex" as const,
    claimCode: "one-time-code",
    expiresAt: "2026-07-31T02:00:00.000Z"
  }),
  cancelJiaoyimaoBrowserRefresh = async () => {
    throw new Error("not configured");
  },
  keepWaitingForJiaoyimaoBrowserRefresh = async () => {
    throw new Error("not configured");
  }
}: {
  sources?: SourceStatusView[];
  getSources?: ScoutApi["getSources"];
  getListings?: (
    view: ListingView,
    mode?: PoolMode
  ) => Promise<Array<Listing | ReviewedListing>>;
  getListing?: (
    key: string
  ) => Promise<Listing | ReviewedListing>;
  getListingHistory?: ScoutApi["getListingHistory"];
  excludeListing?: (
    key: string,
    input: ManualExclusionInput
  ) => Promise<Listing | ReviewedListing>;
  restoreListing?: (
    key: string
  ) => Promise<Listing | ReviewedListing>;
  startRefresh?: ScoutApi["startRefresh"];
  getRefreshStatus?: ScoutApi["getRefreshStatus"];
  getScanHistory?: ScoutApi["getScanHistory"];
  getCurrentJiaoyimaoBrowserRefresh?:
    ScoutApi["getCurrentJiaoyimaoBrowserRefresh"];
  startJiaoyimaoBrowserRefresh?:
    ScoutApi["startJiaoyimaoBrowserRefresh"];
  cancelJiaoyimaoBrowserRefresh?:
    ScoutApi["cancelJiaoyimaoBrowserRefresh"];
  keepWaitingForJiaoyimaoBrowserRefresh?:
    ScoutApi["keepWaitingForJiaoyimaoBrowserRefresh"];
} = {}): ScoutApi {
  const resolveListings: ScoutApi["getListings"] = async (
    view,
    mode
  ) => (await getListings(view, mode)).map(asReviewedListing);
  const resolveListing =
    getListing
      ? async (key: string) =>
          asReviewedListing(await getListing(key))
      : async (key: string) => {
          const listings = await resolveListings("pool");
          const listing = listings.find(
            (candidate) => candidate.key === key
          );
          if (!listing) throw new Error("not found");
          return listing;
        };
  const resolveHistory =
    getListingHistory ??
    (async (key: string) => {
      const listing = await resolveListing(key);
      return {
        key,
        source: listing.source,
        availability: "active" as const,
        lastSeenAt: listing.capturedAt,
        observations: []
      };
    });

  return {
    getSources: vi.fn(getSources),
    getListings: vi.fn(resolveListings),
    getListing: vi.fn(resolveListing),
    getListingHistory: vi.fn(resolveHistory),
    excludeListing: vi.fn(
      excludeListing
        ? async (key, input) =>
            asReviewedListing(await excludeListing(key, input))
        : async (key, input) => ({
            ...await resolveListing(key),
            manualReview: {
              excluded: true as const,
              reason: input.reason,
              note: input.note,
              reviewedAt: "2026-07-31T08:00:00.000Z"
            }
          })
    ),
    restoreListing: vi.fn(
      restoreListing
        ? async (key) =>
            asReviewedListing(await restoreListing(key))
        : async (key) => ({
            ...await resolveListing(key),
            manualReview: null
          })
    ),
    startRefresh: vi.fn(startRefresh),
    getRefreshStatus: vi.fn(getRefreshStatus),
    getScanHistory: vi.fn(getScanHistory),
    getCurrentJiaoyimaoBrowserRefresh:
      vi.fn(getCurrentJiaoyimaoBrowserRefresh),
    startJiaoyimaoBrowserRefresh:
      vi.fn(startJiaoyimaoBrowserRefresh),
    cancelJiaoyimaoBrowserRefresh:
      vi.fn(cancelJiaoyimaoBrowserRefresh),
    keepWaitingForJiaoyimaoBrowserRefresh:
      vi.fn(keepWaitingForJiaoyimaoBrowserRefresh)
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function makeViewListings(count: number, source: SourceId): Listing[] {
  return Array.from({ length: count }, (_, index) =>
    makeListing({
      key: `${source}:${index}`,
      source,
      sourceListingId: `${source.toUpperCase()}-${index}`
    })
  );
}

function makeRefreshStatus(
  overrides: Partial<RefreshStatusView> = {}
): RefreshStatusView {
  return {
    runId: null,
    state: "idle",
    startedAt: null,
    finishedAt: null,
    source: null,
    phase: null,
    page: 0,
    summaries: 0,
    details: 0,
    message: null,
    error: null,
    lastSnapshotAt: "2026-07-28T10:00:00.000Z",
    ...overrides
  };
}

function makeBrowserRefreshJob(
  overrides: Partial<JiaoyimaoBrowserRefreshJob> = {}
): JiaoyimaoBrowserRefreshJob {
  return {
    id: "browser-job-1",
    source: "jiaoyimao",
    state: "collecting_list",
    stage: "list",
    reason: null,
    claimedAt: "2026-07-31T01:00:00.000Z",
    createdAt: "2026-07-31T00:59:00.000Z",
    updatedAt: "2026-07-31T01:01:00.000Z",
    finishedAt: null,
    expiresAt: "2026-07-31T02:00:00.000Z",
    listBatchCursor: 1,
    detailCompletedCount: 0,
    detailRequiredCount: 2,
    uniqueItemCount: 8,
    itemCount: 8,
    loadActionCount: 1,
    cooldownAttempt: 0,
    cooldownUntil: null,
    nextActionAt: "2026-07-31T01:01:02.000Z",
    actionPermitExpiresAt: null,
    actionPermitConsumedAt: null,
    filterUrl:
      "https://www.jiaoyimao.com/jg2007840/" +
      "f8845003-c8845004/o110/",
    lastError: null,
    scanRunId: null,
    publishedRunId: null,
    ...overrides
  };
}

function stubViewport(matches: boolean): () => void {
  const original = window.matchMedia;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true)
    }))
  });
  return () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: original
    });
  };
}

describe("App shell", () => {
  it("keeps the source browser-refresh touch target at least 44px tall", () => {
    const clientStyles = readFileSync(
      "src/client/styles.css",
      "utf8"
    );
    expect(clientStyles).toMatch(
      /\.source-card__browser-refresh\s*\{[^}]*min-height:\s*44px;/s
    );
  });

  it("shows the fixed account requirements", () => {
    render(<App api={makeApi()} />);

    expect(
      screen.getByRole("heading", { name: "三角洲账号候选台" })
    ).toBeInTheDocument();
    expect(screen.getByText("QQ 官服")).toBeInTheDocument();
    expect(
      screen.getByText("M7 棱镜攻势 · 极品 / 优品S")
    ).toBeInTheDocument();
    expect(screen.getByText("¥6,000 以内")).toBeInTheDocument();
  });

  it("maps every listing view to an explicit API query", async () => {
    const fetchMock = vi.fn(async (
      _input: string,
      _init?: RequestInit
    ) => ({
      ok: true,
      json: async () => []
    }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      await httpScoutApi.getListings("pool");
      await httpScoutApi.getListings("pool", "global");
      await httpScoutApi.getListings("eligible");
      await httpScoutApi.getListings("needs_verification");
      await httpScoutApi.getListings("rejected");
      await httpScoutApi.startRefresh();
      await httpScoutApi.getRefreshStatus();
      await httpScoutApi.getScanHistory(5);
      await httpScoutApi.getListingHistory("panzhi:SA 123", 7);
      await httpScoutApi.excludeListing("panzhi:SA 123", {
        reason: "price_overvalued",
        note: "同价位更安全"
      });
      await httpScoutApi.restoreListing("panzhi:SA 123");
    } finally {
      vi.unstubAllGlobals();
    }

    expect(
      fetchMock.mock.calls.map(([input]) => input)
    ).toEqual([
      "/api/listings?view=pool&status=eligible",
      "/api/listings?view=pool&status=eligible&mode=global",
      "/api/listings?view=all&status=eligible",
      "/api/listings?view=all&status=needs_verification",
      "/api/listings?view=all&status=rejected",
      "/api/refresh",
      "/api/refresh-status",
      "/api/scan-history?limit=5",
      "/api/listings/panzhi%3ASA%20123/history?limit=7",
      "/api/listings/panzhi%3ASA%20123/manual-exclusion",
      "/api/listings/panzhi%3ASA%20123/manual-exclusion"
    ]);
    expect(fetchMock.mock.calls[5]?.[1]).toMatchObject({ method: "POST" });
    expect(fetchMock.mock.calls[9]?.[1]).toEqual({
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reason: "price_overvalued",
        note: "同价位更安全"
      })
    });
    expect(fetchMock.mock.calls[10]?.[1]).toEqual({
      method: "DELETE"
    });
  });

  it("forwards abort signals to browser-current and refresh-status requests", async () => {
    const fetchMock = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit
    ) => ({
      ok: true,
      json: async () => null
    }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    try {
      await httpScoutApi.getCurrentJiaoyimaoBrowserRefresh(
        controller.signal
      );
      await httpScoutApi.getRefreshStatus(controller.signal);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      signal: controller.signal
    });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      signal: controller.signal
    });
  });

  it("loads the pool first and switches among four isolated views", async () => {
    const listingsByView = {
      pool: makeViewListings(1, "jiaoyimao"),
      eligible: makeViewListings(2, "panzhi"),
      needs_verification: makeViewListings(3, "pxb7"),
      rejected: makeViewListings(4, "jiaoyimao")
    };
    const api = makeApi({
      getListings: async (view) => listingsByView[view]
    });
    const user = userEvent.setup();

    render(<App api={api} />);

    await waitFor(() =>
      expect(api.getListings).toHaveBeenCalledWith("pool", "balanced")
    );
    expect(
      screen.getByRole("heading", { name: "推荐候选 1 / 30" })
    ).toBeInTheDocument();

    const poolTab = screen.getByRole("tab", { name: "推荐候选" });
    const eligibleTab = screen.getByRole("tab", { name: "全部合格" });
    const needsTab = screen.getByRole("tab", { name: "待人工核验" });
    const rejectedTab = screen.getByRole("tab", { name: "已淘汰" });
    expect(poolTab).toHaveAttribute("aria-selected", "true");

    await user.click(eligibleTab);
    await waitFor(() =>
      expect(api.getListings).toHaveBeenCalledWith(
        "eligible",
        "balanced"
      )
    );
    expect(
      screen.getByRole("heading", { name: "全部合格 2" })
    ).toBeInTheDocument();

    await user.click(needsTab);
    await waitFor(() =>
      expect(api.getListings).toHaveBeenCalledWith(
        "needs_verification",
        "balanced"
      )
    );
    expect(
      screen.getByRole("heading", { name: "待人工核验 3" })
    ).toBeInTheDocument();

    await user.click(rejectedTab);
    await waitFor(() =>
      expect(api.getListings).toHaveBeenCalledWith(
        "rejected",
        "balanced"
      )
    );
    expect(
      screen.getByRole("heading", { name: "已淘汰 4" })
    ).toBeInTheDocument();

    poolTab.focus();
    await user.keyboard("{ArrowRight}");
    await waitFor(() =>
      expect(poolTab).toHaveAttribute("aria-selected", "false")
    );
    expect(eligibleTab).toHaveFocus();
    expect(eligibleTab).toHaveAttribute(
      "aria-controls",
      "listing-view-panel"
    );
  });

  it("uses the balanced pool by default and reloads both endpoints for global mode", async () => {
    const listing = makeListing({
      sourceListingId: "MODE-CANDIDATE"
    });
    const api = makeApi({
      sources: [makeSourceStatus({ source: "panzhi" })],
      getListings: async () => [listing]
    });
    const user = userEvent.setup();

    render(<App api={api} />);

    expect(await screen.findByRole("button", {
      name: /MODE-CANDIDATE/
    })).toBeInTheDocument();
    expect(api.getSources).toHaveBeenCalledWith("balanced");
    expect(api.getListings).toHaveBeenCalledWith("pool", "balanced");

    await user.click(
      screen.getByRole("button", { name: "全局 Top 30" })
    );

    await waitFor(() => {
      expect(api.getSources).toHaveBeenLastCalledWith("global");
      expect(api.getListings).toHaveBeenLastCalledWith("pool", "global");
    });
    expect(
      screen.getByRole("heading", { name: "全局 Top 30 1 / 30" })
    ).toBeInTheDocument();
  });

  it("ignores source and listing data from a stale view request", async () => {
    const oldSources = deferred<SourceStatusView[]>();
    const oldListings = deferred<Listing[]>();
    let sourceRequestCount = 0;
    const currentListing = makeListing({
      key: "panzhi:current-view",
      source: "panzhi",
      sourceListingId: "PZ-CURRENT"
    });
    const api = makeApi({
      getSources: async () => {
        sourceRequestCount += 1;
        return sourceRequestCount === 1
          ? oldSources.promise
          : [
              makeSourceStatus({
                source: "panzhi",
                pagesScanned: 9,
                itemCount: 19
              })
            ];
      },
      getListings: async (view) =>
        view === "pool" ? oldListings.promise : [currentListing]
    });
    const user = userEvent.setup();

    render(<App api={api} />);
    await waitFor(() =>
      expect(api.getListings).toHaveBeenCalledWith("pool", "balanced")
    );
    await user.click(
      screen.getByRole("tab", { name: "全部合格" })
    );

    expect(
      await screen.findByRole("heading", { name: "全部合格 1" })
    ).toBeInTheDocument();
    expect(screen.getByText("9 页")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /PZ-CURRENT.*¥1,888/ })
    ).toBeInTheDocument();

    await act(async () => {
      oldSources.resolve([
        makeSourceStatus({
          source: "jiaoyimao",
          pagesScanned: 1,
          itemCount: 1
        })
      ]);
      oldListings.resolve([
        makeListing({
          key: "jiaoyimao:stale-pool",
          source: "jiaoyimao",
          sourceListingId: "JYM-STALE"
        })
      ]);
    });

    expect(
      screen.getByRole("tab", { name: "全部合格" })
    ).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByRole("heading", { name: "全部合格 1" })
    ).toBeInTheDocument();
    expect(screen.getByText("9 页")).toBeInTheDocument();
    expect(screen.queryByText("1 页")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /PZ-CURRENT.*¥1,888/ })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /JYM-STALE.*¥1,888/ })
    ).not.toBeInTheDocument();
  });

  it("keeps the latest view loading when a stale request fails", async () => {
    const oldListings = deferred<Listing[]>();
    const currentListings = deferred<Listing[]>();
    const currentListing = makeListing({
      key: "panzhi:latest-loading",
      source: "panzhi",
      sourceListingId: "PZ-LATEST"
    });
    const api = makeApi({
      getListings: async (view) =>
        view === "pool" ? oldListings.promise : currentListings.promise
    });
    const user = userEvent.setup();

    render(<App api={api} />);
    await waitFor(() =>
      expect(api.getListings).toHaveBeenCalledWith("pool", "balanced")
    );
    await user.click(
      screen.getByRole("tab", { name: "全部合格" })
    );
    await waitFor(() =>
      expect(api.getListings).toHaveBeenCalledWith(
        "eligible",
        "balanced"
      )
    );

    await act(async () => {
      oldListings.reject(new Error("旧请求失败"));
    });

    expect(
      screen.getByText("正在读取当前视图快照…")
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: "全部合格" })
    ).toHaveAttribute("aria-selected", "true");

    await act(async () => {
      currentListings.resolve([currentListing]);
    });

    expect(
      await screen.findByRole("heading", { name: "全部合格 1" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /PZ-LATEST.*¥1,888/ })
    ).toBeInTheDocument();
  });

  it("keeps the latest detail when an earlier selection resolves last", async () => {
    const listingA = makeListing({
      key: "jiaoyimao:detail-a",
      source: "jiaoyimao",
      sourceListingId: "DETAIL-A"
    });
    const listingB = makeListing({
      key: "panzhi:detail-b",
      source: "panzhi",
      sourceListingId: "DETAIL-B"
    });
    const detailA = deferred<Listing>();
    const detailB = deferred<Listing>();
    const api = makeApi({
      getListings: async () => [listingA, listingB],
      getListing: async (key) =>
        key === listingA.key ? detailA.promise : detailB.promise
    });
    const user = userEvent.setup();

    render(<App api={api} />);
    await user.click(
      await screen.findByRole("button", {
        name: /DETAIL-A.*¥1,888/
      })
    );
    await user.click(
      screen.getByRole("button", {
        name: /DETAIL-B.*¥1,888/
      })
    );

    await act(async () => {
      detailB.resolve(
        makeListing({
          ...listingB,
          totalAssetsM: 777
        })
      );
    });
    const detail = screen.getByRole("complementary", {
      name: "候选详情"
    });
    expect(within(detail).getByText("DETAIL-B")).toBeInTheDocument();
    expect(within(detail).getByText("777M")).toBeInTheDocument();

    await act(async () => {
      detailA.resolve(
        makeListing({
          ...listingA,
          totalAssetsM: 111
        })
      );
    });

    expect(within(detail).getByText("DETAIL-B")).toBeInTheDocument();
    expect(within(detail).getByText("777M")).toBeInTheDocument();
    expect(within(detail).queryByText("111M")).not.toBeInTheDocument();
  });

  it("loads listing history with detail and keeps detail on a history error", async () => {
    const listing = makeListing({
      key: "panzhi:history-detail",
      sourceListingId: "HISTORY-DETAIL",
      totalAssetsM: 777
    });
    const api = makeApi({
      getListings: async () => [listing],
      getListing: async () => listing,
      getListingHistory: async () => {
        throw new Error("历史服务暂不可用");
      }
    });
    const user = userEvent.setup();

    render(<App api={api} />);
    await user.click(
      await screen.findByRole("button", { name: /HISTORY-DETAIL/ })
    );

    const detail = screen.getByRole("complementary", {
      name: "候选详情"
    });
    expect(within(detail).getByText("777M")).toBeInTheDocument();
    expect(within(detail).getByText("历史服务暂不可用"))
      .toBeInTheDocument();
    expect(api.getListingHistory).toHaveBeenCalledWith(listing.key, 20);
  });

  it("keeps the latest detail busy when a stale request rejects", async () => {
    const listingA = makeListing({
      key: "jiaoyimao:stale-detail",
      source: "jiaoyimao",
      sourceListingId: "STALE-DETAIL"
    });
    const listingB = makeListing({
      key: "panzhi:current-detail",
      source: "panzhi",
      sourceListingId: "CURRENT-DETAIL"
    });
    const detailA = deferred<Listing>();
    const detailB = deferred<Listing>();
    const api = makeApi({
      getListings: async () => [listingA, listingB],
      getListing: async (key) =>
        key === listingA.key ? detailA.promise : detailB.promise
    });
    const user = userEvent.setup();

    render(<App api={api} />);
    await user.click(
      await screen.findByRole("button", {
        name: /STALE-DETAIL.*¥1,888/
      })
    );
    await user.click(
      screen.getByRole("button", {
        name: /CURRENT-DETAIL.*¥1,888/
      })
    );
    const detail = screen.getByRole("complementary", {
      name: "候选详情"
    });

    await act(async () => {
      detailA.reject(new Error("旧详情失败"));
    });

    expect(within(detail).getByText("CURRENT-DETAIL")).toBeInTheDocument();
    expect(detail).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await act(async () => {
      detailB.resolve(
        makeListing({
          ...listingB,
          totalAssetsM: 888
        })
      );
    });

    expect(within(detail).getByText("888M")).toBeInTheDocument();
    expect(detail).toHaveAttribute("aria-busy", "false");
  });

  it("does not restore a stale detail after switching views", async () => {
    const listingA = makeListing({
      key: "jiaoyimao:leaving-view",
      source: "jiaoyimao",
      sourceListingId: "LEAVING-VIEW"
    });
    const eligibleListing = makeListing({
      key: "panzhi:eligible-view",
      source: "panzhi",
      sourceListingId: "ELIGIBLE-VIEW"
    });
    const detailA = deferred<Listing>();
    const api = makeApi({
      getListings: async (requestedView) =>
        requestedView === "pool" ? [listingA] : [eligibleListing],
      getListing: async () => detailA.promise
    });
    const user = userEvent.setup();

    render(<App api={api} />);
    await user.click(
      await screen.findByRole("button", {
        name: /LEAVING-VIEW.*¥1,888/
      })
    );
    await user.click(
      screen.getByRole("tab", { name: "全部合格" })
    );
    expect(
      await screen.findByRole("button", {
        name: /ELIGIBLE-VIEW.*¥1,888/
      })
    ).toBeInTheDocument();
    expect(screen.getByText("选择左侧候选")).toBeInTheDocument();

    await act(async () => {
      detailA.reject(new Error("旧详情失败"));
    });

    expect(screen.getByText("选择左侧候选")).toBeInTheDocument();
    expect(screen.queryByText("LEAVING-VIEW")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reconciles the selected detail to a fresh same-key snapshot", async () => {
    const oldListing = makeListing({
      key: "pxb7:same-key",
      source: "pxb7",
      sourceListingId: "SAME-KEY",
      priceCny: 1888,
      totalAssetsM: 100,
      score: {
        ...makeScore(50, {
          m7: 10,
          redSkins: 0,
          julang: 0,
          price: 10,
          assets: 5,
          secondRealName: 20,
          recovery: 0,
          verification: 0
        }),
        reasons: ["旧快照"]
      }
    });
    const freshListing = makeListing({
      ...oldListing,
      priceCny: 2999,
      totalAssetsM: 999,
      score: {
        ...makeScore(95, {
          m7: 20,
          redSkins: 15,
          julang: 20,
          price: 23,
          assets: 9,
          secondRealName: 40,
          recovery: 35,
          verification: 25
        }),
        reasons: ["新快照"]
      }
    });
    const staleDetail = deferred<Listing>();
    let listingRequestCount = 0;
    let refreshStatusCount = 0;
    const api = makeApi({
      getListings: async () => {
        listingRequestCount += 1;
        return listingRequestCount === 1
          ? [oldListing]
          : [freshListing];
      },
      getListing: async () => staleDetail.promise,
      getRefreshStatus: async () => {
        refreshStatusCount += 1;
        return refreshStatusCount === 1
          ? makeRefreshStatus()
          : makeRefreshStatus({
              runId: 3,
              state: "success",
              finishedAt: "2026-07-29T10:00:00.000Z"
            });
      }
    });
    const user = userEvent.setup();

    render(<App api={api} />);
    await user.click(
      await screen.findByRole("button", {
        name: /SAME-KEY.*¥1,888/
      })
    );
    await user.click(
      screen.getByRole("button", { name: "刷新公开数据" })
    );

    expect(
      await screen.findByRole("button", {
        name: /SAME-KEY.*¥2,999/
      })
    ).toBeInTheDocument();
    const detail = screen.getByRole("complementary", {
      name: "候选详情"
    });
    expect(within(detail).getByText("999M")).toBeInTheDocument();
    expect(within(detail).getByText("95")).toBeInTheDocument();

    await act(async () => {
      staleDetail.resolve(
        makeListing({
          ...oldListing,
          totalAssetsM: 111
        })
      );
    });

    expect(within(detail).getByText("999M")).toBeInTheDocument();
    expect(within(detail).queryByText("111M")).not.toBeInTheDocument();
  });

  it("shows the real pool size, source contributions, and account evidence", async () => {
    const listings = [
      ...makeViewListings(10, "jiaoyimao"),
      ...makeViewListings(3, "panzhi"),
      ...makeViewListings(10, "pxb7")
    ];
    listings[0] = makeListing({
      key: "jiaoyimao:evidence",
      source: "jiaoyimao",
      sourceListingId: "JYM-EVIDENCE",
      redSkinCount: 3,
      m7PrismQuality: "S",
      julangStatus: "owned",
      julangQuality: "极品"
    });
    const api = makeApi({
      sources: [
        makeSourceStatus({
          source: "jiaoyimao",
          candidateCount: 10
        }),
        makeSourceStatus({
          source: "panzhi",
          candidateCount: 3
        }),
        makeSourceStatus({
          source: "pxb7",
          candidateCount: 10
        })
      ],
      getListings: async () => listings
    });

    render(<App api={api} />);

    expect(
      await screen.findByRole("heading", {
        name: "推荐候选 23 / 30"
      })
    ).toBeInTheDocument();
    expect(
      screen.getByText("每平台最多 10 · 跨平台统一评分 Top 30")
    ).toBeInTheDocument();
    expect(screen.getByText("交易猫 10")).toBeInTheDocument();
    expect(screen.getByText("盼之 3")).toBeInTheDocument();
    expect(screen.getByText("螃蟹 10")).toBeInTheDocument();

    const row = screen.getByRole("button", {
      name: /JYM-EVIDENCE.*¥1,888/
    });
    expect(within(row).getByText("M7 · 极品S")).toBeInTheDocument();
    expect(within(row).getByText("3 角色红皮")).toBeInTheDocument();
    expect(within(row).getByText("巨浪 · 极品")).toBeInTheDocument();
  });

  it("applies advanced filters only inside the loaded view", async () => {
    const api = makeApi({
      getListings: async () => [
        ...makeViewListings(1, "jiaoyimao"),
        ...makeViewListings(1, "panzhi")
      ]
    });
    const user = userEvent.setup();

    render(<App api={api} />);

    expect(
      await screen.findByRole("heading", {
        name: "推荐候选 2 / 30"
      })
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: /高级筛选/ })
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "来源" }),
      "panzhi"
    );

    expect(
      screen.getByRole("heading", { name: "推荐候选 2 / 30" })
    ).toBeInTheDocument();
    expect(screen.getByText("高级筛选显示 1 / 2")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /JIAOYIMAO-0.*¥1,888/ })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /PANZHI-0.*¥1,888/ })
    ).toBeInTheDocument();
    expect(api.getListings).toHaveBeenCalledTimes(1);
  });

  it("filters by M7 quality, named red skins, evidence, stability, and unknown 巨浪", async () => {
    const target = makeListing({
      key: "panzhi:advanced-target",
      sourceListingId: "ADVANCED-TARGET",
      m7PrismQuality: "S",
      redSkins: ["HackClaw", "威龙", "露娜", "红狼"],
      redSkinCount: 4,
      julangStatus: "unknown",
      scanStability: "stable",
      consecutiveUnchangedScans: 3
    });
    const other = makeListing({
      key: "panzhi:advanced-other",
      sourceListingId: "ADVANCED-OTHER",
      m7PrismQuality: "A",
      redSkins: ["威龙"],
      redSkinCount: 1,
      julangStatus: "owned",
      verificationAt: null,
      scanStability: "changed"
    });
    const user = userEvent.setup();

    render(<App api={makeApi({
      getListings: async () => [target, other]
    })} />);

    expect(await screen.findByRole("button", {
      name: /ADVANCED-TARGET/
    })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /高级筛选/ }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "M7 品质" }),
      "S"
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "最少已识别角色红皮" }),
      "4"
    );
    await user.type(
      screen.getByRole("searchbox", { name: "红皮角色" }),
      " hackclaw "
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "巨浪" }),
      "unknown"
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "证据完整度" }),
      "complete"
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "稳定性" }),
      "stable"
    );

    expect(screen.getByRole("button", {
      name: /ADVANCED-TARGET/
    })).toBeInTheDocument();
    expect(screen.queryByRole("button", {
      name: /ADVANCED-OTHER/
    })).not.toBeInTheDocument();
    expect(screen.getByText("高级筛选显示 1 / 2")).toBeInTheDocument();
  });

  it("sorts candidates by skin value", async () => {
    const highTotal = makeListing({
      key: "panzhi:total-high",
      sourceListingId: "TOTAL-HIGH",
      score: { ...makeScore(95), value: 12 }
    });
    const highSkin = makeListing({
      key: "panzhi:skin-high",
      sourceListingId: "SKIN-HIGH",
      score: { ...makeScore(80), value: 29 }
    });
    const user = userEvent.setup();

    render(<App api={makeApi({
      getListings: async () => [highTotal, highSkin]
    })} />);

    const listingPanel = await screen.findByRole("region", {
      name: "账号候选列表"
    });
    expect(within(listingPanel).getAllByRole("button")[0]).toHaveAccessibleName(
      expect.stringContaining("TOTAL-HIGH")
    );

    await user.selectOptions(
      screen.getByRole("combobox", { name: "候选排序" }),
      "skinValue"
    );
    expect(within(listingPanel).getAllByRole("button")[0]).toHaveAccessibleName(
      expect.stringContaining("SKIN-HIGH")
    );
  });

  it("separates filtered-out results from a truly empty view", async () => {
    const listing = makeListing({
      key: "jiaoyimao:filter-reset",
      source: "jiaoyimao",
      sourceListingId: "JYM-FILTER"
    });
    const api = makeApi({
      getListings: async () => [listing]
    });
    const user = userEvent.setup();

    render(<App api={api} />);
    expect(
      await screen.findByRole("button", {
        name: /JYM-FILTER.*¥1,888/
      })
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: /高级筛选/ })
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "来源" }),
      "panzhi"
    );

    expect(
      screen.getByRole("heading", { name: "筛选后无结果" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "推荐候选暂为空" })
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "清除筛选" })
    );

    expect(
      screen.getByRole("button", { name: /JYM-FILTER.*¥1,888/ })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "筛选后无结果" })
    ).not.toBeInTheDocument();
  });

  it("makes source completeness and retained snapshots explicit", async () => {
    const api = makeApi({
      sources: [
        makeSourceStatus({ source: "jiaoyimao" }),
        makeSourceStatus({
          source: "panzhi",
          state: "failed",
          pagesScanned: 0,
          itemCount: 16,
          eligibleCount: 0,
          candidateCount: 0,
          stopReason: "entry_failed",
          completion: "failed",
          error: "network_error",
          stale: true
        }),
        makeSourceStatus({
          source: "pxb7",
          state: "partial",
          pagesScanned: 2,
          itemCount: 12,
          eligibleCount: 4,
          candidateCount: 4,
          stopReason: "safety_limit",
          completion: "partial"
        })
      ],
      getListings: async () => [makeListing()]
    });

    render(<App api={api} />);

    const complete = (await screen.findByText("交易猫")).closest("article");
    expect(complete).not.toBeNull();
    expect(within(complete!).getByText("完整")).toBeInTheDocument();
    expect(within(complete!).getByText("5 页")).toBeInTheDocument();
    expect(within(complete!).getByText("30 商品")).toBeInTheDocument();
    expect(within(complete!).getByText("3 合格")).toBeInTheDocument();
    expect(within(complete!).getByText("3 入选")).toBeInTheDocument();

    const failed = screen.getByText("盼之代售").closest("article");
    expect(failed).not.toBeNull();
    expect(within(failed!).getByText("本轮 0 页")).toBeInTheDocument();
    expect(
      within(failed!).getByText("保留旧快照 16 条")
    ).toBeInTheDocument();
    expect(
      within(failed!).getByText("不参与当前候选")
    ).toBeInTheDocument();

    const partial = screen.getByText("螃蟹账号").closest("article");
    expect(partial).not.toBeNull();
    expect(within(partial!).getByText("部分完成")).toBeInTheDocument();
    expect(
      within(partial!).getByText("达到安全上限")
    ).toBeInTheDocument();
  });

  it("labels stalled pagination as incomplete", async () => {
    const api = makeApi({
      sources: [
        makeSourceStatus({
          source: "jiaoyimao",
          state: "partial",
          pagesScanned: 2,
          stopReason: "pagination_stalled",
          completion: "partial"
        })
      ]
    });

    render(<App api={api} />);

    const source = (await screen.findByText("交易猫")).closest("article");
    expect(source).not.toBeNull();
    expect(within(source!).getByText("部分完成")).toBeInTheDocument();
    expect(
      within(source!).getByText("分页未推进，结果不完整")
    ).toBeInTheDocument();
  });

  it("explains a quarantined volume drop without replacing trusted counts", async () => {
    const api = makeApi({
      sources: [
        makeSourceStatus({
          source: "panzhi",
          state: "partial",
          completion: "partial",
          pagesScanned: 5,
          itemCount: 44,
          stopReason: "anomaly_guard",
          error: "数据骤降待确认",
          anomaly: {
            state: "suspect",
            baselineItemCount: 44,
            baselinePagesScanned: 5,
            observedItemCount: 10,
            observedPagesScanned: 1,
            confirmationCount: 1,
            firstDetectedAt: "2026-07-29T10:00:00.000Z",
            lastDetectedAt: "2026-07-29T10:00:00.000Z",
            reason: "items_and_pages_drop"
          }
        })
      ]
    });

    render(<App api={api} />);

    const source = (await screen.findByText("盼之代售")).closest("article");
    expect(source).not.toBeNull();
    expect(within(source!).getByText("数据骤降待确认")).toBeInTheDocument();
    expect(within(source!).getByText("本轮观测 10 条 / 1 页"))
      .toBeInTheDocument();
    expect(within(source!).getByText("继续使用可信快照 44 条 / 5 页"))
      .toBeInTheDocument();
    expect(within(source!).getByText("等待下一次完整扫描确认"))
      .toBeInTheDocument();
  });

  it("loads source states and opens complete candidate evidence", async () => {
    const listing = makeListing({
      key: "panzhi:SA2PEAK",
      sourceListingId: "SA2PEAK",
      priceCny: 5560,
      m7PrismQuality: "A",
      redSkins: ["威龙", "骇爪", "红狼"],
      redSkinCount: 3,
      totalAssetsM: 482,
      hafCoins: 31_880_000,
      julangStatus: "owned",
      julangQuality: "极品",
      recoveryCoverage: false,
      score: {
        ...makeScore(87, {
          m7: 17,
          redSkins: 15,
          julang: 20,
          price: 20,
          assets: 8,
          secondRealName: 40,
          recovery: 0,
          verification: 15
        }),
        reasons: ["安全信息 28.0/30", "价格合理性 16.0/20"]
      }
    });
    const api: ScoutApi = {
      ...makeApi(),
      getSources: vi.fn(async (): Promise<SourceStatusView[]> => [
        {
          ...makeSourceStatus({ source: "jiaoyimao" }),
          state: "blocked",
          lastAttemptAt: "2026-07-28T10:00:00.000Z",
          lastSuccessAt: null,
          pagesScanned: 0,
          itemCount: 0,
          eligibleCount: 0,
          candidateCount: 0,
          stopReason: "captcha_required",
          completion: "blocked",
          error: "captcha_required",
          stale: false
        },
        {
          ...makeSourceStatus({ source: "panzhi" }),
          state: "success",
          lastAttemptAt: "2026-07-28T10:00:00.000Z",
          lastSuccessAt: "2026-07-28T10:00:00.000Z",
          itemCount: 10,
          error: null,
          stale: false
        },
        {
          ...makeSourceStatus({ source: "pxb7" }),
          state: "blocked",
          lastAttemptAt: "2026-07-28T10:00:00.000Z",
          lastSuccessAt: null,
          pagesScanned: 0,
          itemCount: 0,
          eligibleCount: 0,
          candidateCount: 0,
          stopReason: "unverified_structure",
          completion: "blocked",
          error: "unverified_structure",
          stale: false
        }
      ]),
      getListings: vi.fn(async () => [asReviewedListing(listing)]),
      getListing: vi.fn(async () => asReviewedListing(listing)),
      getListingHistory: vi.fn(async () => ({
        key: listing.key,
        source: listing.source,
        availability: "active" as const,
        lastSeenAt: listing.capturedAt,
        observations: []
      })),
      startRefresh: vi.fn(async () => ({
        runId: 1,
        state: "running" as const
      })),
      getRefreshStatus: vi.fn(async () => makeRefreshStatus()),
      getScanHistory: vi.fn(async () => ({ runs: [] }))
    };

    render(<App api={api} />);

    expect(await screen.findByText("验证码阻塞")).toBeInTheDocument();
    expect(screen.getByText("列表待人工接入")).toBeInTheDocument();
    const row = screen.getByRole("button", {
      name: /SA2PEAK.*¥5,560/
    });
    expect(within(row).getByText("3 角色红皮")).toBeInTheDocument();
    expect(within(row).getByText("M7 · 极品A")).toBeInTheDocument();
    expect(within(row).getByText("巨浪 · 极品")).toBeInTheDocument();
    expect(within(row).getByText("482M")).toBeInTheDocument();
    expect(within(row).getByText("87")).toBeInTheDocument();

    await userEvent.click(row);
    const detail = await screen.findByRole("complementary", {
      name: "候选详情"
    });
    expect(
      within(detail).getByText("M7 棱镜攻势 · 极品A")
    ).toBeInTheDocument();
    expect(within(detail).getByText("威龙 · 骇爪 · 红狼")).toBeInTheDocument();
    expect(within(detail).getByText("31,880,000")).toBeInTheDocument();
    expect(detail.querySelector("blockquote")).toHaveTextContent(
      "M7 棱镜攻势 极品"
    );
    expect(
      within(detail).getByRole("link", { name: "前往盼之核验" })
    ).toHaveAttribute("target", "_blank");
  });

  it("shows an empty message for the selected view", async () => {
    const api = makeApi();
    const user = userEvent.setup();
    render(<App api={api} />);

    await user.click(
      await screen.findByRole("tab", { name: "全部合格" })
    );
    expect(
      await screen.findByText(
        "当前快照中没有满足 QQ 官服、¥6,000 以内与 M7 棱镜攻势极品或优品 S 条件的账号。"
      )
    ).toBeInTheDocument();

    await user.click(
      await screen.findByRole("tab", { name: "已淘汰" })
    );

    expect(
      await screen.findByRole("heading", {
        name: "已淘汰视图暂无记录"
      })
    ).toBeInTheDocument();
  });

  it("shows request errors without also claiming the view is empty", async () => {
    const api = makeApi({
      getListings: async () => {
        throw new Error("读取候选失败");
      }
    });

    render(<App api={api} />);

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("读取候选失败")).toBeInTheDocument();
    expect(
      within(alert).getByRole("button", { name: "重试" })
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("空候选")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "推荐候选暂为空" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("正在读取当前视图快照…")
    ).not.toBeInTheDocument();
  });

  it("resumes a running refresh on startup and displays live progress", async () => {
    const api = makeApi({
      getRefreshStatus: async () =>
        makeRefreshStatus({
          runId: 7,
          state: "running",
          source: "jiaoyimao",
          phase: "detail",
          page: 2,
          summaries: 10,
          details: 6,
          message: "正在读取商品详情"
        })
    });

    render(<App api={api} />);

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("交易猫");
    expect(status).toHaveTextContent("详情");
    expect(status).toHaveTextContent("第 2 页");
    expect(status).toHaveTextContent("10 商品");
    expect(status).toHaveTextContent("6 详情");
    expect(
      screen.getAllByRole("button", { name: /正在刷新/ })[0]
    ).toBeDisabled();
  });

  it("discovers an externally started refresh and reloads its new snapshot", async () => {
    vi.useFakeTimers();
    try {
      let statusCall = 0;
      let listingCall = 0;
      const oldListing = makeListing({
        key: "panzhi:external-old",
        sourceListingId: "EXTERNAL-OLD"
      });
      const freshListing = makeListing({
        key: "panzhi:external-new",
        sourceListingId: "EXTERNAL-NEW"
      });
      const api = makeApi({
        getListings: async () => {
          listingCall += 1;
          return listingCall === 1 ? [oldListing] : [freshListing];
        },
        getRefreshStatus: async () => {
          statusCall += 1;
          if (statusCall === 1) {
            return makeRefreshStatus({
              runId: 20,
              state: "success",
              finishedAt: "2026-07-29T09:00:00.000Z",
              lastSnapshotAt: "2026-07-29T09:00:00.000Z"
            });
          }
          if (statusCall === 2) {
            return makeRefreshStatus({
              runId: 21,
              state: "running",
              source: "pxb7",
              phase: "list",
              page: 2,
              summaries: 18,
              lastSnapshotAt: "2026-07-29T09:00:00.000Z"
            });
          }
          return makeRefreshStatus({
            runId: 21,
            state: "success",
            finishedAt: "2026-07-29T10:00:00.000Z",
            lastSnapshotAt: "2026-07-29T10:00:00.000Z"
          });
        }
      });

      render(<App api={api} />);
      await act(async () => undefined);
      expect(screen.getByRole("button", {
        name: /EXTERNAL-OLD/
      })).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(screen.getByRole("status")).toHaveTextContent("螃蟹账号");
      expect(screen.getByRole("status")).toHaveTextContent("18 商品");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(screen.getByRole("button", {
        name: /EXTERNAL-NEW/
      })).toBeInTheDocument();
      expect(api.startRefresh).not.toHaveBeenCalled();
      expect(api.getListings).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("checks on focus, preserves UI state, and ignores an unchanged snapshot", async () => {
    let latestStatus = makeRefreshStatus({
      runId: 30,
      state: "success",
      finishedAt: "2026-07-29T09:00:00.000Z",
      lastSnapshotAt: "2026-07-29T09:00:00.000Z"
    });
    const api = makeApi({
      getListings: async () => [makeListing()],
      getRefreshStatus: async () => latestStatus
    });
    const user = userEvent.setup();
    render(<App api={api} />);
    await screen.findByRole("button", { name: /SA123/ });
    await user.click(
      screen.getByRole("button", { name: "全局 Top 30" })
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "候选排序" }),
      "price"
    );
    const callsBeforeFocus = vi.mocked(api.getListings).mock.calls.length;

    window.dispatchEvent(new Event("focus"));
    await act(async () => undefined);
    expect(api.getListings).toHaveBeenCalledTimes(callsBeforeFocus);

    latestStatus = makeRefreshStatus({
      runId: 31,
      state: "success",
      finishedAt: "2026-07-29T10:00:00.000Z",
      lastSnapshotAt: "2026-07-29T10:00:00.000Z"
    });
    window.dispatchEvent(new Event("focus"));
    await waitFor(() =>
      expect(api.getListings).toHaveBeenCalledTimes(callsBeforeFocus + 1)
    );
    expect(api.getListings).toHaveBeenLastCalledWith("pool", "global");
    expect(
      screen.getByRole("combobox", { name: "候选排序" })
    ).toHaveValue("price");

    window.dispatchEvent(new Event("focus"));
    await act(async () => undefined);
    expect(api.getListings).toHaveBeenCalledTimes(callsBeforeFocus + 1);
  });

  it("uses a BroadcastChannel message to discover an external refresh immediately", async () => {
    let channel:
      | {
          onmessage: ((event: MessageEvent) => void) | null;
        }
      | undefined;
    class BroadcastChannelStub {
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(readonly name: string) {
        channel = this;
      }
      postMessage() {}
      close() {}
    }
    vi.stubGlobal("BroadcastChannel", BroadcastChannelStub);
    let latestStatus = makeRefreshStatus({
      runId: 40,
      state: "success",
      lastSnapshotAt: "2026-07-29T09:00:00.000Z"
    });
    const api = makeApi({
      getRefreshStatus: async () => latestStatus
    });
    try {
      render(<App api={api} />);
      await act(async () => undefined);
      const callsBeforeMessage = vi.mocked(api.getRefreshStatus).mock.calls
        .length;
      latestStatus = makeRefreshStatus({
        runId: 41,
        state: "running",
        source: "jiaoyimao",
        phase: "list",
        page: 4,
        summaries: 35,
        lastSnapshotAt: "2026-07-29T09:00:00.000Z"
      });

      await act(async () => {
        channel?.onmessage?.(new MessageEvent("message"));
      });

      expect(api.getRefreshStatus).toHaveBeenCalledTimes(
        callsBeforeMessage + 1
      );
      expect(screen.getByRole("status")).toHaveTextContent("交易猫");
      expect(screen.getByRole("status")).toHaveTextContent("第 4 页");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("excludes a reviewed account, reloads the active pool, and broadcasts the decision", async () => {
    const posts: unknown[] = [];
    class BroadcastChannelStub {
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(readonly name: string) {}
      postMessage(message: unknown) {
        posts.push(message);
      }
      close() {}
    }
    vi.stubGlobal("BroadcastChannel", BroadcastChannelStub);
    const listing = asReviewedListing(
      makeListing({
        key: "panzhi:manual-1",
        sourceListingId: "MANUAL-1"
      })
    );
    let pool: ReviewedListing[] = [listing];
    let rejected: ReviewedListing[] = [];
    const api = makeApi({
      getListings: async (requestedView) =>
        requestedView === "rejected" ? rejected : pool,
      getListing: async () => listing,
      excludeListing: async (key, input) => {
        const excluded: ReviewedListing = {
          ...listing,
          manualReview: {
            excluded: true,
            reason: input.reason,
            note: input.note,
            reviewedAt: "2026-07-31T08:00:00.000Z"
          }
        };
        pool = [];
        rejected = [excluded];
        return excluded;
      }
    });
    const user = userEvent.setup();

    try {
      render(<App api={api} />);
      await user.click(
        await screen.findByRole("button", { name: /MANUAL-1/ })
      );
      await user.click(
        screen.getByRole("button", { name: "人工淘汰" })
      );
      const dialog = screen.getByRole("dialog", {
        name: "人工淘汰账号"
      });
      await user.click(
        within(dialog).getByRole("radio", { name: "价格虚高" })
      );
      await user.type(
        within(dialog).getByRole("textbox", {
          name: "补充说明（选填）"
        }),
        "  同价位更安全  "
      );
      await user.click(
        within(dialog).getByRole("button", { name: "确认淘汰" })
      );

      await waitFor(() =>
        expect(api.excludeListing).toHaveBeenCalledWith(
          listing.key,
          {
            reason: "price_overvalued",
            note: "同价位更安全"
          }
        )
      );
      expect(
        await screen.findByText(
          "已淘汰 MANUAL-1，不再参与候选排名"
        )
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("dialog", { name: "人工淘汰账号" })
      ).not.toBeInTheDocument();
      expect(screen.getByText("选择左侧候选")).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /MANUAL-1/ })
      ).not.toBeInTheDocument();
      expect(api.getSources).toHaveBeenCalledTimes(2);
      expect(api.getListings).toHaveBeenCalledTimes(2);
      expect(posts).toContainEqual({
        type: "listing-review-changed",
        key: listing.key
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the account and completed exclusion form visible when the mutation fails", async () => {
    const listing = asReviewedListing(
      makeListing({
        key: "panzhi:manual-error",
        sourceListingId: "MANUAL-ERROR"
      })
    );
    const api = makeApi({
      getListings: async () => [listing],
      getListing: async () => listing,
      excludeListing: async () => {
        throw new Error("人工淘汰操作失败，请稍后重试");
      }
    });
    const user = userEvent.setup();
    render(<App api={api} />);

    await user.click(
      await screen.findByRole("button", { name: /MANUAL-ERROR/ })
    );
    await user.click(
      screen.getByRole("button", { name: "人工淘汰" })
    );
    const dialog = screen.getByRole("dialog", {
      name: "人工淘汰账号"
    });
    await user.click(
      within(dialog).getByRole("radio", { name: "卖家问题" })
    );
    await user.type(
      within(dialog).getByRole("textbox", {
        name: "补充说明（选填）"
      }),
      "描述前后不一致"
    );
    await user.click(
      within(dialog).getByRole("button", { name: "确认淘汰" })
    );

    expect(
      await within(dialog).findByRole("alert")
    ).toHaveTextContent("人工淘汰操作失败，请稍后重试");
    expect(
      within(dialog).getByRole("radio", { name: "卖家问题" })
    ).toBeChecked();
    expect(
      within(dialog).getByRole("textbox", {
        name: "补充说明（选填）"
      })
    ).toHaveValue("描述前后不一致");
    expect(
      screen.getByRole("button", { name: /MANUAL-ERROR/ })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("complementary", { name: "候选详情" })
    ).toHaveTextContent("MANUAL-ERROR");
  });

  it("restores a manually excluded account from the rejected view", async () => {
    const listing: ReviewedListing = {
      ...makeListing({
        key: "panzhi:manual-2",
        sourceListingId: "MANUAL-2"
      }),
      manualReview: {
        excluded: true,
        reason: "assets_low",
        note: "资产不够",
        reviewedAt: "2026-07-31T08:00:00.000Z"
      }
    };
    let rejected: ReviewedListing[] = [listing];
    const api = makeApi({
      getListings: async (requestedView) =>
        requestedView === "rejected" ? rejected : [],
      getListing: async () => listing,
      restoreListing: async () => {
        rejected = [];
        return {
          ...listing,
          manualReview: null
        };
      }
    });
    const user = userEvent.setup();
    render(<App api={api} />);

    await user.click(
      await screen.findByRole("tab", { name: "已淘汰" })
    );
    await user.click(
      await screen.findByRole("button", { name: /MANUAL-2/ })
    );
    await user.click(
      screen.getByRole("button", { name: "恢复参与排名" })
    );

    await waitFor(() =>
      expect(api.restoreListing).toHaveBeenCalledWith(listing.key)
    );
    expect(
      await screen.findByText(
        "已恢复 MANUAL-2，将按原评分重新参与排名"
      )
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: "已淘汰视图暂无记录"
      })
    ).toBeInTheDocument();
    expect(screen.getByText("选择左侧候选")).toBeInTheDocument();
  });

  it("keeps a reviewed account open when restoring it fails", async () => {
    const listing: ReviewedListing = {
      ...makeListing({
        key: "panzhi:restore-error",
        sourceListingId: "RESTORE-ERROR"
      }),
      manualReview: {
        excluded: true,
        reason: "safety_risk",
        note: null,
        reviewedAt: "2026-07-31T08:00:00.000Z"
      }
    };
    const api = makeApi({
      getListings: async (requestedView) =>
        requestedView === "rejected" ? [listing] : [],
      getListing: async () => listing,
      restoreListing: async () => {
        throw new Error("恢复失败，请稍后重试");
      }
    });
    const user = userEvent.setup();
    render(<App api={api} />);

    await user.click(
      await screen.findByRole("tab", { name: "已淘汰" })
    );
    await user.click(
      await screen.findByRole("button", { name: /RESTORE-ERROR/ })
    );
    await user.click(
      screen.getByRole("button", { name: "恢复参与排名" })
    );

    const detail = screen.getByRole("complementary", {
      name: "候选详情"
    });
    expect(
      await within(detail).findByRole("alert")
    ).toHaveTextContent("恢复失败，请稍后重试");
    expect(
      within(detail).getByRole("button", {
        name: "恢复参与排名"
      })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /RESTORE-ERROR/ })
    ).toBeInTheDocument();
  });

  it("reloads review decisions from another tab without clearing the current pool first", async () => {
    let channel:
      | {
          onmessage: ((event: MessageEvent) => void) | null;
        }
      | undefined;
    class BroadcastChannelStub {
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(readonly name: string) {
        channel = this;
      }
      postMessage() {}
      close() {}
    }
    vi.stubGlobal("BroadcastChannel", BroadcastChannelStub);
    const listing = asReviewedListing(
      makeListing({
        key: "panzhi:external-review",
        sourceListingId: "EXTERNAL-REVIEW"
      })
    );
    const externalReload =
      deferred<Array<Listing | ReviewedListing>>();
    let listingCalls = 0;
    const api = makeApi({
      getListings: async () => {
        listingCalls += 1;
        return listingCalls === 1
          ? [listing]
          : externalReload.promise;
      }
    });

    try {
      render(<App api={api} />);
      const row = await screen.findByRole("button", {
        name: /EXTERNAL-REVIEW/
      });

      act(() => {
        channel?.onmessage?.(
          new MessageEvent("message", {
            data: {
              type: "listing-review-changed",
              key: listing.key
            }
          })
        );
      });
      await waitFor(() =>
        expect(api.getListings).toHaveBeenCalledTimes(2)
      );
      expect(row).toBeInTheDocument();

      externalReload.resolve([]);
      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: /EXTERNAL-REVIEW/ })
        ).not.toBeInTheDocument()
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refreshes the selected account history after an external snapshot", async () => {
    const listing = makeListing({
      key: "panzhi:history-sync",
      sourceListingId: "HISTORY-SYNC"
    });
    let latestStatus = makeRefreshStatus({
      runId: 50,
      state: "success",
      lastSnapshotAt: "2026-07-29T09:00:00.000Z"
    });
    let historyCall = 0;
    const api = makeApi({
      getListings: async () => [listing],
      getListing: async () => listing,
      getListingHistory: async () => {
        historyCall += 1;
        const priceCny = historyCall === 1 ? 5_500 : 5_200;
        return {
          key: listing.key,
          source: listing.source,
          availability: "active" as const,
          lastSeenAt:
            historyCall === 1
              ? "2026-07-29T09:00:00.000Z"
              : "2026-07-29T10:00:00.000Z",
          observations: [
            {
              runId: historyCall,
              observedAt:
                historyCall === 1
                  ? "2026-07-29T09:00:00.000Z"
                  : "2026-07-29T10:00:00.000Z",
              availability: "active" as const,
              priceCny,
              snapshot: {
                ...buildListingHistorySnapshot(listing),
                priceCny
              },
              changes: []
            }
          ]
        };
      },
      getRefreshStatus: async () => latestStatus
    });
    const user = userEvent.setup();
    render(<App api={api} />);
    await user.click(
      await screen.findByRole("button", { name: /HISTORY-SYNC/ })
    );
    expect(await screen.findByText("¥5,500")).toBeInTheDocument();

    latestStatus = makeRefreshStatus({
      runId: 51,
      state: "success",
      lastSnapshotAt: "2026-07-29T10:00:00.000Z"
    });
    window.dispatchEvent(new Event("focus"));

    expect(await screen.findByText("¥5,200")).toBeInTheDocument();
    expect(api.getListingHistory).toHaveBeenCalledTimes(2);
  });

  it("closes a selected account that disappears from the latest snapshot", async () => {
    const listing = makeListing({
      key: "panzhi:removed-on-sync",
      sourceListingId: "REMOVED-ON-SYNC"
    });
    let latestStatus = makeRefreshStatus({
      runId: 60,
      state: "success",
      lastSnapshotAt: "2026-07-29T09:00:00.000Z"
    });
    let listingCall = 0;
    const api = makeApi({
      getListings: async () => {
        listingCall += 1;
        return listingCall === 1 ? [listing] : [];
      },
      getListing: async () => listing,
      getRefreshStatus: async () => latestStatus
    });
    const user = userEvent.setup();
    render(<App api={api} />);
    await user.click(
      await screen.findByRole("button", { name: /REMOVED-ON-SYNC/ })
    );
    expect(screen.getByRole("complementary", {
      name: "候选详情"
    })).toHaveTextContent("REMOVED-ON-SYNC");

    latestStatus = makeRefreshStatus({
      runId: 61,
      state: "success",
      lastSnapshotAt: "2026-07-29T10:00:00.000Z"
    });
    window.dispatchEvent(new Event("focus"));

    expect(
      await screen.findByText("该账号已不在最新在售快照")
    ).toBeInTheDocument();
    expect(screen.getByRole("complementary", {
      name: "候选详情"
    })).toHaveTextContent("选择左侧候选");
  });

  it("starts a background refresh, reloads on success, and clears progress", async () => {
    vi.useFakeTimers();
    try {
      let statusCall = 0;
      const api = makeApi({
        getRefreshStatus: async () => {
          statusCall += 1;
          if (statusCall === 1) return makeRefreshStatus();
          if (statusCall === 2) {
            return makeRefreshStatus({
              runId: 8,
              state: "running",
              source: "panzhi",
              phase: "list",
              page: 3,
              summaries: 20
            });
          }
          return makeRefreshStatus({
            runId: 8,
            state: "success",
            finishedAt: "2026-07-29T10:00:00.000Z"
          });
        }
      });

      render(<App api={api} />);
      await act(async () => undefined);
      fireEvent.click(
        screen.getByRole("button", { name: "刷新公开数据" })
      );
      await act(async () => undefined);

      expect(api.startRefresh).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("status")).toHaveTextContent("盼之代售");
      expect(screen.getByRole("status")).toHaveTextContent("第 3 页");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });

      expect(api.getSources).toHaveBeenCalledTimes(2);
      expect(api.getListings).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "刷新公开数据" })
      ).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reloads after a partial refresh and reports incomplete sources", async () => {
    let statusCall = 0;
    const api = makeApi({
      getRefreshStatus: async () => {
        statusCall += 1;
        return statusCall === 1
          ? makeRefreshStatus()
          : makeRefreshStatus({
              runId: 9,
              state: "partial",
              error: "螃蟹列表结构待核验",
              finishedAt: "2026-07-29T10:00:00.000Z"
            });
      }
    });

    render(<App api={api} />);
    await screen.findByRole("button", { name: "刷新公开数据" });
    fireEvent.click(
      screen.getByRole("button", { name: "刷新公开数据" })
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "部分来源未完整刷新"
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "螃蟹列表结构待核验"
    );
    await waitFor(() =>
      expect(api.getListings).toHaveBeenCalledTimes(2)
    );
  });

  it("stops on failed status while preserving candidates and selected detail", async () => {
    const listing = makeListing({
      sourceListingId: "PRESERVED",
      totalAssetsM: 777
    });
    let statusCall = 0;
    const api = makeApi({
      getListings: async () => [listing],
      getListing: async () => listing,
      getRefreshStatus: async () => {
        statusCall += 1;
        return statusCall === 1
          ? makeRefreshStatus()
          : makeRefreshStatus({
              runId: 10,
              state: "failed",
              error: "统一评分失败",
              finishedAt: "2026-07-29T10:00:00.000Z"
            });
      }
    });
    const user = userEvent.setup();

    render(<App api={api} />);
    const row = await screen.findByRole("button", { name: /PRESERVED/ });
    await user.click(row);
    expect(
      within(screen.getByRole("complementary", {
        name: "候选详情"
      })).getByText("777M")
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "刷新公开数据" })
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "刷新失败，正在展示上次有效快照"
    );
    expect(screen.getByRole("alert")).toHaveTextContent("统一评分失败");
    expect(screen.getByRole("button", { name: /PRESERVED/ }))
      .toBeInTheDocument();
    expect(
      within(screen.getByRole("complementary", {
        name: "候选详情"
      })).getByText("777M")
    ).toBeInTheDocument();
    expect(api.getListings).toHaveBeenCalledTimes(1);
  });

  it("backs off status transport failures without clearing old data", async () => {
    vi.useFakeTimers();
    try {
      const listing = makeListing({ sourceListingId: "STILL-HERE" });
      let statusCall = 0;
      const api = makeApi({
        getListings: async () => [listing],
        getRefreshStatus: async () => {
          statusCall += 1;
          if (statusCall === 1) return makeRefreshStatus();
          if (statusCall <= 5) throw new Error("进度接口不可达");
          return makeRefreshStatus({
            runId: 11,
            state: "success",
            finishedAt: "2026-07-29T10:00:00.000Z"
          });
        }
      });

      render(<App api={api} />);
      await act(async () => undefined);
      expect(screen.getByRole("button", {
        name: /STILL-HERE/
      })).toBeInTheDocument();
      fireEvent.click(
        screen.getByRole("button", { name: "刷新公开数据" })
      );
      await act(async () => undefined);

      for (let index = 0; index < 3; index += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_000);
        });
      }

      expect(screen.getByRole("alert")).toHaveTextContent(
        "无法读取刷新进度，任务可能仍在后台运行"
      );
      expect(screen.getByRole("button", { name: /STILL-HERE/ }))
        .toBeInTheDocument();
      const callsAtBackoff = vi.mocked(api.getRefreshStatus).mock.calls.length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_999);
      });
      expect(api.getRefreshStatus).toHaveBeenCalledTimes(callsAtBackoff);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });

      expect(api.getListings).toHaveBeenCalledTimes(2);
      expect(screen.queryByText(
        "无法读取刷新进度，任务可能仍在后台运行"
      )).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("browser refresh discovers on load and focus, polling active jobs at 1s and idle at 5s", async () => {
    vi.useFakeTimers();
    try {
      let currentCall = 0;
      const active = makeBrowserRefreshJob();
      const success = makeBrowserRefreshJob({
        state: "success",
        stage: "success",
        updatedAt: "2026-07-31T01:02:00.000Z",
        finishedAt: "2026-07-31T01:02:00.000Z",
        publishedRunId: 71,
        scanRunId: 71
      });
      const api = makeApi({
        sources: [makeSourceStatus({ source: "jiaoyimao" })],
        getListings: async () => [makeListing()],
        getCurrentJiaoyimaoBrowserRefresh: async () => {
          currentCall += 1;
          return currentCall === 1 ? active : success;
        }
      });

      render(<App api={api} />);
      await act(async () => undefined);

      expect(screen.getByTestId("browser-refresh-state"))
        .toHaveTextContent("正在采集列表");
      expect(screen.getByRole("button", {
        name: "刷新公开数据"
      })).toBeDisabled();
      expect(api.getCurrentJiaoyimaoBrowserRefresh)
        .toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(999);
      });
      expect(api.getCurrentJiaoyimaoBrowserRefresh)
        .toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(screen.getByTestId("browser-refresh-state"))
        .toHaveTextContent("刷新完成");
      expect(screen.getByRole("button", {
        name: "刷新公开数据"
      })).toBeEnabled();

      const callsAtTerminal =
        vi.mocked(api.getCurrentJiaoyimaoBrowserRefresh).mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_999);
      });
      expect(api.getCurrentJiaoyimaoBrowserRefresh)
        .toHaveBeenCalledTimes(callsAtTerminal);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(api.getCurrentJiaoyimaoBrowserRefresh)
        .toHaveBeenCalledTimes(callsAtTerminal + 1);

      window.dispatchEvent(new Event("focus"));
      await act(async () => undefined);
      expect(api.getCurrentJiaoyimaoBrowserRefresh)
        .toHaveBeenCalledTimes(callsAtTerminal + 2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("browser refresh exposes an entry only on JYM and blocks it during all-source refresh", async () => {
    const api = makeApi({
      sources: [
        makeSourceStatus({ source: "jiaoyimao" }),
        makeSourceStatus({ source: "panzhi" }),
        makeSourceStatus({ source: "pxb7" })
      ],
      getRefreshStatus: async () =>
        makeRefreshStatus({
          runId: 81,
          state: "running",
          source: "panzhi",
          phase: "list"
        })
    });

    render(<App api={api} />);

    const jymCard = (await screen.findByText("交易猫")).closest("article");
    const panzhiCard = screen.getByText("盼之代售").closest("article");
    const pxbCard = screen.getByText("螃蟹账号").closest("article");
    expect(jymCard).not.toBeNull();
    expect(within(jymCard!).getByRole("button", {
      name: /刷新交易猫/
    })).toBeDisabled();
    expect(within(panzhiCard!).queryByRole("button", {
      name: /刷新交易猫/
    })).not.toBeInTheDocument();
    expect(within(pxbCard!).queryByRole("button", {
      name: /刷新交易猫/
    })).not.toBeInTheDocument();
    expect(within(screen.getByRole("region", {
      name: "交易猫浏览器刷新"
    })).getByRole("button", {
      name: "刷新交易猫"
    })).toBeDisabled();
  });

  it("browser refresh applies a successful start response without waiting for another current read", async () => {
    const awaiting = makeBrowserRefreshJob({
      state: "awaiting_codex",
      stage: "awaiting_codex",
      claimedAt: null,
      listBatchCursor: 0,
      uniqueItemCount: 0,
      itemCount: 0,
      loadActionCount: 0
    });
    const api = makeApi({
      sources: [makeSourceStatus({ source: "jiaoyimao" })],
      getCurrentJiaoyimaoBrowserRefresh: async () => null,
      startJiaoyimaoBrowserRefresh: async () => ({
        jobId: awaiting.id,
        state: "awaiting_codex",
        claimCode: "START-ONLY-CODE",
        expiresAt: awaiting.expiresAt
      })
    });
    const user = userEvent.setup();

    render(<App api={api} />);
    const panel = await screen.findByRole("region", {
      name: "交易猫浏览器刷新"
    });
    await user.click(within(panel).getByRole("button", {
      name: "刷新交易猫"
    }));

    expect(within(panel).getByTestId("browser-refresh-state"))
      .toHaveTextContent("等待 Codex 接管");
    expect(within(panel).getByText("START-ONLY-CODE"))
      .toBeInTheDocument();
    expect(api.getCurrentJiaoyimaoBrowserRefresh)
      .toHaveBeenCalledTimes(1);
  });

  it("browser refresh times out an uncertain start and reconciles a redacted created job without retrying", async () => {
    vi.useFakeTimers();
    const awaiting = makeBrowserRefreshJob({
      state: "awaiting_codex",
      stage: "awaiting_codex",
      claimedAt: null
    });
    const startSignals: AbortSignal[] = [];
    const reconcileSignals: AbortSignal[] = [];
    let currentCall = 0;
    const api = makeApi({
      sources: [makeSourceStatus({ source: "jiaoyimao" })],
      getCurrentJiaoyimaoBrowserRefresh: async (signal) => {
        currentCall += 1;
        if (currentCall === 1) return null;
        if (signal) reconcileSignals.push(signal);
        return awaiting;
      },
      getRefreshStatus: async (signal) => {
        if (signal) reconcileSignals.push(signal);
        return makeRefreshStatus();
      },
      startJiaoyimaoBrowserRefresh: async (signal) => {
        if (signal) startSignals.push(signal);
        return new Promise(() => undefined);
      }
    });

    try {
      render(<App api={api} />);
      await act(async () => undefined);
      const panel = screen.getByRole("region", {
        name: "交易猫浏览器刷新"
      });
      const statusCallsBeforeStart =
        vi.mocked(api.getRefreshStatus).mock.calls.length;
      fireEvent.click(within(panel).getByRole("button", {
        name: "刷新交易猫"
      }));
      expect(panel).toHaveAttribute("aria-busy", "true");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_000);
      });

      expect(startSignals).toHaveLength(1);
      expect(startSignals[0]?.aborted).toBe(true);
      expect(api.startJiaoyimaoBrowserRefresh).toHaveBeenCalledTimes(1);
      expect(api.getCurrentJiaoyimaoBrowserRefresh)
        .toHaveBeenCalledTimes(2);
      expect(api.getRefreshStatus)
        .toHaveBeenCalledTimes(statusCallsBeforeStart + 1);
      expect(reconcileSignals).toHaveLength(2);
      expect(panel).toHaveAttribute("aria-busy", "false");
      expect(within(panel).getByTestId("browser-refresh-state"))
        .toHaveTextContent("等待 Codex 接管");
      expect(within(panel).getByText("接管码已隐藏"))
        .toBeInTheDocument();
      expect(within(panel).getByRole("alert"))
        .toHaveTextContent("一次性接管码无法恢复");
      expect(within(panel).getByRole("button", {
        name: "取消本次刷新"
      })).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("browser refresh recovers an active job after a create conflict without clearing candidates", async () => {
    const listing = makeListing({ sourceListingId: "CONFLICT-KEPT" });
    let currentCall = 0;
    const active = makeBrowserRefreshJob({
      state: "collecting_details",
      stage: "details"
    });
    let current = active;
    const api = makeApi({
      sources: [makeSourceStatus({ source: "jiaoyimao" })],
      getListings: async () => [listing],
      getRefreshStatus: async () =>
        makeRefreshStatus({
          runId: 81,
          state: "success",
          finishedAt: "2026-07-31T01:00:00.000Z"
        }),
      getCurrentJiaoyimaoBrowserRefresh: async () => {
        currentCall += 1;
        return currentCall === 1 ? null : current;
      },
      startJiaoyimaoBrowserRefresh: async () => {
        throw new ScoutApiError(
          "交易猫浏览器刷新任务已存在",
          409,
          "browser_job_conflict"
        );
      }
    });
    const user = userEvent.setup();

    render(<App api={api} />);
    expect(await screen.findByRole("button", {
      name: /CONFLICT-KEPT/
    })).toBeInTheDocument();
    const jymCard = screen.getByText("交易猫").closest("article");
    await user.click(within(jymCard!).getByRole("button", {
      name: /刷新交易猫/
    }));

    expect(await screen.findByTestId("browser-refresh-state"))
      .toHaveTextContent("正在核验详情");
    expect(screen.getByRole("alert"))
      .toHaveTextContent("交易猫浏览器刷新任务已存在");
    expect(screen.getByRole("button", {
      name: /CONFLICT-KEPT/
    })).toBeInTheDocument();
    expect(api.getCurrentJiaoyimaoBrowserRefresh)
      .toHaveBeenCalledTimes(2);

    window.dispatchEvent(new Event("focus"));
    await waitFor(() =>
      expect(api.getCurrentJiaoyimaoBrowserRefresh)
        .toHaveBeenCalledTimes(3)
    );
    expect(screen.getByRole("alert"))
      .toHaveTextContent("交易猫浏览器刷新任务已存在");

    current = makeBrowserRefreshJob({
      state: "failed",
      stage: "failed",
      updatedAt: "2026-07-31T01:02:00.000Z",
      finishedAt: "2026-07-31T01:02:00.000Z"
    });
    window.dispatchEvent(new Event("focus"));
    await waitFor(() =>
      expect(api.getCurrentJiaoyimaoBrowserRefresh)
        .toHaveBeenCalledTimes(4)
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("browser refresh bounds a hung 409 authority recovery without retrying the start mutation", async () => {
    vi.useFakeTimers();
    const recoverySignals: AbortSignal[] = [];
    let currentCall = 0;
    let statusCall = 0;
    const api = makeApi({
      sources: [makeSourceStatus({ source: "jiaoyimao" })],
      getCurrentJiaoyimaoBrowserRefresh: (signal) => {
        currentCall += 1;
        if (currentCall === 1) return Promise.resolve(null);
        if (signal) recoverySignals.push(signal);
        return new Promise(() => undefined);
      },
      getRefreshStatus: (signal) => {
        statusCall += 1;
        if (statusCall === 1) {
          return Promise.resolve(makeRefreshStatus());
        }
        if (signal) recoverySignals.push(signal);
        return new Promise(() => undefined);
      },
      startJiaoyimaoBrowserRefresh: async () => {
        throw new ScoutApiError(
          "另一个刷新任务正在进行",
          409,
          "refresh_conflict"
        );
      }
    });

    try {
      render(<App api={api} />);
      await act(async () => undefined);
      const panel = screen.getByRole("region", {
        name: "交易猫浏览器刷新"
      });
      fireEvent.click(within(panel).getByRole("button", {
        name: "刷新交易猫"
      }));
      await act(async () => undefined);
      expect(panel).toHaveAttribute("aria-busy", "false");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_000);
      });

      expect(recoverySignals).toHaveLength(2);
      expect(recoverySignals.every(({ aborted }) => aborted)).toBe(true);
      expect(api.startJiaoyimaoBrowserRefresh).toHaveBeenCalledTimes(1);
      expect(api.getCurrentJiaoyimaoBrowserRefresh)
        .toHaveBeenCalledTimes(2);
      expect(api.getRefreshStatus).toHaveBeenCalledTimes(2);
      expect(panel).toHaveAttribute("aria-busy", "false");
      expect(within(panel).getByRole("button", {
        name: "刷新交易猫"
      })).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["success", "partial", "failed"] as const)(
    "browser refresh restores starts after an external all-source conflict reaches %s",
    async (terminalState) => {
      let allSourceStatus = makeRefreshStatus();
      const api = makeApi({
        sources: [makeSourceStatus({ source: "jiaoyimao" })],
        getRefreshStatus: async () => allSourceStatus,
        getCurrentJiaoyimaoBrowserRefresh: async () => null,
        startJiaoyimaoBrowserRefresh: async () => {
          allSourceStatus = makeRefreshStatus({
            runId: 82,
            state: "running",
            source: "panzhi",
            phase: "list"
          });
          throw new ScoutApiError(
            "另一个刷新任务正在进行",
            409,
            "refresh_conflict"
          );
        }
      });
      const user = userEvent.setup();

      render(<App api={api} />);
      const jymCard = (await screen.findByText("交易猫"))
        .closest("article");
      const sourceButton = within(jymCard!).getByRole("button", {
        name: /刷新交易猫/
      });
      const panel = screen.getByRole("region", {
        name: "交易猫浏览器刷新"
      });
      const panelButton = within(panel).getByRole("button", {
        name: "刷新交易猫"
      });

      await user.click(sourceButton);

      expect(await screen.findByRole("alert"))
        .toHaveTextContent("另一个刷新任务正在进行");
      expect(sourceButton).toBeDisabled();
      expect(panelButton).toBeDisabled();
      await user.click(sourceButton);
      await user.click(panelButton);
      expect(api.startJiaoyimaoBrowserRefresh).toHaveBeenCalledTimes(1);

      allSourceStatus = makeRefreshStatus({
        runId: 82,
        state: terminalState,
        finishedAt: "2026-07-31T01:10:00.000Z"
      });
      window.dispatchEvent(new Event("focus"));

      await waitFor(() => expect(sourceButton).toBeEnabled());
      expect(panelButton).toBeEnabled();
      expect(within(panel).queryByRole("alert"))
        .not.toBeInTheDocument();
    }
  );

  it("browser refresh keeps starts blocked while the conflicting all-source tracker is running", async () => {
    let allSourceStatus = makeRefreshStatus();
    let currentCall = 0;
    const oldTerminal = makeBrowserRefreshJob({
      id: "old-browser-job",
      state: "failed",
      stage: "failed",
      finishedAt: "2026-07-31T00:50:00.000Z"
    });
    const api = makeApi({
      sources: [makeSourceStatus({ source: "jiaoyimao" })],
      getRefreshStatus: async () => allSourceStatus,
      getCurrentJiaoyimaoBrowserRefresh: async () => {
        currentCall += 1;
        return currentCall === 1 ? null : oldTerminal;
      },
      startJiaoyimaoBrowserRefresh: async () => {
        allSourceStatus = makeRefreshStatus({
          runId: 83,
          state: "running",
          source: "panzhi",
          phase: "list"
        });
        throw new ScoutApiError(
          "另一个刷新任务正在进行",
          409,
          "refresh_conflict"
        );
      }
    });
    const user = userEvent.setup();

    render(<App api={api} />);
    const jymCard = (await screen.findByText("交易猫")).closest("article");
    const sourceButton = within(jymCard!).getByRole("button", {
      name: /刷新交易猫/
    });
    await user.click(sourceButton);
    expect(await screen.findByRole("alert"))
      .toHaveTextContent("另一个刷新任务正在进行");

    window.dispatchEvent(new Event("focus"));
    await act(async () => undefined);

    expect(sourceButton).toBeDisabled();
    expect(screen.getByRole("alert"))
      .toHaveTextContent("另一个刷新任务正在进行");
    expect(api.startJiaoyimaoBrowserRefresh).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "network",
      failure: new Error("网络暂不可达"),
      expectedMessage: "一次性接管码无法恢复",
      reconciles: true
    },
    {
      name: "server",
      failure: new ScoutApiError(
        "交易猫浏览器刷新操作失败",
        500,
        "browser_refresh_failed"
      ),
      expectedMessage: "交易猫浏览器刷新操作失败",
      reconciles: false
    }
  ])(
    "browser refresh keeps retry available after a non-conflict $name start error",
    async ({ failure, expectedMessage, reconciles }) => {
      const api = makeApi({
        sources: [makeSourceStatus({ source: "jiaoyimao" })],
        getCurrentJiaoyimaoBrowserRefresh: async () => null,
        startJiaoyimaoBrowserRefresh: async () => {
          throw failure;
        }
      });
      const user = userEvent.setup();

      render(<App api={api} />);
      const panel = await screen.findByRole("region", {
        name: "交易猫浏览器刷新"
      });
      const startButton = within(panel).getByRole("button", {
        name: "刷新交易猫"
      });
      await user.click(startButton);

      expect(within(panel).getByRole("alert"))
        .toHaveTextContent(expectedMessage);
      expect(within(panel).queryByText("当前无法发起："))
        .not.toBeInTheDocument();
      expect(startButton).toBeEnabled();
      expect(api.getCurrentJiaoyimaoBrowserRefresh)
        .toHaveBeenCalledTimes(reconciles ? 2 : 1);

      await user.click(startButton);
      expect(api.startJiaoyimaoBrowserRefresh)
        .toHaveBeenCalledTimes(2);
    }
  );

  it("browser refresh keeps claim codes local and broadcasts mutations without echo", async () => {
    const channels = new Map<string, BroadcastChannelStub>();
    class BroadcastChannelStub {
      onmessage: ((event: MessageEvent) => void) | null = null;
      messages: unknown[] = [];
      closed = false;
      constructor(readonly name: string) {
        channels.set(name, this);
      }
      postMessage(message: unknown) {
        this.messages.push(message);
      }
      close() {
        this.closed = true;
      }
    }
    vi.stubGlobal("BroadcastChannel", BroadcastChannelStub);
    let currentCall = 0;
    const collecting = makeBrowserRefreshJob({
      state: "collecting_details",
      stage: "details",
      updatedAt: "2026-07-31T01:02:00.000Z"
    });
    let remoteCurrent = collecting;
    const api = makeApi({
      getCurrentJiaoyimaoBrowserRefresh: async () => {
        currentCall += 1;
        if (currentCall === 1) return null;
        return remoteCurrent;
      }
    });
    const user = userEvent.setup();

    try {
      render(<App api={api} />);
      const panel = await screen.findByRole("region", {
        name: "交易猫浏览器刷新"
      });
      await user.click(within(panel).getByRole("button", {
        name: "刷新交易猫"
      }));

      expect(await screen.findByText("one-time-code"))
        .toBeInTheDocument();
      const browserChannel = channels.get(
        "jiaoyimao-browser-refresh-changed"
      );
      expect(browserChannel).toBeDefined();
      expect(JSON.stringify(browserChannel?.messages))
        .not.toContain("one-time-code");
      const postsBeforeMessage = browserChannel!.messages.length;
      const currentCallsBeforeInvalid =
        vi.mocked(api.getCurrentJiaoyimaoBrowserRefresh).mock.calls
          .length;

      for (const data of [
        null,
        { type: "browser-refresh-changed" },
        {
          version: 2,
          type: "browser-refresh-changed",
          jobId: collecting.id,
          state: collecting.state,
          updatedAt: collecting.updatedAt,
          publishedRunId: null
        },
        {
          version: 1,
          type: "browser-refresh-changed",
          jobId: collecting.id,
          state: collecting.state,
          updatedAt: collecting.updatedAt,
          publishedRunId: null,
          extra: true
        }
      ]) {
        await act(async () => {
          browserChannel?.onmessage?.(
            new MessageEvent("message", { data })
          );
        });
      }
      expect(api.getCurrentJiaoyimaoBrowserRefresh)
        .toHaveBeenCalledTimes(currentCallsBeforeInvalid);

      await act(async () => {
        browserChannel?.onmessage?.(
          new MessageEvent("message", {
            data: {
              version: 1,
              type: "browser-refresh-changed",
              jobId: collecting.id,
              state: collecting.state,
              updatedAt: collecting.updatedAt,
              publishedRunId: null
            }
          })
        );
      });

      expect(screen.getByTestId("browser-refresh-state"))
        .toHaveTextContent("正在核验详情");
      expect(screen.queryByText("one-time-code"))
        .not.toBeInTheDocument();
      expect(browserChannel?.messages).toHaveLength(postsBeforeMessage);

      remoteCurrent = makeBrowserRefreshJob({
        state: "validating",
        stage: "validating",
        updatedAt: "2026-07-31T01:03:00.000Z"
      });
      window.dispatchEvent(new Event("focus"));
      await act(async () => undefined);

      expect(browserChannel?.messages)
        .toHaveLength(postsBeforeMessage + 1);
      expect(browserChannel?.messages.every((message) =>
        typeof message === "object" &&
        message !== null &&
        "version" in message &&
        message.version === 1
      )).toBe(true);
      expect(JSON.stringify(browserChannel?.messages))
        .not.toContain("one-time-code");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(["cancel", "keep-waiting"] as const)(
    "browser refresh ignores a stale %s response after synchronization moves to another job",
    async (operationKind) => {
      const channels = new Map<string, BroadcastChannelStub>();
      class BroadcastChannelStub {
        onmessage: ((event: MessageEvent) => void) | null = null;
        messages: unknown[] = [];
        constructor(readonly name: string) {
          channels.set(name, this);
        }
        postMessage(message: unknown) {
          this.messages.push(message);
        }
        close() {}
      }
      vi.stubGlobal("BroadcastChannel", BroadcastChannelStub);
      const operation =
        deferred<JiaoyimaoBrowserRefreshJob>();
      let current = makeBrowserRefreshJob({
        id: "browser-job-a",
        state: "paused",
        stage: "paused"
      });
      const api = makeApi({
        getCurrentJiaoyimaoBrowserRefresh: async () => current,
        cancelJiaoyimaoBrowserRefresh: async () => operation.promise,
        keepWaitingForJiaoyimaoBrowserRefresh: async () =>
          operation.promise
      });
      const user = userEvent.setup();

      try {
        render(<App api={api} />);
        expect(await screen.findByTestId("browser-refresh-state"))
          .toHaveTextContent("任务已暂停");

        if (operationKind === "cancel") {
          await user.click(screen.getByRole("button", {
            name: "取消本次刷新"
          }));
          await user.click(screen.getByRole("button", {
            name: "确认取消"
          }));
          expect(api.cancelJiaoyimaoBrowserRefresh)
            .toHaveBeenCalledWith(
              "browser-job-a",
              expect.any(AbortSignal)
            );
        } else {
          await user.click(screen.getByRole("button", {
            name: "我还在处理，继续等待"
          }));
          expect(api.keepWaitingForJiaoyimaoBrowserRefresh)
            .toHaveBeenCalledWith(
              "browser-job-a",
              expect.any(AbortSignal)
            );
        }

        current = makeBrowserRefreshJob({
          id: "browser-job-b",
          state: "collecting_details",
          stage: "details",
          updatedAt: "2026-07-31T01:03:00.000Z"
        });
        window.dispatchEvent(new Event("focus"));
        await waitFor(() =>
          expect(screen.getByTestId("browser-refresh-state"))
            .toHaveTextContent("正在核验详情")
        );

        await act(async () => {
          operation.resolve(makeBrowserRefreshJob({
            id: "browser-job-a",
            state: operationKind === "cancel"
              ? "cancelled"
              : "paused",
            stage: operationKind,
            updatedAt: "2026-07-31T01:04:00.000Z",
            finishedAt: operationKind === "cancel"
              ? "2026-07-31T01:04:00.000Z"
              : null
          }));
        });

        expect(screen.getByTestId("browser-refresh-state"))
          .toHaveTextContent("正在核验详情");
        const browserChannel = channels.get(
          "jiaoyimao-browser-refresh-changed"
        );
        expect(JSON.stringify(browserChannel?.messages))
          .not.toContain("browser-job-a");
      } finally {
        vi.unstubAllGlobals();
      }
    }
  );

  it.each(["cancel", "keep-waiting"] as const)(
    "browser refresh times out a hung %s mutation, unlocks, and reconciles once without retrying",
    async (operationKind) => {
      vi.useFakeTimers();
      const paused = makeBrowserRefreshJob({
        state: "paused",
        stage: "paused"
      });
      const mutationSignals: AbortSignal[] = [];
      const reconcileStatusSignals: AbortSignal[] = [];
      const api = makeApi({
        getCurrentJiaoyimaoBrowserRefresh: async (signal) => {
          return paused;
        },
        getRefreshStatus: async (signal) => {
          if (signal) reconcileStatusSignals.push(signal);
          return makeRefreshStatus();
        },
        cancelJiaoyimaoBrowserRefresh: async (_jobId, signal) => {
          if (signal) mutationSignals.push(signal);
          return new Promise(() => undefined);
        },
        keepWaitingForJiaoyimaoBrowserRefresh: async (
          _jobId,
          signal
        ) => {
          if (signal) mutationSignals.push(signal);
          return new Promise(() => undefined);
        }
      });

      try {
        render(<App api={api} />);
        await act(async () => undefined);
        const panel = screen.getByRole("region", {
          name: "交易猫浏览器刷新"
        });
        if (operationKind === "cancel") {
          fireEvent.click(within(panel).getByRole("button", {
            name: "取消本次刷新"
          }));
          fireEvent.click(screen.getByRole("button", {
            name: "确认取消"
          }));
        } else {
          fireEvent.click(within(panel).getByRole("button", {
            name: "我还在处理，继续等待"
          }));
        }
        expect(panel).toHaveAttribute("aria-busy", "true");

        await act(async () => {
          await vi.advanceTimersByTimeAsync(4_000);
        });

        expect(mutationSignals).toHaveLength(1);
        expect(mutationSignals[0]?.aborted).toBe(true);
        const mutation = operationKind === "cancel"
          ? api.cancelJiaoyimaoBrowserRefresh
          : api.keepWaitingForJiaoyimaoBrowserRefresh;
        expect(mutation).toHaveBeenCalledTimes(1);
        expect(
          vi.mocked(api.getCurrentJiaoyimaoBrowserRefresh).mock.calls
            .length
        ).toBeGreaterThanOrEqual(2);
        expect(reconcileStatusSignals).toHaveLength(1);
        expect(panel).toHaveAttribute("aria-busy", "false");
        expect(within(panel).getByRole("button", {
          name: "我还在处理，继续等待"
        })).toBeEnabled();
        expect(within(panel).getByRole("button", {
          name: "取消本次刷新"
        })).toBeEnabled();
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it("browser refresh preserves a still-valid local claim code after an uncertain cancel reconciles to the same awaiting job", async () => {
    vi.useFakeTimers();
    const awaiting = makeBrowserRefreshJob({
      state: "awaiting_codex",
      stage: "awaiting_codex",
      claimedAt: null
    });
    let currentCall = 0;
    const api = makeApi({
      getCurrentJiaoyimaoBrowserRefresh: async () => {
        currentCall += 1;
        return currentCall === 1 ? null : awaiting;
      },
      startJiaoyimaoBrowserRefresh: async () => ({
        jobId: awaiting.id,
        state: "awaiting_codex",
        claimCode: "STILL-VALID-CODE",
        expiresAt: awaiting.expiresAt
      }),
      cancelJiaoyimaoBrowserRefresh: async () =>
        new Promise(() => undefined)
    });

    try {
      render(<App api={api} />);
      await act(async () => undefined);
      const panel = screen.getByRole("region", {
        name: "交易猫浏览器刷新"
      });
      fireEvent.click(within(panel).getByRole("button", {
        name: "刷新交易猫"
      }));
      await act(async () => undefined);
      expect(within(panel).getByText("STILL-VALID-CODE"))
        .toBeInTheDocument();

      fireEvent.click(within(panel).getByRole("button", {
        name: "取消本次刷新"
      }));
      fireEvent.click(screen.getByRole("button", {
        name: "确认取消"
      }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_000);
      });

      expect(within(panel).getByText("STILL-VALID-CODE"))
        .toBeInTheDocument();
      expect(api.cancelJiaoyimaoBrowserRefresh).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("browser refresh ignores a stale mutation failure after synchronization moves to another job", async () => {
    const operation = deferred<JiaoyimaoBrowserRefreshJob>();
    let current = makeBrowserRefreshJob({
      id: "browser-job-a",
      state: "paused",
      stage: "paused"
    });
    const api = makeApi({
      getCurrentJiaoyimaoBrowserRefresh: async () => current,
      keepWaitingForJiaoyimaoBrowserRefresh: async () =>
        operation.promise
    });
    const user = userEvent.setup();

    render(<App api={api} />);
    expect(await screen.findByTestId("browser-refresh-state"))
      .toHaveTextContent("任务已暂停");
    await user.click(screen.getByRole("button", {
      name: "我还在处理，继续等待"
    }));

    current = makeBrowserRefreshJob({
      id: "browser-job-b",
      state: "collecting_details",
      stage: "details",
      updatedAt: "2026-07-31T01:03:00.000Z"
    });
    window.dispatchEvent(new Event("focus"));
    await waitFor(() =>
      expect(screen.getByTestId("browser-refresh-state"))
        .toHaveTextContent("正在核验详情")
    );

    await act(async () => {
      operation.reject(new Error("旧任务操作失败"));
    });

    expect(screen.getByTestId("browser-refresh-state"))
      .toHaveTextContent("正在核验详情");
    expect(screen.queryByText("旧任务操作失败"))
      .not.toBeInTheDocument();
  });

  it("browser refresh blocks same-tick duplicate starts synchronously", async () => {
    const startResult =
      deferred<Awaited<
        ReturnType<ScoutApi["startJiaoyimaoBrowserRefresh"]>
      >>();
    const api = makeApi({
      sources: [makeSourceStatus({ source: "jiaoyimao" })],
      startJiaoyimaoBrowserRefresh: async () => startResult.promise
    });

    render(<App api={api} />);
    const jymCard = (await screen.findByText("交易猫")).closest("article");
    const sourceButton = within(jymCard!).getByRole("button", {
      name: /刷新交易猫/
    });
    const panelButton = within(screen.getByRole("region", {
      name: "交易猫浏览器刷新"
    })).getByRole("button", {
      name: "刷新交易猫"
    });

    act(() => {
      panelButton.click();
      sourceButton.click();
    });

    expect(api.startJiaoyimaoBrowserRefresh).toHaveBeenCalledTimes(1);
  });

  it("browser refresh preserves selected data on pause, failure, quarantine, and transport errors", async () => {
    const listing = makeListing({
      sourceListingId: "BROWSER-PRESERVED",
      totalAssetsM: 909
    });
    let currentCall = 0;
    const jobs = [
      makeBrowserRefreshJob({
        state: "paused",
        stage: "list"
      }),
      new Error("浏览器任务状态暂不可达"),
      makeBrowserRefreshJob({
        state: "failed",
        stage: "failed",
        updatedAt: "2026-07-31T01:02:00.000Z",
        finishedAt: "2026-07-31T01:02:00.000Z"
      }),
      makeBrowserRefreshJob({
        state: "quarantined",
        stage: "quarantined",
        updatedAt: "2026-07-31T01:03:00.000Z",
        finishedAt: "2026-07-31T01:03:00.000Z"
      })
    ];
    const api = makeApi({
      getListings: async () => [listing],
      getListing: async () => listing,
      getCurrentJiaoyimaoBrowserRefresh: async () => {
        const result = jobs[Math.min(currentCall, jobs.length - 1)]!;
        currentCall += 1;
        if (result instanceof Error) throw result;
        return result;
      }
    });
    const user = userEvent.setup();

    render(<App api={api} />);
    await user.click(await screen.findByRole("button", {
      name: /BROWSER-PRESERVED/
    }));
    expect(screen.getByRole("complementary", {
      name: "候选详情"
    })).toHaveTextContent("909M");

    for (const expectedState of [
      "任务已暂停",
      "刷新失败",
      "新结果已隔离"
    ]) {
      window.dispatchEvent(new Event("focus"));
      await act(async () => undefined);
      if (expectedState !== "任务已暂停") {
        expect(screen.getByTestId("browser-refresh-state"))
          .toHaveTextContent(expectedState);
      }
      expect(screen.getByRole("button", {
        name: /BROWSER-PRESERVED/
      })).toBeInTheDocument();
      expect(screen.getByRole("complementary", {
        name: "候选详情"
      })).toHaveTextContent("909M");
    }

    expect(api.getListings).toHaveBeenCalledTimes(1);
    expect(api.getListingHistory).toHaveBeenCalledTimes(1);
  });

  it("browser refresh reloads published data and selected history once per success version", async () => {
    const listing = makeListing({
      key: "panzhi:browser-success",
      sourceListingId: "BROWSER-SUCCESS"
    });
    let current = makeBrowserRefreshJob();
    const api = makeApi({
      getListings: async () => [listing],
      getListing: async () => listing,
      getCurrentJiaoyimaoBrowserRefresh: async () => current
    });
    const user = userEvent.setup();

    render(<App api={api} />);
    await user.click(await screen.findByRole("button", {
      name: /BROWSER-SUCCESS/
    }));
    expect(api.getListingHistory).toHaveBeenCalledTimes(1);

    current = makeBrowserRefreshJob({
      state: "success",
      stage: "success",
      updatedAt: "2026-07-31T01:02:00.000Z",
      finishedAt: "2026-07-31T01:02:00.000Z",
      scanRunId: 91,
      publishedRunId: 91
    });
    window.dispatchEvent(new Event("focus"));
    await waitFor(() =>
      expect(api.getListings).toHaveBeenCalledTimes(2)
    );
    expect(api.getSources).toHaveBeenCalledTimes(2);
    expect(api.getScanHistory).toHaveBeenCalledTimes(1);
    expect(api.getListingHistory).toHaveBeenCalledTimes(2);

    window.dispatchEvent(new Event("focus"));
    await act(async () => undefined);
    expect(api.getListings).toHaveBeenCalledTimes(2);
    expect(api.getScanHistory).toHaveBeenCalledTimes(1);

    current = {
      ...current,
      updatedAt: "2026-07-31T01:03:00.000Z",
      scanRunId: 92,
      publishedRunId: 92
    };
    window.dispatchEvent(new Event("focus"));
    await waitFor(() =>
      expect(api.getListings).toHaveBeenCalledTimes(3)
    );
    expect(api.getScanHistory).toHaveBeenCalledTimes(2);
    expect(api.getListingHistory).toHaveBeenCalledTimes(3);
  });

  it("browser published reload clears a superseded detail busy state and ignores its late result", async () => {
    const listing = makeListing({
      key: "jiaoyimao:published-detail",
      source: "jiaoyimao",
      sourceListingId: "PUBLISHED-DETAIL",
      totalAssetsM: 321
    });
    const staleDetail = deferred<Listing>();
    let current = makeBrowserRefreshJob();
    const api = makeApi({
      sources: [makeSourceStatus({ source: "jiaoyimao" })],
      getListings: async () => [listing],
      getListing: async () => staleDetail.promise,
      getCurrentJiaoyimaoBrowserRefresh: async () => current
    });
    const user = userEvent.setup();

    render(<App api={api} />);
    await user.click(await screen.findByRole("button", {
      name: /PUBLISHED-DETAIL/
    }));
    const detail = screen.getByRole("complementary", {
      name: "候选详情"
    });
    expect(detail).toHaveAttribute("aria-busy", "true");

    current = makeBrowserRefreshJob({
      state: "success",
      stage: "success",
      updatedAt: "2026-07-31T01:02:00.000Z",
      finishedAt: "2026-07-31T01:02:00.000Z",
      scanRunId: 301,
      publishedRunId: 301
    });
    window.dispatchEvent(new Event("focus"));
    await waitFor(() =>
      expect(api.getScanHistory).toHaveBeenCalledTimes(1)
    );
    await act(async () => undefined);

    expect(detail).toHaveAttribute("aria-busy", "false");

    await act(async () => {
      staleDetail.resolve(makeListing({
        ...listing,
        totalAssetsM: 999
      }));
    });
    expect(detail).toHaveAttribute("aria-busy", "false");
    expect(within(detail).getByText("321M")).toBeInTheDocument();
    expect(within(detail).queryByText("999M")).not.toBeInTheDocument();
  });

  it("browser published reload retries after a required failure and displays scan history once successful", async () => {
    vi.useFakeTimers();
    const listing = makeListing({
      sourceListingId: "PUBLISHED-RETRY-KEPT"
    });
    const published = makeBrowserRefreshJob({
      state: "success",
      stage: "success",
      updatedAt: "2026-07-31T01:02:00.000Z",
      finishedAt: "2026-07-31T01:02:00.000Z",
      scanRunId: 201,
      publishedRunId: 201
    });
    let scanHistoryCall = 0;
    const api = makeApi({
      sources: [makeSourceStatus({ source: "jiaoyimao" })],
      getListings: async () => [listing],
      getCurrentJiaoyimaoBrowserRefresh: async () => published,
      getScanHistory: async () => {
        scanHistoryCall += 1;
        if (scanHistoryCall === 1) {
          throw new Error("扫描历史首次读取失败");
        }
        return {
          runs: [{
            id: 201,
            startedAt: "2026-07-31T01:00:00.000Z",
            finishedAt: "2026-07-31T01:02:00.000Z",
            state: "success" as const,
            error: null,
            scope: "single_source" as const,
            requestedSource: "jiaoyimao" as const,
            sources: []
          }]
        };
      }
    });

    try {
      render(<App api={api} />);
      await act(async () => undefined);

      expect(api.getScanHistory).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("button", {
        name: /PUBLISHED-RETRY-KEPT/
      })).toBeInTheDocument();
      expect(screen.getAllByText("扫描历史首次读取失败").length)
        .toBeGreaterThan(0);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });

      expect(api.getScanHistory).toHaveBeenCalledTimes(2);
      expect(screen.getByLabelText("最近扫描历史"))
        .toHaveTextContent("#201");
      expect(screen.queryAllByText("扫描历史首次读取失败"))
        .toHaveLength(0);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(api.getScanHistory).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("browser published success preserves a removed selection while reloading formal data and history", async () => {
    const listing = makeListing({
      key: "panzhi:browser-removed",
      sourceListingId: "BROWSER-REMOVED",
      totalAssetsM: 818
    });
    let listingCall = 0;
    let historyCall = 0;
    let current = makeBrowserRefreshJob();
    const api = makeApi({
      sources: [makeSourceStatus({ source: "jiaoyimao" })],
      getListings: async () => {
        listingCall += 1;
        return listingCall === 1 ? [listing] : [];
      },
      getListing: async () => listing,
      getListingHistory: async (key) => {
        historyCall += 1;
        return {
          key,
          source: listing.source,
          availability:
            historyCall === 1 ? "active" as const : "removed" as const,
          lastSeenAt: "2026-07-31T01:00:00.000Z",
          observations: [
            {
              runId: historyCall,
              observedAt: "2026-07-31T01:00:00.000Z",
              availability:
                historyCall === 1
                  ? "active" as const
                  : "removed" as const,
              priceCny: historyCall === 1 ? listing.priceCny : null,
              snapshot: buildListingHistorySnapshot(listing),
              changes: []
            }
          ]
        };
      },
      getCurrentJiaoyimaoBrowserRefresh: async () => current
    });
    const user = userEvent.setup();

    render(<App api={api} />);
    await user.click(await screen.findByRole("button", {
      name: /BROWSER-REMOVED/
    }));
    const detail = screen.getByRole("complementary", {
      name: "候选详情"
    });
    expect(detail).toHaveTextContent("BROWSER-REMOVED");
    expect(detail).toHaveTextContent("818M");

    current = makeBrowserRefreshJob({
      state: "success",
      stage: "success",
      updatedAt: "2026-07-31T01:02:00.000Z",
      finishedAt: "2026-07-31T01:02:00.000Z",
      scanRunId: 93,
      publishedRunId: 93
    });
    window.dispatchEvent(new Event("focus"));

    await waitFor(() => expect(api.getListings).toHaveBeenCalledTimes(2));
    expect(api.getSources).toHaveBeenCalledTimes(2);
    expect(api.getScanHistory).toHaveBeenCalledTimes(1);
    expect(api.getListingHistory)
      .toHaveBeenLastCalledWith(listing.key, 20);
    expect(api.getListingHistory).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", {
      name: /BROWSER-REMOVED/
    })).not.toBeInTheDocument();
    expect(detail).toHaveTextContent("BROWSER-REMOVED");
    expect(detail).toHaveTextContent("818M");
    expect(within(detail).getByText("已下架")).toBeInTheDocument();
  });

  it("browser refresh ignores stale out-of-order polls after a terminal state", async () => {
    const older = deferred<JiaoyimaoBrowserRefreshJob | null>();
    const newer = deferred<JiaoyimaoBrowserRefreshJob | null>();
    let currentCall = 0;
    const api = makeApi({
      getCurrentJiaoyimaoBrowserRefresh: async () => {
        currentCall += 1;
        if (currentCall === 1) return makeBrowserRefreshJob();
        if (currentCall === 2) return older.promise;
        return newer.promise;
      }
    });

    render(<App api={api} />);
    expect(await screen.findByTestId("browser-refresh-state"))
      .toHaveTextContent("正在采集列表");

    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
    await act(async () => {
      newer.resolve(makeBrowserRefreshJob({
        state: "success",
        stage: "success",
        updatedAt: "2026-07-31T01:03:00.000Z",
        finishedAt: "2026-07-31T01:03:00.000Z",
        scanRunId: 101,
        publishedRunId: 101
      }));
    });
    expect(screen.getByTestId("browser-refresh-state"))
      .toHaveTextContent("刷新完成");

    await act(async () => {
      older.resolve(makeBrowserRefreshJob({
        state: "collecting_details",
        stage: "details",
        updatedAt: "2026-07-31T01:02:00.000Z"
      }));
    });
    expect(screen.getByTestId("browser-refresh-state"))
      .toHaveTextContent("刷新完成");
    expect(screen.getByRole("button", {
      name: "刷新公开数据"
    })).toBeEnabled();
  });

  it("browser refresh aborts stale focus synchronizations and only applies the latest result", async () => {
    const requests: Array<{
      signal: AbortSignal | undefined;
      result: ReturnType<
        typeof deferred<JiaoyimaoBrowserRefreshJob | null>
      >;
    }> = [];
    const api = makeApi({
      getCurrentJiaoyimaoBrowserRefresh: (
        signal?: AbortSignal
      ) => {
        const result =
          deferred<JiaoyimaoBrowserRefreshJob | null>();
        requests.push({ signal, result });
        return result.promise;
      }
    });

    render(<App api={api} />);
    await act(async () => undefined);
    expect(requests).toHaveLength(1);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
    });

    expect(requests).toHaveLength(4);
    expect(requests.slice(0, 3).every(
      ({ signal }) => signal?.aborted === true
    )).toBe(true);

    await act(async () => {
      requests[3]!.result.resolve(makeBrowserRefreshJob({
        id: "browser-job-b",
        state: "collecting_details",
        stage: "details",
        updatedAt: "2026-07-31T01:04:00.000Z"
      }));
    });
    expect(screen.getByTestId("browser-refresh-state"))
      .toHaveTextContent("正在核验详情");

    await act(async () => {
      requests[0]!.result.resolve(makeBrowserRefreshJob({
        id: "browser-job-a",
        state: "failed",
        stage: "failed",
        updatedAt: "2026-07-31T01:05:00.000Z",
        finishedAt: "2026-07-31T01:05:00.000Z"
      }));
    });
    expect(screen.getByTestId("browser-refresh-state"))
      .toHaveTextContent("正在核验详情");
  });

  it("browser refresh times out a hung synchronization and schedules the next poll", async () => {
    vi.useFakeTimers();
    const signals: Array<AbortSignal | undefined> = [];
    const api = makeApi({
      getCurrentJiaoyimaoBrowserRefresh: (
        signal?: AbortSignal
      ) => {
        signals.push(signal);
        return new Promise<JiaoyimaoBrowserRefreshJob | null>(
          () => undefined
        );
      }
    });

    try {
      render(<App api={api} />);
      await act(async () => undefined);
      expect(signals).toHaveLength(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_999);
      });
      expect(signals[0]?.aborted).toBe(false);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(signals[0]?.aborted).toBe(true);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_999);
      });
      expect(signals).toHaveLength(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(signals).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("browser refresh aborts hung synchronization on StrictMode cleanup without later updates", async () => {
    vi.useFakeTimers();
    const signals: Array<AbortSignal | undefined> = [];
    const api = makeApi({
      getCurrentJiaoyimaoBrowserRefresh: (
        signal?: AbortSignal
      ) => {
        signals.push(signal);
        return new Promise<JiaoyimaoBrowserRefreshJob | null>(
          () => undefined
        );
      }
    });
    const consoleError = vi.spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      const { unmount } = render(
        <StrictMode>
          <App api={api} />
        </StrictMode>
      );
      await act(async () => undefined);
      expect(signals.length).toBeGreaterThan(0);

      unmount();
      expect(signals.every(
        (signal) => signal?.aborted === true
      )).toBe(true);
      const callsAtUnmount = signals.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
      expect(signals).toHaveLength(callsAtUnmount);
      expect(consoleError.mock.calls.join(" "))
        .not.toMatch(/unmounted|state update/i);
    } finally {
      vi.useRealTimers();
      consoleError.mockRestore();
    }
  });

  it("browser refresh fails closed on unknown state and cleans polling resources in StrictMode", async () => {
    vi.useFakeTimers();
    const channels: BroadcastChannelStub[] = [];
    class BroadcastChannelStub {
      onmessage: ((event: MessageEvent) => void) | null = null;
      close = vi.fn();
      constructor(readonly name: string) {
        channels.push(this);
      }
      postMessage() {}
    }
    vi.stubGlobal("BroadcastChannel", BroadcastChannelStub);
    const unknown = {
      ...makeBrowserRefreshJob(),
      state: "future_server_state"
    } as unknown as JiaoyimaoBrowserRefreshJob;
    const api = makeApi({
      sources: [makeSourceStatus({ source: "jiaoyimao" })],
      getCurrentJiaoyimaoBrowserRefresh: async () => unknown
    });
    const consoleError = vi.spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      const { unmount } = render(
        <StrictMode>
          <App api={api} />
        </StrictMode>
      );
      await act(async () => undefined);
      expect(screen.getByTestId("browser-refresh-state"))
        .toHaveTextContent("未知状态");
      expect(screen.getByRole("button", {
        name: "刷新公开数据"
      })).toBeDisabled();
      const jymCard = screen.getByText("交易猫").closest("article");
      expect(within(jymCard!).getByRole("button", {
        name: /刷新交易猫/
      })).toBeDisabled();

      const callsBeforeUnmount =
        vi.mocked(api.getCurrentJiaoyimaoBrowserRefresh).mock.calls.length;
      unmount();
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });
      expect(api.getCurrentJiaoyimaoBrowserRefresh)
        .toHaveBeenCalledTimes(callsBeforeUnmount);
      expect(channels.length).toBeGreaterThan(0);
      expect(channels.every((channel) =>
        channel.close.mock.calls.length === 1
      )).toBe(true);
      expect(consoleError.mock.calls.join(" "))
        .not.toMatch(/unmounted|state update/i);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      consoleError.mockRestore();
    }
  });

  it("opens a mobile detail dialog and restores focus and body overflow on close", async () => {
    const restoreViewport = stubViewport(true);
    const listing = makeListing({ sourceListingId: "MOBILE-DRAWER" });
    const user = userEvent.setup();
    try {
      render(<App api={makeApi({
        getListings: async () => [listing],
        getListing: async () => listing
      })} />);

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      const row = await screen.findByRole("button", {
        name: /MOBILE-DRAWER/
      });
      await user.click(row);

      const dialog = screen.getByRole("dialog", {
        name: "MOBILE-DRAWER"
      });
      expect(dialog).toHaveAttribute("aria-modal", "true");
      expect(dialog).toHaveAttribute(
        "aria-labelledby",
        "candidate-detail-title"
      );
      expect(document.body.style.overflow).toBe("hidden");
      const close = within(dialog).getByRole("button", {
        name: "关闭候选详情"
      });
      expect(close).toHaveFocus();

      await user.click(close);

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(document.body.style.overflow).toBe("");
      expect(row).toHaveFocus();
    } finally {
      restoreViewport();
    }
  });

  it("closes the mobile detail dialog with Escape", async () => {
    const restoreViewport = stubViewport(true);
    const listing = makeListing({ sourceListingId: "ESCAPE-DRAWER" });
    const user = userEvent.setup();
    try {
      render(<App api={makeApi({
        getListings: async () => [listing]
      })} />);
      await user.click(
        await screen.findByRole("button", { name: /ESCAPE-DRAWER/ })
      );
      expect(screen.getByRole("dialog")).toBeInTheDocument();

      await user.keyboard("{Escape}");

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(document.body.style.overflow).toBe("");
    } finally {
      restoreViewport();
    }
  });

  it("keeps the desktop detail as a complementary panel", async () => {
    const restoreViewport = stubViewport(false);
    const listing = makeListing({ sourceListingId: "DESKTOP-PANEL" });
    const user = userEvent.setup();
    try {
      render(<App api={makeApi({
        getListings: async () => [listing]
      })} />);
      await user.click(
        await screen.findByRole("button", { name: /DESKTOP-PANEL/ })
      );

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.getByRole("complementary", {
        name: "候选详情"
      })).toBeInTheDocument();
    } finally {
      restoreViewport();
    }
  });
});
