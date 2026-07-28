// @vitest-environment node
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { createDatabase } from "../../src/server/db.js";
import {
  jiaoyimaoAdapter
} from "../../src/server/collector/adapters/jiaoyimao.js";
import { CollectionCoordinator } from "../../src/server/collector/coordinator.js";
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
import { makeListing } from "../domain/listingFactory.js";

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

async function collectJiaoyimaoMtopItem(detailEvidence: string) {
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

describe("CollectionCoordinator", () => {
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

  it("keeps MTop premium detail evidence out of conflict", async () => {
    const { listing } = await collectJiaoyimaoMtopItem(
      "M7战斗步枪-棱镜攻势S2(优品B)"
    );

    expect(listing).toMatchObject({
      m7PrismStatus: "premium",
      m7PrismQuality: null
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
    const listRequest = { url: "https://source.test/list/1" };
    const adapter = fakeAdapter({
      parseList: () => ({
        kind: "ok",
        items: [
          {
            ...summary(),
            rawText: "QQ官服 普通账号"
          }
        ]
      }),
      nextPage: () => listRequest
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
    ).toMatchObject({ state: "success", itemCount: 1 });
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
      itemCount: 2
    });
  });

  it("isolates blocked sources and retains their previous snapshot", async () => {
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
      "success"
    );
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
    ).toMatchObject({ state: "blocked", error: "captcha_required" });
    expect(repository.getListings().some(({ source }) => source === "panzhi"))
      .toBe(true);
  });

  it("caps a source at 60 summaries and 20 details and marks it partial", async () => {
    const repository = new ListingRepository(createDatabase(":memory:"));
    const items = Array.from({ length: 61 }, (_, index) => summary(index + 1));
    const detailParser = vi.fn(fakeAdapter().parseDetail);
    const adapter = fakeAdapter({
      parseList: () => ({ kind: "ok", items }),
      nextPage: () => ({ url: "https://source.test/list/2" }),
      parseDetail: detailParser
    });
    const responses = new Map<string, FetchResult>([
      [adapter.entryUrl, ok(adapter.entryUrl, "home")],
      ["https://source.test/list/1", ok("https://source.test/list/1", "list")]
    ]);
    for (const item of items.slice(0, 20)) {
      responses.set(item.url, ok(item.url, "detail"));
    }

    await new CollectionCoordinator({
      adapters: [adapter],
      fetcher: new MapFetcher(responses),
      repository
    }).refreshAll();

    expect(detailParser).toHaveBeenCalledTimes(20);
    expect(repository.getListings()).toHaveLength(60);
    expect(repository.getListings("eligible")).toHaveLength(20);
    expect(
      repository
        .getSourceStatuses()
        .find(({ source }) => source === "panzhi")
    ).toMatchObject({ state: "partial", itemCount: 60 });
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
  });
});
