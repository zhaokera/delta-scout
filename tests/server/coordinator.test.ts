// @vitest-environment node
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { createDatabase } from "../../src/server/db.js";
import {
  jiaoyimaoAdapter
} from "../../src/server/collector/adapters/jiaoyimao.js";
import {
  CollectionCoordinator,
  type RefreshProgressEvent
} from "../../src/server/collector/coordinator.js";
import {
  APPROVED_JIAOYIMAO_MTOP_ENDPOINT
} from "../../src/server/collector/mtop.js";
import type {
  FetchResult,
  ListingDetail,
  ListingSummary,
  PageFetcher,
  SourceAdapter,
  SourceRequest
} from "../../src/server/collector/types.js";
import { ListingRepository } from "../../src/server/repository.js";
import { makeListing, makeScore } from "../domain/listingFactory.js";

async function fixture(name: string): Promise<string> {
  return readFile(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
}

class MapFetcher implements PageFetcher {
  readonly calls: string[] = [];

  constructor(private readonly responses: Map<string, FetchResult>) {}

  async fetchPage(request: SourceRequest): Promise<FetchResult> {
    this.calls.push(request.url);
    return (
      this.responses.get(request.url) ?? {
        kind: "failed",
        url: request.url,
        error: "missing_fixture"
      }
    );
  }
}

class RoutingFetcher implements PageFetcher {
  readonly calls: SourceRequest[] = [];

  constructor(
    private readonly route: (request: SourceRequest) => FetchResult
  ) {}

  async fetchPage(request: SourceRequest): Promise<FetchResult> {
    this.calls.push(request);
    return this.route(request);
  }
}

class LifecycleFetcher implements PageFetcher {
  readonly events: string[] = [];

  constructor(
    private readonly route: (
      request: SourceRequest
    ) => FetchResult | Promise<FetchResult>
  ) {}

  beginSource(source: ListingSummary["source"]): void {
    this.events.push(`begin:${source}`);
  }

  endSource(source: ListingSummary["source"]): void {
    this.events.push(`end:${source}`);
  }

  async fetchPage(
    request: SourceRequest,
    source: ListingSummary["source"]
  ): Promise<FetchResult> {
    this.events.push(`fetch:${source}:${request.url}`);
    return this.route(request);
  }
}

function ok(url: string, html: string): FetchResult {
  return { kind: "ok", url, status: 200, html };
}

function summary(index = 1): ListingSummary {
  return {
    source: "panzhi",
    sourceListingId: `S${index}`,
    url: `https://source.test/detail/${index}`,
    title: `候选 ${index}`,
    rawText: "QQ官服 M7棱镜攻势(极品A) 总资产268M 哈夫币2888w",
    priceCny: 5_288
  };
}

function summaryForSource(
  source: ListingSummary["source"],
  index: number,
  overrides: Partial<ListingSummary> = {}
): ListingSummary {
  return {
    ...summary(index),
    source,
    sourceListingId: `${source}-${index}`,
    url: `https://${source}.test/detail/${index}`,
    ...overrides
  };
}

function listingDetail(): ListingDetail {
  return {
    evidence: [
      { text: "M7棱镜攻势(极品A)", truncated: false },
      { text: "威龙 红皮", truncated: false },
      { text: "巨浪(极品)", truncated: false }
    ],
    loginPlatform: "qq",
    service: "official",
    totalAssetsM: 268,
    hafCoins: 28_880_000,
    realNameStatus: "second_available",
    secondRealNameAvailable: true,
    recoveryCoverage: true,
    verificationAt: "2026-07-27T10:00:00.000Z",
    banNotes: []
  };
}

function sourceStatus(
  repository: ListingRepository,
  source: ListingSummary["source"] = "panzhi"
) {
  return repository
    .getSourceStatuses()
    .find((status) => status.source === source);
}

function fakeAdapter(
  overrides: Partial<SourceAdapter> = {}
): SourceAdapter {
  return {
    source: "panzhi",
    entryUrl: "https://source.test/",
    discoverCatalog: () => ({
      kind: "ok",
      request: { url: "https://source.test/list/1" }
    }),
    parseList: () => ({ kind: "ok", items: [summary()] }),
    nextPage: () => null,
    detailRequest: (item) => ({ url: item.url }),
    parseDetail: () => ({
      kind: "ok",
      detail: listingDetail()
    }),
    ...overrides
  };
}

function freshSourceAdapter(
  source: ListingSummary["source"],
  index: number
): SourceAdapter {
  return fakeAdapter({
    source,
    entryUrl: `https://${source}.test/`,
    discoverCatalog: () => ({
      kind: "ok",
      request: { url: `https://${source}.test/list/1` }
    }),
    parseList: () => ({
      kind: "ok",
      items: [
        summaryForSource(source, index, {
          embeddedDetail: listingDetail()
        })
      ]
    })
  });
}

function jiaoyimaoSsrCard(
  id: string,
  visibleText = "普通账号"
): string {
  return `
    <a
      class="pcGoodsListItem"
      href="https://www.jiaoyimao.com/jg2007840/${id}.html"
      data-goodsid="${id}"
      data-price="2000"
    >
      <span data-goods-name="${visibleText}"></span>
      ${visibleText}
    </a>
  `;
}

function jiaoyimaoDetail(evidence: string): string {
  return `
    <div class="item-head-info-card">QQ双端帐号 安卓QQ</div>
    <div class="cmp-elevator-container">${evidence}</div>
  `;
}

async function collectJiaoyimaoMtopItem(
  detailEvidence: string,
  failure?: "fetch_failed" | "parse_blocked"
) {
  const page = JSON.parse(
    await fixture("jiaoyimao-list-page-2.json")
  ) as {
    data: {
      result: {
        hasNextPage: string;
        deliverComps: Array<{
          type: string;
          data?: {
            goodsId?: string;
            detailUrlSeo?: string;
            sellPoints?: Array<{ desc: string }>;
          };
        }>;
      };
    };
  };
  page.data.result.hasNextPage = "false";
  const product = page.data.result.deliverComps.find(
    ({ type }) => type === "8"
  )?.data;
  if (!product?.goodsId || !product.detailUrlSeo) {
    throw new Error("expected fixture product");
  }
  product.sellPoints = [
    { desc: "威龙-凌霄戍卫" },
    { desc: "巨浪(极品)" }
  ];
  const pageContent = JSON.stringify(page);
  const entryHtml = jiaoyimaoSsrCard("1784550994519000");
  const repository = new ListingRepository(createDatabase(":memory:"));
  const fetcher = new RoutingFetcher((request) => {
    if (request.url === jiaoyimaoAdapter.entryUrl) {
      return ok(request.url, entryHtml);
    }
    if (request.url === APPROVED_JIAOYIMAO_MTOP_ENDPOINT) {
      return ok(request.url, pageContent);
    }
    if (request.url === product.detailUrlSeo) {
      if (failure === "fetch_failed") {
        return {
          kind: "failed",
          url: request.url,
          error: "request_timeout"
        };
      }
      if (failure === "parse_blocked") {
        return ok(request.url, "unrecognized detail page");
      }
      return ok(request.url, jiaoyimaoDetail(detailEvidence));
    }
    return {
      kind: "failed",
      url: request.url,
      error: "missing_fixture"
    };
  });

  await new CollectionCoordinator({
    adapters: [jiaoyimaoAdapter],
    fetcher,
    repository
  }).refreshAll();

  const listing = repository
    .getListings()
    .find(({ sourceListingId }) => sourceListingId === product.goodsId);
  if (!listing) throw new Error("expected collected MTop listing");
  return { fetcher, listing, detailUrl: product.detailUrlSeo };
}

interface StrictPaginationPage {
  itemIndexes: number[];
  hasNext: boolean;
}

async function collectStrictPaginationPages(
  pageSpecs: StrictPaginationPage[]
) {
  const entryUrl = "https://strict-jiaoyimao.test/";
  const pageUrl = (page: number) =>
    `https://strict-jiaoyimao.test/list/${page}`;
  const pageHtml = (page: number) => `strict-page-${page}`;
  const item = (index: number): ListingSummary =>
    summaryForSource("jiaoyimao", index, {
      rawText: "QQ官服 普通账号",
      priceCny: 7_001
    });
  const adapterOverrides = {
    source: "jiaoyimao" as const,
    entryUrl,
    strictPaginationProgress: true,
    discoverCatalog: () => ({
      kind: "ok" as const,
      request: { url: pageUrl(1) }
    }),
    parseList: (html: string) => {
      const page = Number(html.replace("strict-page-", ""));
      return {
        kind: "ok" as const,
        items:
          pageSpecs[page - 1]?.itemIndexes.map((index) => item(index)) ?? []
      };
    },
    nextPage: (html: string) => {
      const page = Number(html.replace("strict-page-", ""));
      return pageSpecs[page - 1]?.hasNext
        ? { url: pageUrl(page + 1) }
        : null;
    }
  };
  const adapter = fakeAdapter(adapterOverrides);
  const responses = new Map<string, FetchResult>([
    [entryUrl, ok(entryUrl, "home")],
    ...pageSpecs.map((_page, index) => {
      const page = index + 1;
      return [pageUrl(page), ok(pageUrl(page), pageHtml(page))] as const;
    })
  ]);
  const repository = new ListingRepository(createDatabase(":memory:"));
  const fetcher = new MapFetcher(responses);

  await new CollectionCoordinator({
    adapters: [adapter],
    fetcher,
    repository
  }).refreshAll();

  return {
    fetcher,
    status: sourceStatus(repository, "jiaoyimao")
  };
}

describe("CollectionCoordinator", () => {
  it("publishes bounded progress events for a persisted scan", async () => {
    const repository = new ListingRepository(createDatabase(":memory:"));
    const adapter = fakeAdapter();
    const fetcher = new RoutingFetcher((request) =>
      ok(request.url, "fixture")
    );
    const runId = repository.startScan(
      new Date("2026-07-29T10:00:00.000Z")
    );
    const events: RefreshProgressEvent[] = [];

    const state = await new CollectionCoordinator({
      adapters: [adapter],
      fetcher,
      repository,
      now: () => new Date("2026-07-29T10:00:00.000Z")
    }).refreshAll(runId, (event) => events.push(event));

    expect(state).toBe("success");
    expect(events.map(({ type }) => type)).toEqual([
      "source_start",
      "list_page",
      "detail_progress",
      "source_complete",
      "score",
      "commit",
      "complete"
    ]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "list_page",
          source: "panzhi",
          page: 1,
          summaries: 1,
          details: 0
        }),
        expect.objectContaining({
          type: "detail_progress",
          summaries: 1,
          details: 1
        }),
        expect.objectContaining({
          type: "complete",
          roundState: "success"
        })
      ])
    );
    expect(JSON.stringify(events)).not.toMatch(
      /cookie|token|https?:|棱镜攻势/i
    );
  });

  it("persists failed source outcomes when no source is fresh", async () => {
    const repository = new ListingRepository(createDatabase(":memory:"));
    repository.replaceSourceSnapshot(
      "panzhi",
      [makeListing({ scanStability: "stable", consecutiveUnchangedScans: 2 })],
      "success"
    );
    const runId = repository.startScan(
      new Date("2026-07-29T10:00:00.000Z")
    );

    const state = await new CollectionCoordinator({
      adapters: [fakeAdapter()],
      fetcher: new RoutingFetcher((request) => ({
        kind: "blocked",
        url: request.url,
        reason: "captcha_required"
      })),
      repository,
      now: () => new Date("2026-07-29T10:00:00.000Z")
    }).refreshAll(runId);

    expect(state).toBe("failed");
    expect(repository.getListings()).toHaveLength(1);
    expect(repository.getScanHistory(1)[0]).toMatchObject({
      state: "failed",
      sources: [
        expect.objectContaining({
          source: "panzhi",
          state: "blocked",
          observedItemCount: 0
        })
      ]
    });
  });

  it("marks the persisted run failed when snapshot commit throws", async () => {
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);
    database.exec(`
      CREATE TRIGGER fail_progress_commit
      BEFORE UPDATE ON source_status
      WHEN NEW.source = 'panzhi' AND NEW.state = 'success'
      BEGIN
        SELECT RAISE(ABORT, 'forced progress commit failure');
      END;
    `);
    const runId = repository.startScan(
      new Date("2026-07-29T10:00:00.000Z")
    );

    await expect(
      new CollectionCoordinator({
        adapters: [freshSourceAdapter("panzhi", 1)],
        fetcher: new RoutingFetcher((request) =>
          ok(request.url, "fixture")
        ),
        repository,
        now: () => new Date("2026-07-29T10:00:00.000Z")
      }).refreshAll(runId)
    ).rejects.toThrow("无法提交带历史的刷新快照");

    expect(repository.getScanHistory(1)[0]).toMatchObject({
      id: runId,
      state: "failed",
      error: "无法提交带历史的刷新快照"
    });
  });
  it.each([
    [
      "an early blocked return",
      (url: string): FetchResult => ({
        kind: "blocked",
        url,
        reason: "captcha_required"
      })
    ],
    [
      "a thrown fetch",
      async (): Promise<FetchResult> => {
        throw new Error("socket closed");
      }
    ]
  ])(
    "ends the source lifecycle after %s",
    async (_name, route) => {
      const repository = new ListingRepository(createDatabase(":memory:"));
      const adapter = fakeAdapter();
      const fetcher = new LifecycleFetcher((request) =>
        route(request.url)
      );

      await new CollectionCoordinator({
        adapters: [adapter],
        fetcher,
        repository
      }).refreshAll();

      expect(fetcher.events).toEqual([
        "begin:panzhi",
        `fetch:panzhi:${adapter.entryUrl}`,
        "end:panzhi"
      ]);
    }
  );

  it("begins before fetching and ends after a successful source refresh", async () => {
    const repository = new ListingRepository(createDatabase(":memory:"));
    const adapter = fakeAdapter({
      parseList: () => ({
        kind: "ok",
        items: [{ ...summary(), embeddedDetail: listingDetail() }]
      })
    });
    const fetcher = new LifecycleFetcher((request) => {
      if (request.url === adapter.entryUrl) {
        return ok(request.url, "home");
      }
      return ok(request.url, "list");
    });

    await new CollectionCoordinator({
      adapters: [adapter],
      fetcher,
      repository
    }).refreshAll();

    expect(fetcher.events).toEqual([
      "begin:panzhi",
      `fetch:panzhi:${adapter.entryUrl}`,
      "fetch:panzhi:https://source.test/list/1",
      "end:panzhi"
    ]);
  });

  it.each([
    {
      name: "a repeated page with another page advertised",
      pages: [
        { itemIndexes: [1], hasNext: true },
        { itemIndexes: [1], hasNext: true },
        { itemIndexes: [3], hasNext: false }
      ],
      expectedState: "partial",
      expectedStopReason: "pagination_stalled",
      expectedPagesScanned: 2,
      expectedItemCount: 1
    },
    {
      name: "a repeated terminal page",
      pages: [
        { itemIndexes: [1], hasNext: true },
        { itemIndexes: [1], hasNext: false }
      ],
      expectedState: "partial",
      expectedStopReason: "pagination_stalled",
      expectedPagesScanned: 2,
      expectedItemCount: 1
    },
    {
      name: "an empty page with another page advertised",
      pages: [
        { itemIndexes: [1], hasNext: true },
        { itemIndexes: [], hasNext: true },
        { itemIndexes: [3], hasNext: false }
      ],
      expectedState: "partial",
      expectedStopReason: "pagination_stalled",
      expectedPagesScanned: 2,
      expectedItemCount: 1
    },
    {
      name: "an explicitly empty terminal page",
      pages: [
        { itemIndexes: [1], hasNext: true },
        { itemIndexes: [], hasNext: false }
      ],
      expectedState: "success",
      expectedStopReason: "end_of_pages",
      expectedPagesScanned: 2,
      expectedItemCount: 1
    },
    {
      name: "a partially overlapping terminal page with one new ID",
      pages: [
        { itemIndexes: [1], hasNext: true },
        { itemIndexes: [1, 2], hasNext: false }
      ],
      expectedState: "success",
      expectedStopReason: "end_of_pages",
      expectedPagesScanned: 2,
      expectedItemCount: 2
    },
    {
      name: "a third page that repeats an earlier page",
      pages: [
        { itemIndexes: [1], hasNext: true },
        { itemIndexes: [2], hasNext: true },
        { itemIndexes: [1], hasNext: true },
        { itemIndexes: [4], hasNext: false }
      ],
      expectedState: "partial",
      expectedStopReason: "pagination_stalled",
      expectedPagesScanned: 3,
      expectedItemCount: 2
    }
  ])(
    "handles $name for a strict pagination source",
    async ({
      pages,
      expectedState,
      expectedStopReason,
      expectedPagesScanned,
      expectedItemCount
    }) => {
      const { fetcher, status } =
        await collectStrictPaginationPages(pages);

      expect(fetcher.calls).toEqual([
        "https://strict-jiaoyimao.test/",
        ...Array.from(
          { length: expectedPagesScanned },
          (_, index) =>
            `https://strict-jiaoyimao.test/list/${index + 1}`
        )
      ]);
      expect(status).toMatchObject({
        state: expectedState,
        stopReason: expectedStopReason,
        pagesScanned: expectedPagesScanned,
        itemCount: expectedItemCount
      });
    }
  );

  it("rejects a reentrant refresh before lifecycle hooks and allows a later refresh", async () => {
    const repository = new ListingRepository(createDatabase(":memory:"));
    const adapter = fakeAdapter({
      parseList: () => ({
        kind: "ok",
        items: [{ ...summary(), embeddedDetail: listingDetail() }]
      })
    });
    let releaseFirstEntry!: () => void;
    const firstEntryGate = new Promise<void>((resolve) => {
      releaseFirstEntry = resolve;
    });
    let signalFirstEntry!: () => void;
    const firstEntryStarted = new Promise<void>((resolve) => {
      signalFirstEntry = resolve;
    });
    let shouldWaitForEntry = true;
    const fetcher = new LifecycleFetcher(async (request) => {
      if (request.url === adapter.entryUrl && shouldWaitForEntry) {
        shouldWaitForEntry = false;
        signalFirstEntry();
        await firstEntryGate;
        return ok(request.url, "home");
      }
      return ok(request.url, "list");
    });
    const coordinator = new CollectionCoordinator({
      adapters: [adapter],
      fetcher,
      repository
    });

    const firstRefresh = coordinator.refreshAll();
    await firstEntryStarted;

    await expect(coordinator.refreshAll()).rejects.toThrow(
      "refresh_already_running"
    );
    expect(fetcher.events).toEqual([
      "begin:panzhi",
      `fetch:panzhi:${adapter.entryUrl}`
    ]);

    releaseFirstEntry();
    await firstRefresh;
    expect(fetcher.events.filter((event) => event === "begin:panzhi"))
      .toHaveLength(1);
    expect(fetcher.events.filter((event) => event === "end:panzhi"))
      .toHaveLength(1);

    await expect(coordinator.refreshAll()).resolves.toBeUndefined();
    expect(fetcher.events.filter((event) => event === "begin:panzhi"))
      .toHaveLength(2);
    expect(fetcher.events.filter((event) => event === "end:panzhi"))
      .toHaveLength(2);
  });

  it("releases the refresh lock after an uncaught refresh error", async () => {
    const repository = new ListingRepository(createDatabase(":memory:"));
    vi.spyOn(repository, "getListings").mockImplementationOnce(() => {
      throw new Error("derived refresh failed");
    });
    const coordinator = new CollectionCoordinator({
      adapters: [],
      fetcher: new MapFetcher(new Map()),
      repository
    });

    await expect(coordinator.refreshAll()).rejects.toThrow(
      "derived refresh failed"
    );
    await expect(coordinator.refreshAll()).resolves.toBeUndefined();
  });

  it("keeps explicit unknown embedded login authoritative", async () => {
    const repository = new ListingRepository(createDatabase(":memory:"));
    const item = {
      ...summary(),
      rawText: "QQ官服\nM7棱镜攻势(极品A)",
      embeddedDetail: {
        ...listingDetail(),
        evidence: [
          { text: "M7棱镜攻势(极品A)", truncated: false },
          { text: "QQ官服", truncated: false }
        ],
        loginPlatform: "unknown" as const,
        service: "unknown" as const
      }
    };
    const adapter = fakeAdapter({
      parseList: () => ({ kind: "ok", items: [item] })
    });
    const fetcher = new MapFetcher(
      new Map([
        [adapter.entryUrl, ok(adapter.entryUrl, "home")],
        ["https://source.test/list/1", ok("https://source.test/list/1", "list")]
      ])
    );

    await new CollectionCoordinator({
      adapters: [adapter],
      fetcher,
      repository
    }).refreshAll();

    expect(repository.getListings()[0]).toMatchObject({
      loginPlatform: "unknown",
      service: "unknown",
      eligibility: "needs_verification"
    });
  });

  it("does not join a character name and red-skin claim across records", async () => {
    const repository = new ListingRepository(createDatabase(":memory:"));
    const evidence = [
      { text: "M7棱镜攻势(极品A)", truncated: false },
      { text: "威龙 普通皮肤", truncated: false },
      { text: "账号有红皮", truncated: false }
    ];
    const item = {
      ...summary(),
      rawText: evidence.map(({ text }) => text).join("\n"),
      embeddedDetail: {
        ...listingDetail(),
        evidence
      }
    };
    const adapter = fakeAdapter({
      parseList: () => ({ kind: "ok", items: [item] })
    });
    const fetcher = new MapFetcher(
      new Map([
        [adapter.entryUrl, ok(adapter.entryUrl, "home")],
        ["https://source.test/list/1", ok("https://source.test/list/1", "list")]
      ])
    );

    await new CollectionCoordinator({
      adapters: [adapter],
      fetcher,
      repository
    }).refreshAll();

    expect(repository.getListings()[0]).toMatchObject({
      redSkins: [],
      redSkinUnnamed: true
    });
  });

  it("uses embedded detail without requesting the client product page", async () => {
    const repository = new ListingRepository(createDatabase(":memory:"));
    const item = {
      ...summary(),
      embeddedDetail: listingDetail()
    };
    const detailRequest = vi.fn((candidate: ListingSummary) => ({
      url: candidate.url
    }));
    const adapter = fakeAdapter({
      parseList: () => ({ kind: "ok", items: [item] }),
      detailRequest
    });
    const fetcher = new MapFetcher(
      new Map([
        [adapter.entryUrl, ok(adapter.entryUrl, "home")],
        ["https://source.test/list/1", ok("https://source.test/list/1", "list")]
      ])
    );

    await new CollectionCoordinator({
      adapters: [adapter],
      fetcher,
      repository
    }).refreshAll();

    expect(fetcher.calls).toEqual([
      adapter.entryUrl,
      "https://source.test/list/1"
    ]);
    expect(detailRequest).not.toHaveBeenCalled();
    expect(repository.getListings("eligible")).toHaveLength(1);
  });

  it("uses the MTop query hint for detail fetching without treating it as quality evidence", async () => {
    const { fetcher, listing, detailUrl } =
      await collectJiaoyimaoMtopItem(
        "M7战斗步枪-棱镜攻势S2"
      );

    expect(fetcher.calls.map(({ url }) => url)).toContain(detailUrl);
    expect(listing).toMatchObject({
      m7PrismStatus: "unknown",
      m7PrismQuality: null,
      redSkins: ["威龙"],
      julangStatus: "owned",
      julangQuality: "极品"
    });
    expect(listing.originalDescription).not.toContain(
      "M7战斗步枪-棱镜攻势S2(极品)"
    );
  });

  it.each(["S", "A", "B", "C"] as const)(
    "keeps exact MTop detail peak quality %s",
    async (quality) => {
      const { listing } = await collectJiaoyimaoMtopItem(
        `M7战斗步枪-棱镜攻势S2(极品${quality})`
      );

      expect(listing).toMatchObject({
        m7PrismStatus: "peak",
        m7PrismQuality: quality,
        redSkins: ["威龙"],
        julangStatus: "owned",
        julangQuality: "极品"
      });
    }
  );

  it("accepts bounded truncated MTop peak evidence with its local quality", async () => {
    const { listing } = await collectJiaoyimaoMtopItem(
      "典藏传说枪械极品|Bx1M7战...势S2优品|Ax2其它枪械"
    );

    expect(listing).toMatchObject({
      loginPlatform: "qq",
      service: "official",
      m7PrismStatus: "peak",
      m7PrismQuality: "B",
      eligibility: "eligible"
    });
    expect(listing.priceCny).not.toBeNull();
    expect(listing.priceCny).toBeLessThanOrEqual(6_000);
  });

  it("keeps MTop premium detail evidence out of conflict", async () => {
    const { listing } = await collectJiaoyimaoMtopItem(
      "M7战斗步枪-棱镜攻势S2(优品B)"
    );

    expect(listing).toMatchObject({
      m7PrismStatus: "premium",
      m7PrismQuality: "B",
      eligibility: "rejected"
    });
  });

  it("admits a bounded MTop premium S listing", async () => {
    const { listing } = await collectJiaoyimaoMtopItem(
      "M7战斗步枪-棱镜攻势S2(优品S)"
    );

    expect(listing).toMatchObject({
      loginPlatform: "qq",
      service: "official",
      m7PrismStatus: "premium",
      m7PrismQuality: "S",
      eligibility: "eligible"
    });
  });

  it("trusts a successful hinted detail without M7 as absent", async () => {
    const { listing } = await collectJiaoyimaoMtopItem(
      "QQ官服 普通账号"
    );

    expect(listing).toMatchObject({
      m7PrismStatus: "absent",
      m7PrismQuality: null,
      eligibility: "rejected",
      parseWarnings: []
    });
  });

  it.each([
    [
      "a failed detail fetch",
      "fetch_failed",
      "详情获取失败：request_timeout"
    ],
    [
      "a blocked detail parser",
      "parse_blocked",
      "详情解析受阻：structure_changed"
    ]
  ] as const)(
    "keeps a hinted MTop listing in review after %s",
    async (_label, failure, warning) => {
      const { fetcher, listing, detailUrl } =
        await collectJiaoyimaoMtopItem("", failure);

      expect(fetcher.calls.map(({ url }) => url)).toContain(detailUrl);
      expect(listing).toMatchObject({
        m7PrismStatus: "unknown",
        m7PrismQuality: null,
        eligibility: "needs_verification",
        parseWarnings: [warning]
      });
    }
  );

  it("retains the previous source snapshot after three consecutive blocked details", async () => {
    const repository = new ListingRepository(createDatabase(":memory:"));
    repository.replaceSourceSnapshot(
      "jiaoyimao",
      [
        makeListing({
          source: "jiaoyimao",
          key: "jiaoyimao:old",
          sourceListingId: "old"
        })
      ],
      "success",
      new Date("2026-07-28T12:00:00.000Z")
    );
    const items = Array.from({ length: 3 }, (_, index) =>
      summaryForSource("jiaoyimao", index + 1, {
        detailFetchHint: "m7_prism_query"
      })
    );
    const adapter = fakeAdapter({
      source: "jiaoyimao",
      parseList: () => ({ kind: "ok", items })
    });
    const responses = new Map<string, FetchResult>([
      [adapter.entryUrl, ok(adapter.entryUrl, "home")],
      ["https://source.test/list/1", ok("https://source.test/list/1", "list")],
      ...items.map(
        (item) =>
          [
            item.url,
            {
              kind: "blocked",
              url: item.url,
              reason: "captcha_required"
            }
          ] as const
      )
    ]);

    await new CollectionCoordinator({
      adapters: [adapter],
      fetcher: new MapFetcher(responses),
      repository,
      now: () => new Date("2026-07-29T12:00:00.000Z")
    }).refreshAll();

    expect(repository.getListings()).toHaveLength(1);
    expect(repository.getListing("jiaoyimao:old")).not.toBeNull();
    expect(sourceStatus(repository, "jiaoyimao")).toMatchObject({
      state: "blocked",
      error: "captcha_required",
      itemCount: 1,
      lastSuccessAt: "2026-07-28T12:00:00.000Z"
    });
  });

  it("keeps substantial fresh data as partial after a late detail circuit break", async () => {
    const repository = new ListingRepository(createDatabase(":memory:"));
    const items = Array.from({ length: 23 }, (_, index) =>
      summaryForSource("jiaoyimao", index + 1, {
        detailFetchHint: "m7_prism_query"
      })
    );
    const adapter = fakeAdapter({
      source: "jiaoyimao",
      parseList: () => ({ kind: "ok", items }),
      parseDetail: (html) =>
        html === "detail-ok"
          ? { kind: "ok", detail: listingDetail() }
          : { kind: "blocked", reason: "structure_changed" }
    });
    const responses = new Map<string, FetchResult>([
      [adapter.entryUrl, ok(adapter.entryUrl, "home")],
      ["https://source.test/list/1", ok("https://source.test/list/1", "list")],
      ...items.map(
        (item, index) =>
          [
            item.url,
            ok(item.url, index < 20 ? "detail-ok" : "detail-blocked")
          ] as const
      )
    ]);

    await new CollectionCoordinator({
      adapters: [adapter],
      fetcher: new MapFetcher(responses),
      repository,
      now: () => new Date("2026-07-29T12:00:00.000Z")
    }).refreshAll();

    expect(repository.getListings()).toHaveLength(23);
    expect(repository.getListings("eligible")).toHaveLength(20);
    expect(repository.getListings("needs_verification")).toHaveLength(3);
    expect(sourceStatus(repository, "jiaoyimao")).toMatchObject({
      state: "partial",
      itemCount: 23,
      pagesScanned: 1,
      error: "structure_changed"
    });
  });

  it("keeps a truly unhinted summary without M7 evidence rejected", async () => {
    const repository = new ListingRepository(createDatabase(":memory:"));
    const adapter = fakeAdapter({
      parseList: () => ({
        kind: "ok",
        items: [{
          ...summary(),
          rawText: "QQ官服 普通账号"
        }]
      })
    });
    const fetcher = new MapFetcher(
      new Map([
        [adapter.entryUrl, ok(adapter.entryUrl, "home")],
        ["https://source.test/list/1", ok("https://source.test/list/1", "list")]
      ])
    );

    await new CollectionCoordinator({
      adapters: [adapter],
      fetcher,
      repository
    }).refreshAll();

    expect(repository.getListings()[0]).toMatchObject({
      m7PrismStatus: "absent",
      m7PrismQuality: null,
      eligibility: "rejected"
    });
  });

  it("keeps explicit negative M7 evidence rejected after hinted detail failure", async () => {
    const repository = new ListingRepository(createDatabase(":memory:"));
    const item = {
      ...summary(),
      rawText: "QQ官服 M7无棱镜攻势",
      detailFetchHint: "m7_prism_query" as const
    };
    const adapter = fakeAdapter({
      parseList: () => ({ kind: "ok", items: [item] })
    });
    const fetcher = new MapFetcher(
      new Map([
        [adapter.entryUrl, ok(adapter.entryUrl, "home")],
        ["https://source.test/list/1", ok("https://source.test/list/1", "list")],
        [
          item.url,
          { kind: "failed", url: item.url, error: "request_timeout" }
        ]
      ])
    );

    await new CollectionCoordinator({
      adapters: [adapter],
      fetcher,
      repository
    }).refreshAll();

    expect(repository.getListings()[0]).toMatchObject({
      m7PrismStatus: "absent",
      m7PrismQuality: null,
      eligibility: "rejected"
    });
  });

  it("fetches more than twenty matching details under production defaults", async () => {
    const repository = new ListingRepository(createDatabase(":memory:"));
    const items = Array.from({ length: 21 }, (_, index) => ({
      ...summary(index + 1),
      rawText: "QQ官服 查询匹配",
      detailFetchHint: "m7_prism_query" as const
    }));
    const adapter = fakeAdapter({
      parseList: () => ({ kind: "ok", items })
    });
    const responses = new Map<string, FetchResult>([
      [adapter.entryUrl, ok(adapter.entryUrl, "home")],
      ["https://source.test/list/1", ok("https://source.test/list/1", "list")]
    ]);
    for (const item of items) {
      responses.set(item.url, ok(item.url, "detail"));
    }
    const fetcher = new MapFetcher(responses);

    await new CollectionCoordinator({
      adapters: [adapter],
      fetcher,
      repository
    }).refreshAll();

    expect(fetcher.calls.filter((url) => url.includes("/detail/")))
      .toHaveLength(21);
    expect(
      repository
        .getListings()
        .find(({ sourceListingId }) => sourceListingId === "S21")
    ).toMatchObject({
      m7PrismStatus: "peak",
      eligibility: "eligible",
      parseWarnings: []
    });
    expect(sourceStatus(repository)).toMatchObject({
      state: "success",
      pagesScanned: 1,
      stopReason: "end_of_pages"
    });
  });

  it.each(["B", "C"] as const)(
    "sends SSR peak quality %s through the real detail prefilter",
    async (quality) => {
      const id = quality === "B"
        ? "1784550994519444"
        : "1784550994519555";
      const detailUrl =
        `https://www.jiaoyimao.com/jg2007840/${id}.html`;
      const entryHtml = jiaoyimaoSsrCard(
        id,
        `M7-极品${quality} 安卓QQ`
      );
      const terminalMtopPage = JSON.stringify({
        ret: ["SUCCESS::调用成功"],
        data: {
          result: {
            hasNextPage: "false",
            deliverComps: []
          }
        }
      });
      const repository = new ListingRepository(createDatabase(":memory:"));
      const fetcher = new RoutingFetcher((request) => {
        if (request.url === jiaoyimaoAdapter.entryUrl) {
          return ok(request.url, entryHtml);
        }
        if (request.url === APPROVED_JIAOYIMAO_MTOP_ENDPOINT) {
          return ok(request.url, terminalMtopPage);
        }
        if (request.url === detailUrl) {
          return ok(
            request.url,
            jiaoyimaoDetail(
              `M7战斗步枪-棱镜攻势S2(极品${quality})`
            )
          );
        }
        return {
          kind: "failed",
          url: request.url,
          error: "missing_fixture"
        };
      });

      await new CollectionCoordinator({
        adapters: [jiaoyimaoAdapter],
        fetcher,
        repository
      }).refreshAll();

      expect(fetcher.calls.map(({ url }) => url)).toContain(detailUrl);
      expect(repository.getListings()[0]).toMatchObject({
        m7PrismStatus: "peak",
        m7PrismQuality: quality
      });
    }
  );

  it("stops before fetching the same request fingerprint twice", async () => {
    const repository = new ListingRepository(createDatabase(":memory:"));
    const listRequest = {
      url: "https://source.test/list/1?a=1&b=2"
    };
    const reorderedRequest = {
      url: "https://source.test/list/1?b=2&a=1"
    };
    const adapter = fakeAdapter({
      discoverCatalog: () => ({
        kind: "ok",
        request: listRequest
      }),
      parseList: () => ({
        kind: "ok",
        items: [
          {
            ...summary(),
            rawText: "QQ官服 普通账号"
          }
        ]
      }),
      nextPage: () => reorderedRequest
    });
    const fetcher = new MapFetcher(
      new Map([
        [adapter.entryUrl, ok(adapter.entryUrl, "home")],
        [listRequest.url, ok(listRequest.url, "list")]
      ])
    );

    await new CollectionCoordinator({
      adapters: [adapter],
      fetcher,
      repository
    }).refreshAll();

    expect(fetcher.calls).toEqual([adapter.entryUrl, listRequest.url]);
    expect(
      repository
        .getSourceStatuses()
        .find(({ source }) => source === "panzhi")
    ).toMatchObject({
      state: "success",
      itemCount: 1,
      pagesScanned: 1,
      stopReason: "repeated_request"
    });
  });

  it("keeps request fingerprints local to concurrent refreshes", async () => {
    const item = {
      ...summary(),
      embeddedDetail: listingDetail()
    };
    const adapter = fakeAdapter({
      parseList: () => ({ kind: "ok", items: [item] })
    });
    const setupRun = () => {
      const repository = new ListingRepository(createDatabase(":memory:"));
      const fetcher = new MapFetcher(
        new Map([
          [adapter.entryUrl, ok(adapter.entryUrl, "home")],
          [
            "https://source.test/list/1",
            ok("https://source.test/list/1", "list")
          ]
        ])
      );
      return {
        repository,
        fetcher,
        coordinator: new CollectionCoordinator({
          adapters: [adapter],
          fetcher,
          repository
        })
      };
    };
    const first = setupRun();
    const second = setupRun();

    await Promise.all([
      first.coordinator.refreshAll(),
      second.coordinator.refreshAll()
    ]);

    expect(first.fetcher.calls).toEqual([
      adapter.entryUrl,
      "https://source.test/list/1"
    ]);
    expect(second.fetcher.calls).toEqual([
      adapter.entryUrl,
      "https://source.test/list/1"
    ]);
    expect(first.repository.getListings()).toHaveLength(1);
    expect(second.repository.getListings()).toHaveLength(1);
  });

  it("discovers, follows visible pagination, merges detail, and stores results", async () => {
    const repository = new ListingRepository(createDatabase(":memory:"));
    const adapter = fakeAdapter({
      parseList: (html) => ({
        kind: "ok",
        items: [summary(html === "page-one" ? 1 : 2)]
      }),
      nextPage: (html) =>
        html === "page-one"
          ? { url: "https://source.test/list/2" }
          : null
    });
    const fetcher = new MapFetcher(
      new Map([
        [adapter.entryUrl, ok(adapter.entryUrl, "home")],
        ["https://source.test/list/1", ok("https://source.test/list/1", "page-one")],
        ["https://source.test/list/2", ok("https://source.test/list/2", "page-two")],
        [summary(1).url, ok(summary(1).url, "detail-one")],
        [summary(2).url, ok(summary(2).url, "detail-two")]
      ])
    );
    const coordinator = new CollectionCoordinator({
      adapters: [adapter],
      fetcher,
      repository,
      now: () => new Date("2026-07-28T10:00:00.000Z")
    });

    await coordinator.refreshAll();

    expect(fetcher.calls).toEqual([
      adapter.entryUrl,
      "https://source.test/list/1",
      summary(1).url,
      "https://source.test/list/2",
      summary(2).url
    ]);
    expect(repository.getListings("eligible")).toHaveLength(2);
    expect(repository.getListings("eligible")[0]).toMatchObject({
      m7PrismStatus: "peak",
      redSkins: ["威龙"],
      julangStatus: "owned",
      score: { total: expect.any(Number) }
    });
    expect(repository.getSourceStatuses()[1]).toMatchObject({
      source: "panzhi",
      state: "success",
      itemCount: 2,
      pagesScanned: 2,
      stopReason: "end_of_pages"
    });
  });

  it("stores only M7 rare finishes supported by merged listing evidence", async () => {
    const repository = new ListingRepository(createDatabase(":memory:"));
    const adapter = fakeAdapter({
      parseList: () => ({
        kind: "ok",
        items: [
          {
            ...summary(),
            embeddedDetail: {
              ...listingDetail(),
              evidence: [
                { text: "M7战斗步枪-棱镜攻势S2(极品A)", truncated: false },
                {
                  text: "市场价5万+三角券的珠光粉M7",
                  truncated: false
                },
                {
                  text: "极品M7说明文字炫彩MP7",
                  truncated: false
                }
              ]
            }
          }
        ]
      })
    });
    const fetcher = new MapFetcher(
      new Map([
        [adapter.entryUrl, ok(adapter.entryUrl, "home")],
        ["https://source.test/list/1", ok("https://source.test/list/1", "list")]
      ])
    );
    const coordinator = new CollectionCoordinator({
      adapters: [adapter],
      fetcher,
      repository,
      now: () => new Date("2026-07-28T10:00:00.000Z")
    });

    await coordinator.refreshAll();

    expect(repository.getListings("eligible")[0]).toMatchObject({
      m7RareFinishes: ["pearl"],
      m7RareFinishEvidence: [
        {
          text: "市场价5万+三角券的珠光粉M7",
          truncated: false
        }
      ]
    });
  });

  it("collects every source before replacing any stored snapshot", async () => {
    const repository = new ListingRepository(createDatabase(":memory:"));
    repository.replaceSourceSnapshot(
      "panzhi",
      [
        makeListing({
          key: "panzhi:old",
          sourceListingId: "old"
        })
      ],
      "success"
    );
    repository.replaceSourceSnapshot(
      "pxb7",
      [
        makeListing({
          source: "pxb7",
          key: "pxb7:old",
          sourceListingId: "old"
        })
      ],
      "success"
    );
    const adapters = [
      freshSourceAdapter("panzhi", 1),
      freshSourceAdapter("pxb7", 1)
    ];
    let panzhiSnapshotDuringPxb7Fetch: string[] = [];
    const fetcher = new RoutingFetcher((request) => {
      if (request.url === adapters[1].entryUrl) {
        panzhiSnapshotDuringPxb7Fetch = repository
          .getListings()
          .filter(({ source }) => source === "panzhi")
          .map(({ key }) => key);
      }
      return ok(request.url, "fixture");
    });

    await new CollectionCoordinator({
      adapters,
      fetcher,
      repository
    }).refreshAll();

    expect(panzhiSnapshotDuringPxb7Fetch).toEqual(["panzhi:old"]);
    expect(repository.getListings().map(({ key }) => key)).toEqual([
      "panzhi:panzhi-1",
      "pxb7:pxb7-1"
    ]);
  });

  it("rolls back every listing and source status when the atomic refresh commit fails", async () => {
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);
    const oldCapturedAt = new Date("2026-07-27T10:00:00.000Z");
    repository.replaceSourceSnapshot(
      "panzhi",
      [
        makeListing({
          key: "panzhi:old",
          sourceListingId: "old",
          score: {
            ...makeScore(90, {
              m7: 20,
              redSkins: 15,
              julang: 15,
              price: 15,
              assets: 8,
              secondRealName: 40,
              recovery: 35,
              verification: 25
            }),
            reasons: ["old"]
          }
        })
      ],
      "success",
      oldCapturedAt
    );
    repository.replaceSourceSnapshot(
      "pxb7",
      [
        makeListing({
          source: "pxb7",
          key: "pxb7:old",
          sourceListingId: "old"
        })
      ],
      "partial",
      oldCapturedAt,
      {
        pagesScanned: 2,
        stopReason: "error",
        error: "old_partial"
      }
    );
    const beforeListings = repository.getListings();
    const beforeStatuses = repository.getSourceStatuses(oldCapturedAt);
    database.exec(`
      CREATE TRIGGER abort_second_source_status
      BEFORE UPDATE ON source_status
      WHEN NEW.source = 'pxb7' AND NEW.state = 'success'
      BEGIN
        SELECT RAISE(ABORT, 'forced atomic refresh failure');
      END;
    `);
    const adapters = [
      freshSourceAdapter("panzhi", 1),
      freshSourceAdapter("pxb7", 1)
    ];

    await expect(
      new CollectionCoordinator({
        adapters,
        fetcher: new RoutingFetcher((request) =>
          ok(request.url, "fixture")
        ),
        repository,
        now: () => new Date("2026-07-28T12:00:00.000Z")
      }).refreshAll()
    ).rejects.toThrow();

    expect(repository.getListings()).toEqual(beforeListings);
    expect(
      repository.getSourceStatuses(oldCapturedAt)
    ).toEqual(beforeStatuses);
  });

  it("keeps failed old payloads unscored while scoring other fresh sources", async () => {
    const repository = new ListingRepository(createDatabase(":memory:"));
    const oldScore = {
      ...makeScore(99, {
        m7: 20,
        redSkins: 20,
        julang: 15,
        price: 20,
        assets: 10,
        secondRealName: 40,
        recovery: 35,
        verification: 25
      }),
      reasons: ["stale"]
    };
    repository.replaceSourceSnapshot(
      "jiaoyimao",
      [
        makeListing({
          source: "jiaoyimao",
          key: "jiaoyimao:old",
          sourceListingId: "old",
          capturedAt: "2026-07-27T00:00:00.000Z",
          priceCny: 6_000,
          totalAssetsM: 1_000,
          score: oldScore,
          possibleDuplicateKeys: ["panzhi:duplicate"]
        })
      ],
      "success"
    );
    const oldStatus = sourceStatus(repository, "jiaoyimao");
    const blockedAdapter = fakeAdapter({
      source: "jiaoyimao",
      entryUrl: "https://blocked.test/"
    });
    const workingAdapter = fakeAdapter();
    const fetcher = new MapFetcher(
      new Map([
        [
          blockedAdapter.entryUrl,
          {
            kind: "blocked",
            url: blockedAdapter.entryUrl,
            reason: "captcha_required"
          }
        ],
        [workingAdapter.entryUrl, ok(workingAdapter.entryUrl, "home")],
        ["https://source.test/list/1", ok("https://source.test/list/1", "list")],
        [summary().url, ok(summary().url, "detail")]
      ])
    );

    await new CollectionCoordinator({
      adapters: [blockedAdapter, workingAdapter],
      fetcher,
      repository
    }).refreshAll();

    expect(repository.getListing("jiaoyimao:old")).not.toBeNull();
    expect(
      repository
        .getSourceStatuses()
        .find(({ source }) => source === "jiaoyimao")
    ).toMatchObject({
      state: "blocked",
      pagesScanned: 0,
      stopReason: "error",
      error: "captcha_required",
      itemCount: oldStatus?.itemCount,
      lastSuccessAt: oldStatus?.lastSuccessAt
    });
    expect(repository.getListing("jiaoyimao:old")).toMatchObject({
      score: null,
      possibleDuplicateKeys: []
    });
    expect(
      repository.getListings().find(({ source }) => source === "panzhi")
        ?.score?.parts
    ).toMatchObject({
      price: 12.5,
      assets: 5.5
    });
  });

  it("scores a successful refresh when the injected clock moves backward", async () => {
    const repository = new ListingRepository(createDatabase(":memory:"));
    const item = {
      ...summary(),
      embeddedDetail: listingDetail()
    };
    const adapter = fakeAdapter({
      parseList: () => ({ kind: "ok", items: [item] })
    });
    const fetcher = new MapFetcher(
      new Map([
        [adapter.entryUrl, ok(adapter.entryUrl, "home")],
        ["https://source.test/list/1", ok("https://source.test/list/1", "list")]
      ])
    );
    const times = [
      new Date("2026-07-28T12:00:00.000Z"),
      new Date("2026-07-28T11:59:00.000Z"),
      new Date("2026-07-28T12:01:00.000Z")
    ];
    let timeIndex = 0;

    await new CollectionCoordinator({
      adapters: [adapter],
      fetcher,
      repository,
      now: () => times[Math.min(timeIndex++, times.length - 1)]
    }).refreshAll();

    expect(repository.getListings()[0]).toMatchObject({
      capturedAt: "2026-07-28T12:00:00.000Z",
      score: { total: expect.any(Number) }
    });
  });

  it("collects more than three pages and sixty unique summaries by default", async () => {
    const repository = new ListingRepository(createDatabase(":memory:"));
    const pageItems = new Map(
      Array.from({ length: 4 }, (_, pageIndex) => [
        `page-${pageIndex + 1}`,
        Array.from({ length: 16 }, (_, itemIndex) => ({
          ...summary(pageIndex * 16 + itemIndex + 1),
          rawText: "QQ官服 普通账号"
        }))
      ])
    );
    const adapter = fakeAdapter({
      parseList: (html) => ({
        kind: "ok",
        items: pageItems.get(html) ?? []
      }),
      nextPage: (html) => {
        const page = Number(html.replace("page-", ""));
        return page < 4
          ? { url: `https://source.test/list/${page + 1}` }
          : null;
      }
    });
    const responses = new Map<string, FetchResult>([
      [adapter.entryUrl, ok(adapter.entryUrl, "home")],
      ...Array.from({ length: 4 }, (_, pageIndex) => {
        const page = pageIndex + 1;
        const url = `https://source.test/list/${page}`;
        return [url, ok(url, `page-${page}`)] as const;
      })
    ]);

    await new CollectionCoordinator({
      adapters: [adapter],
      fetcher: new MapFetcher(responses),
      repository
    }).refreshAll();

    expect(repository.getListings()).toHaveLength(64);
    expect(sourceStatus(repository)).toMatchObject({
      state: "success",
      itemCount: 64,
      pagesScanned: 4,
      stopReason: "end_of_pages"
    });
  });

  it("deduplicates canonical listing URLs without replacing the first record", async () => {
    const repository = new ListingRepository(createDatabase(":memory:"));
    const first = {
      ...summary(1),
      sourceListingId: null,
      url: "https://SOURCE.test/detail/1?b=2&a=1",
      title: "第一页有效标题",
      rawText: "QQ官服 普通账号",
      priceCny: 1_888
    };
    const duplicate = {
      ...first,
      url: "https://source.test/detail/1?a=1&utm_campaign=x&b=2#card",
      title: "重复页不应覆盖",
      priceCny: 5_999
    };
    const adapter = fakeAdapter({
      parseList: (html) => ({
        kind: "ok",
        items: html === "page-one" ? [first] : [duplicate]
      }),
      nextPage: (html) =>
        html === "page-one"
          ? { url: "https://source.test/list/2" }
          : null
    });
    const fetcher = new MapFetcher(
      new Map([
        [adapter.entryUrl, ok(adapter.entryUrl, "home")],
        ["https://source.test/list/1", ok("https://source.test/list/1", "page-one")],
        ["https://source.test/list/2", ok("https://source.test/list/2", "page-two")]
      ])
    );

    await new CollectionCoordinator({
      adapters: [adapter],
      fetcher,
      repository
    }).refreshAll();

    expect(fetcher.calls).toHaveLength(3);
    expect(repository.getListings()).toHaveLength(1);
    expect(repository.getListings()[0]).toMatchObject({
      title: "第一页有效标题",
      priceCny: 1_888
    });
    expect(sourceStatus(repository)).toMatchObject({
      state: "success",
      pagesScanned: 2,
      stopReason: "no_new_items"
    });
  });

  it("deduplicates one URL when a later page adds a stable ID", async () => {
    const repository = new ListingRepository(createDatabase(":memory:"));
    const withoutId = {
      ...summary(1),
      sourceListingId: null,
      url: "https://source.test/detail/shared",
      title: "无 ID 的首条有效记录",
      rawText: "QQ官服 普通账号"
    };
    const withId = {
      ...withoutId,
      sourceListingId: "stable-id",
      title: "后页 ID 别名不应覆盖"
    };
    const adapter = fakeAdapter({
      parseList: (html) => ({
        kind: "ok",
        items: html === "page-one" ? [withoutId] : [withId]
      }),
      nextPage: (html) =>
        html === "page-one"
          ? { url: "https://source.test/list/2" }
          : null
    });
    const fetcher = new MapFetcher(
      new Map([
        [adapter.entryUrl, ok(adapter.entryUrl, "home")],
        ["https://source.test/list/1", ok("https://source.test/list/1", "page-one")],
        ["https://source.test/list/2", ok("https://source.test/list/2", "page-two")]
      ])
    );

    await new CollectionCoordinator({
      adapters: [adapter],
      fetcher,
      repository
    }).refreshAll();

    expect(repository.getListings()).toHaveLength(1);
    expect(repository.getListings()[0]).toMatchObject({
      sourceListingId: null,
      title: "无 ID 的首条有效记录"
    });
    expect(sourceStatus(repository)).toMatchObject({
      state: "success",
      pagesScanned: 2,
      stopReason: "no_new_items"
    });
  });

  it("marks a later page failure partial and scores its fresh snapshot", async () => {
    const repository = new ListingRepository(createDatabase(":memory:"));
    const freshItem = {
      ...summary(),
      embeddedDetail: listingDetail()
    };
    const adapter = fakeAdapter({
      parseList: () => ({ kind: "ok", items: [freshItem] }),
      nextPage: () => ({ url: "https://source.test/list/2" })
    });
    const fetcher = new MapFetcher(
      new Map([
        [adapter.entryUrl, ok(adapter.entryUrl, "home")],
        ["https://source.test/list/1", ok("https://source.test/list/1", "page-one")],
        [
          "https://source.test/list/2",
          {
            kind: "failed",
            url: "https://source.test/list/2",
            error: "request_timeout"
          }
        ]
      ])
    );

    await new CollectionCoordinator({
      adapters: [adapter],
      fetcher,
      repository,
      now: () => new Date("2026-07-28T12:00:00.000Z")
    }).refreshAll();

    expect(repository.getListings()[0].score).not.toBeNull();
    expect(sourceStatus(repository)).toMatchObject({
      state: "partial",
      itemCount: 1,
      pagesScanned: 1,
      stopReason: "error",
      error: "request_timeout"
    });
  });

  it("uses one normalization set for fresh listings from different sources", async () => {
    const repository = new ListingRepository(createDatabase(":memory:"));
    const cheap = summaryForSource("panzhi", 1, {
      priceCny: 1_000,
      embeddedDetail: {
        ...listingDetail(),
        totalAssetsM: 100,
        hafCoins: 10
      }
    });
    const rich = summaryForSource("pxb7", 1, {
      priceCny: 5_000,
      embeddedDetail: {
        ...listingDetail(),
        totalAssetsM: 500,
        hafCoins: 50
      }
    });
    const makeSourceAdapter = (
      source: ListingSummary["source"],
      item: ListingSummary
    ): SourceAdapter =>
      fakeAdapter({
        source,
        entryUrl: `https://${source}.test/`,
        discoverCatalog: () => ({
          kind: "ok",
          request: { url: `https://${source}.test/list/1` }
        }),
        parseList: () => ({ kind: "ok", items: [item] })
      });
    const adapters = [
      makeSourceAdapter("panzhi", cheap),
      makeSourceAdapter("pxb7", rich)
    ];
    const fetcher = new MapFetcher(
      new Map(
        adapters.flatMap((adapter) => [
          [adapter.entryUrl, ok(adapter.entryUrl, "home")],
          [
            `https://${adapter.source}.test/list/1`,
            ok(`https://${adapter.source}.test/list/1`, "list")
          ]
        ])
      )
    );

    await new CollectionCoordinator({
      adapters,
      fetcher,
      repository,
      now: () => new Date("2026-07-28T12:00:00.000Z")
    }).refreshAll();

    const listings = repository.getListings();
    expect(listings.find(({ source }) => source === "panzhi")?.score?.parts)
      .toMatchObject({ price: 25, assets: 1 });
    expect(listings.find(({ source }) => source === "pxb7")?.score?.parts)
      .toMatchObject({ price: 0, assets: 10 });
  });

  it("stops at an injected page safety limit deterministically", async () => {
    const repository = new ListingRepository(createDatabase(":memory:"));
    const adapter = fakeAdapter({
      parseList: (html) => ({
        kind: "ok",
        items: [{
          ...summary(Number(html.replace("page-", ""))),
          rawText: "QQ官服 普通账号"
        }]
      }),
      nextPage: (html) => ({
        url: `https://source.test/list/${Number(html.replace("page-", "")) + 1}`
      })
    });
    const fetcher = new RoutingFetcher((request) => {
      if (request.url === adapter.entryUrl) {
        return ok(request.url, "home");
      }
      const page = request.url.match(/\/list\/(\d+)/)?.[1] ?? "1";
      return ok(request.url, `page-${page}`);
    });

    await new CollectionCoordinator({
      adapters: [adapter],
      fetcher,
      repository,
      limits: { maxPages: 2, maxSummaries: 8, maxDetails: 4 }
    }).refreshAll();

    expect(fetcher.calls.map(({ url }) => url)).toEqual([
      adapter.entryUrl,
      "https://source.test/list/1",
      "https://source.test/list/2"
    ]);
    expect(repository.getListings()).toHaveLength(2);
    expect(sourceStatus(repository)).toMatchObject({
      state: "partial",
      pagesScanned: 2,
      stopReason: "safety_limit"
    });
  });

  it("keeps the first unique summaries at an injected summary safety limit", async () => {
    const repository = new ListingRepository(createDatabase(":memory:"));
    const items = Array.from({ length: 5 }, (_, index) => ({
      ...summary(index + 1),
      rawText: "QQ官服 普通账号"
    }));
    const adapter = fakeAdapter({
      parseList: () => ({ kind: "ok", items })
    });
    const fetcher = new MapFetcher(
      new Map([
        [adapter.entryUrl, ok(adapter.entryUrl, "home")],
        ["https://source.test/list/1", ok("https://source.test/list/1", "list")]
      ])
    );

    await new CollectionCoordinator({
      adapters: [adapter],
      fetcher,
      repository,
      limits: { maxPages: 5, maxSummaries: 3, maxDetails: 4 }
    }).refreshAll();

    expect(repository.getListings().map(({ sourceListingId }) => sourceListingId))
      .toEqual(["S1", "S2", "S3"]);
    expect(sourceStatus(repository)).toMatchObject({
      state: "partial",
      itemCount: 3,
      pagesScanned: 1,
      stopReason: "safety_limit"
    });
  });

  it("keeps deferred hinted items in review at an injected detail safety limit", async () => {
    const repository = new ListingRepository(createDatabase(":memory:"));
    const items = Array.from({ length: 5 }, (_, index) => ({
      ...summary(index + 1),
      rawText: "QQ官服 查询匹配",
      detailFetchHint: "m7_prism_query" as const
    }));
    const adapter = fakeAdapter({
      parseList: () => ({ kind: "ok", items })
    });
    const responses = new Map<string, FetchResult>([
      [adapter.entryUrl, ok(adapter.entryUrl, "home")],
      ["https://source.test/list/1", ok("https://source.test/list/1", "list")],
      ...items.map((item) => [item.url, ok(item.url, "detail")] as const)
    ]);
    const fetcher = new MapFetcher(responses);

    await new CollectionCoordinator({
      adapters: [adapter],
      fetcher,
      repository,
      limits: { maxPages: 5, maxSummaries: 8, maxDetails: 4 }
    }).refreshAll();

    expect(fetcher.calls.filter((url) => url.includes("/detail/")))
      .toHaveLength(4);
    expect(
      repository
        .getListings()
        .find(({ sourceListingId }) => sourceListingId === "S5")
    ).toMatchObject({
      eligibility: "needs_verification",
      m7PrismStatus: "unknown",
      parseWarnings: ["达到详情采集上限，待人工核验"]
    });
    expect(sourceStatus(repository)).toMatchObject({
      state: "partial",
      itemCount: 5,
      pagesScanned: 1,
      stopReason: "safety_limit"
    });
  });

  it("keeps a summary at needs verification when detail fetch fails", async () => {
    const repository = new ListingRepository(createDatabase(":memory:"));
    const adapter = fakeAdapter();
    const fetcher = new MapFetcher(
      new Map([
        [adapter.entryUrl, ok(adapter.entryUrl, "home")],
        ["https://source.test/list/1", ok("https://source.test/list/1", "list")],
        [
          summary().url,
          { kind: "failed", url: summary().url, error: "request_timeout" }
        ]
      ])
    );

    await new CollectionCoordinator({
      adapters: [adapter],
      fetcher,
      repository
    }).refreshAll();

    expect(repository.getListings()[0]).toMatchObject({
      eligibility: "needs_verification",
      parseWarnings: ["详情获取失败：request_timeout"]
    });
    expect(sourceStatus(repository)).toMatchObject({
      state: "partial",
      error: "request_timeout"
    });
  });

  it("returns the repository partial state when a complete source is quarantined", async () => {
    const repository = new ListingRepository(createDatabase(":memory:"));
    const trusted = Array.from({ length: 44 }, (_, index) =>
      makeListing({
        key: `panzhi:trusted-${index}`,
        sourceListingId: `trusted-${index}`,
        url: `https://example.test/trusted/${index}`
      })
    );
    repository.replaceSourceSnapshot(
      "panzhi",
      trusted,
      "success",
      new Date("2026-07-29T09:00:00.000Z"),
      { pagesScanned: 5, stopReason: "end_of_pages" }
    );
    const adapter = freshSourceAdapter("panzhi", 1);
    const coordinator = new CollectionCoordinator({
      adapters: [adapter],
      fetcher: new RoutingFetcher((request) =>
        ok(request.url, "fixture")
      ),
      repository,
      now: () => new Date("2026-07-29T10:00:00.000Z")
    });
    const runId = repository.startScan(
      new Date("2026-07-29T10:00:00.000Z")
    );

    await expect(coordinator.refreshAll(runId)).resolves.toBe("partial");
    expect(sourceStatus(repository)).toMatchObject({
      state: "partial",
      itemCount: 44,
      anomaly: { state: "suspect", observedItemCount: 1 }
    });
  });
});
