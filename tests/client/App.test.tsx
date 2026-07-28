import {
  act,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { App } from "../../src/client/App";
import type {
  ScoutApi,
  SourceStatusView
} from "../../src/client/api";
import { httpScoutApi } from "../../src/client/api";
import type { Listing, SourceId } from "../../src/domain/listing";
import { makeListing } from "../domain/listingFactory";

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
    stopReason: "end_of_pages",
    completion: "complete",
    error: null,
    stale: false,
    ...overrides
  };
}

function makeApi({
  sources = [],
  getSources = async () => sources,
  getListings = async () => []
}: {
  sources?: SourceStatusView[];
  getSources?: ScoutApi["getSources"];
  getListings?: ScoutApi["getListings"];
} = {}): ScoutApi {
  return {
    getSources: vi.fn(getSources),
    getListings: vi.fn(getListings),
    getListing: vi.fn(async (key) => {
      const listings = await getListings("pool");
      const listing = listings.find((candidate) => candidate.key === key);
      if (!listing) throw new Error("not found");
      return listing;
    }),
    refresh: vi.fn(async () => undefined)
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

describe("App shell", () => {
  it("shows the fixed account requirements", () => {
    render(<App api={makeApi()} />);

    expect(
      screen.getByRole("heading", { name: "三角洲账号候选台" })
    ).toBeInTheDocument();
    expect(screen.getByText("QQ 官服")).toBeInTheDocument();
    expect(screen.getByText("M7 棱镜攻势 · 极品")).toBeInTheDocument();
    expect(screen.getByText("¥6,000 以内")).toBeInTheDocument();
  });

  it("maps every listing view to an explicit API query", async () => {
    const fetchMock = vi.fn(async (_input: string) => ({
      ok: true,
      json: async () => []
    }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      await httpScoutApi.getListings("pool");
      await httpScoutApi.getListings("eligible");
      await httpScoutApi.getListings("needs_verification");
      await httpScoutApi.getListings("rejected");
    } finally {
      vi.unstubAllGlobals();
    }

    expect(
      fetchMock.mock.calls.map(([input]) => input)
    ).toEqual([
      "/api/listings?view=pool&status=eligible",
      "/api/listings?view=all&status=eligible",
      "/api/listings?view=all&status=needs_verification",
      "/api/listings?view=all&status=rejected"
    ]);
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
      expect(api.getListings).toHaveBeenCalledWith("pool")
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
      expect(api.getListings).toHaveBeenCalledWith("eligible")
    );
    expect(
      screen.getByRole("heading", { name: "全部合格 2" })
    ).toBeInTheDocument();

    await user.click(needsTab);
    await waitFor(() =>
      expect(api.getListings).toHaveBeenCalledWith("needs_verification")
    );
    expect(
      screen.getByRole("heading", { name: "待人工核验 3" })
    ).toBeInTheDocument();

    await user.click(rejectedTab);
    await waitFor(() =>
      expect(api.getListings).toHaveBeenCalledWith("rejected")
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
      expect(api.getListings).toHaveBeenCalledWith("pool")
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
      expect(api.getListings).toHaveBeenCalledWith("pool")
    );
    await user.click(
      screen.getByRole("tab", { name: "全部合格" })
    );
    await waitFor(() =>
      expect(api.getListings).toHaveBeenCalledWith("eligible")
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
        total: 87,
        parts: { safety: 32, price: 21, assets: 19, confidence: 15 },
        reasons: ["安全信息 32.0/40", "价格合理性 21.0/25"]
      }
    });
    const api: ScoutApi = {
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
      getListings: vi.fn(async () => [listing]),
      getListing: vi.fn(async () => listing),
      refresh: vi.fn(async () => undefined)
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
    expect(within(detail).getByText("M7 棱镜攻势 极品")).toBeInTheDocument();
    expect(
      within(detail).getByRole("link", { name: "前往盼之核验" })
    ).toHaveAttribute("target", "_blank");
  });

  it("shows an empty message for the selected view", async () => {
    const api = makeApi();
    const user = userEvent.setup();
    render(<App api={api} />);

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

  it("refreshes and reloads the default pool view", async () => {
    const api: ScoutApi = {
      getSources: vi.fn(async () => []),
      getListings: vi.fn(async () => []),
      getListing: vi.fn(async () => {
        throw new Error("not used");
      }),
      refresh: vi.fn(async () => undefined)
    };
    render(<App api={api} />);
    const button = await screen.findByRole("button", {
      name: "刷新公开数据"
    });
    await userEvent.click(button);

    expect(api.refresh).toHaveBeenCalledTimes(1);
    expect(api.getListings).toHaveBeenLastCalledWith("pool");
    expect(api.getSources).toHaveBeenCalledTimes(2);
  });
});
