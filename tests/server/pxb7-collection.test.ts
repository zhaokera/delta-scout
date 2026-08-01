// @vitest-environment node
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CollectionCoordinator } from "../../src/server/collector/coordinator.js";
import { pxb7Adapter } from "../../src/server/collector/adapters/pxb7.js";
import type {
  FetchResult,
  PageFetcher,
  SourceRequest
} from "../../src/server/collector/types.js";
import { createDatabase } from "../../src/server/db.js";
import { ListingRepository } from "../../src/server/repository.js";

async function fixture(name: string): Promise<string> {
  return readFile(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
}

class PxbFixtureFetcher implements PageFetcher {
  readonly requests: SourceRequest[] = [];
  readonly detailRequests: SourceRequest[] = [];

  constructor(
    private readonly home: string,
    private readonly pages: Map<number, string>
  ) {}

  async fetchPage(request: SourceRequest): Promise<FetchResult> {
    this.requests.push(request);
    if (request.url === pxb7Adapter.entryUrl) {
      return {
        kind: "ok",
        url: request.url,
        status: 200,
        html: this.home
      };
    }
    if (
      request.url ===
      "https://api-pc.pxb7.com/api/search/product/v2/selectSearchPageList"
    ) {
      const pageIndex = Number(
        JSON.parse(request.options?.body ?? "{}").pageIndex
      );
      const html = this.pages.get(pageIndex);
      return html
        ? { kind: "ok", url: request.url, status: 200, html }
        : { kind: "failed", url: request.url, error: "missing_fixture" };
    }
    this.detailRequests.push(request);
    return {
      kind: "failed",
      url: request.url,
      error: "unexpected_detail_request"
    };
  }
}

describe("PXB7 broad account collection", () => {
  it("pages one broad query and scores every account under the hard conditions", async () => {
    const fetcher = new PxbFixtureFetcher(
      await fixture("pxb7-home.html"),
      new Map([
        [1, await fixture("pxb7-list-page-1.json")],
        [2, await fixture("pxb7-list-page-2.json")],
        [3, await fixture("pxb7-list-page-3.json")]
      ])
    );
    const repository = new ListingRepository(createDatabase(":memory:"));
    const coordinator = new CollectionCoordinator({
      adapters: [pxb7Adapter],
      fetcher,
      repository,
      now: () => new Date("2026-07-28T10:00:00.000Z")
    });

    await coordinator.refreshAll();

    const listings = repository.getListings();
    const eligible = repository.getListings("eligible");
    const listRequests = fetcher.requests.filter(
      ({ url }) => url.includes("selectSearchPageList")
    );
    expect(listRequests).toHaveLength(3);
    expect(
      listRequests.map(({ options }) => {
        const body = JSON.parse(options?.body ?? "{}");
        return [body.query, body.pageIndex];
      })
    ).toEqual([1, 2, 3].map((pageIndex) => [
      "三角洲行动",
      pageIndex
    ]));
    expect(listings).toHaveLength(48);
    expect(new Set(listings.map(({ key }) => key))).toHaveLength(48);
    expect(eligible).toHaveLength(36);
    expect(
      eligible.every(
        (listing) =>
          listing.source === "pxb7" &&
          listing.loginPlatform === "qq" &&
          listing.service === "official" &&
          listing.priceCny !== null &&
          listing.priceCny <= 6_000 &&
          listing.url ===
            `https://www.pxb7.com/product/${listing.sourceListingId}/1`
      )
    ).toBe(true);
    expect(eligible[0]).toMatchObject({
      m7PrismQuality: "A",
      redSkins: ["威龙"],
      julangStatus: "owned",
      julangQuality: "极品",
      totalAssetsM: 268,
      hafCoins: 28_880_000,
      secondRealNameAvailable: true
    });
    expect(fetcher.detailRequests).toHaveLength(0);
    expect(JSON.stringify(listings)).not.toContain("fixture-page-");
    expect(
      repository
        .getSourceStatuses()
        .find(({ source }) => source === "pxb7")
    ).toMatchObject({
      source: "pxb7",
      state: "success",
      itemCount: 48
    });
  });
});
