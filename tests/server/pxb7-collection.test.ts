// @vitest-environment node
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CollectionCoordinator } from "../../src/server/collector/coordinator.js";
import {
  PXB_REQUIRED_ACCOUNT_FILTERS,
  PXB_REQUIRED_OPERATOR_SKIN_FILTER,
  pxb7Adapter
} from "../../src/server/collector/adapters/pxb7.js";
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

describe("PXB native hard filters", () => {
  it("uses the declared account and secondary real-name hard filters", () => {
    expect(PXB_REQUIRED_ACCOUNT_FILTERS).toEqual([
      expect.objectContaining({ attrId: "103711" }),
      expect.objectContaining({
        attrId: "103713",
        attrValList: ["103718"]
      })
    ]);
  });
});

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

describe("PXB7 native price-filtered account collection", () => {
  it("pages the native 1900-4000 query and locally rejects fixture outliers", async () => {
    const nativeFilteredPages = await Promise.all(
      [1, 2, 3].map(async (pageIndex) => {
        const response = JSON.parse(
          await fixture(`pxb7-list-page-${pageIndex}.json`)
        ) as {
          data: {
            list: Array<{ showTitle: string }>;
            properties: { pageToken?: string };
          };
        };
        for (const product of response.data.list) {
          product.showTitle +=
            "\n【干员皮肤】骇爪-维什戴尔，露娜-黑天际线";
        }
        if (pageIndex === 2) {
          response.data.properties.pageToken = "fixture-page-2";
        }
        return JSON.stringify(response);
      })
    );
    const fetcher = new PxbFixtureFetcher(
      await fixture("pxb7-home.html"),
      new Map([
        [1, nativeFilteredPages[0]],
        [2, nativeFilteredPages[1]],
        [3, nativeFilteredPages[2]]
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
        return [
          body.query,
          body.pageIndex,
          body.filterDTOList,
          body.combineFilterList
        ];
      })
    ).toEqual([1, 2, 3].map((pageIndex) => [
      "三角洲行动",
      pageIndex,
      [
        ...PXB_REQUIRED_ACCOUNT_FILTERS,
        { attrId: "price", attrType: 3, attrValList: [1900, 4000] },
        PXB_REQUIRED_OPERATOR_SKIN_FILTER
      ],
      []
    ]));
    expect(listings).toHaveLength(48);
    expect(new Set(listings.map(({ key }) => key))).toHaveLength(48);
    expect(eligible).toHaveLength(9);
    expect(
      listings.some(
        ({ priceCny }) =>
          priceCny !== null &&
          (priceCny < 1_900 || priceCny > 4_000)
      )
    ).toBe(true);
    expect(
      listings
        .filter(
          ({ priceCny }) =>
            priceCny !== null &&
            (priceCny < 1_900 || priceCny > 4_000)
        )
        .every(({ eligibility }) => eligibility === "rejected")
    ).toBe(true);
    expect(
      eligible.every(
        (listing) =>
          listing.source === "pxb7" &&
          listing.loginPlatform === "qq" &&
          listing.service === "official" &&
          listing.requiredRedSkinStatus === "complete" &&
          listing.secondRealNameAvailable === true &&
          listing.priceCny !== null &&
          listing.priceCny >= 1_900 &&
          listing.priceCny <= 4_000 &&
          listing.url ===
            `https://www.pxb7.com/product/${listing.sourceListingId}/1`
      )
    ).toBe(true);
    expect(eligible[0]).toMatchObject({
      m7PrismQuality: "S",
      redSkins: ["露娜", "骇爪"],
      julangStatus: "owned",
      julangQuality: "优品",
      totalAssetsM: 190,
      hafCoins: 18_000_000,
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
