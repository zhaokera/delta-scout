// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDatabase } from "../../src/server/db.js";
import { CollectionCoordinator } from "../../src/server/collector/coordinator.js";
import type {
  FetchResult,
  ListingSummary,
  PageFetcher,
  SourceAdapter
} from "../../src/server/collector/types.js";
import { ListingRepository } from "../../src/server/repository.js";
import { makeListing } from "../domain/listingFactory.js";

class MapFetcher implements PageFetcher {
  readonly calls: string[] = [];

  constructor(private readonly responses: Map<string, FetchResult>) {}

  async fetchPage(url: string): Promise<FetchResult> {
    this.calls.push(url);
    return (
      this.responses.get(url) ?? {
        kind: "failed",
        url,
        error: "missing_fixture"
      }
    );
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

function fakeAdapter(
  overrides: Partial<SourceAdapter> = {}
): SourceAdapter {
  return {
    source: "panzhi",
    entryUrl: "https://source.test/",
    discoverCatalog: () => ({
      kind: "ok",
      url: "https://source.test/list/1"
    }),
    parseList: () => ({ kind: "ok", items: [summary()] }),
    nextPage: () => null,
    detailUrl: (item) => item.url,
    parseDetail: () => ({
      kind: "ok",
      detail: {
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
      }
    }),
    ...overrides
  };
}

describe("CollectionCoordinator", () => {
  it("discovers, follows visible pagination, merges detail, and stores results", async () => {
    const repository = new ListingRepository(createDatabase(":memory:"));
    const adapter = fakeAdapter({
      parseList: (html) => ({
        kind: "ok",
        items: [summary(html === "page-one" ? 1 : 2)]
      }),
      nextPage: (html) =>
        html === "page-one" ? "https://source.test/list/2" : null
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
      nextPage: () => "https://source.test/list/2",
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
