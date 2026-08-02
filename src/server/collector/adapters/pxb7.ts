import { load } from "cheerio";
import { z } from "zod";
import { toEvidenceRecords } from "../../../domain/evidence.js";
import {
  CANDIDATE_PRICE_MAX_CNY,
  CANDIDATE_PRICE_MIN_CNY
} from "../../../domain/priceRange.js";
import type {
  ListingDetail,
  SourceAdapter,
  SourceRequest
} from "../types.js";
import {
  compactText,
  isBlockedHtml,
  isVisibleLink,
  parseChineseAmount
} from "./shared.js";

const BASE_URL = "https://www.pxb7.com/";
const LIST_API_URL =
  "https://api-pc.pxb7.com/api/search/product/v2/selectSearchPageList";
const BROAD_SEARCH_QUERY = "三角洲行动" as const;

// Keep only the public "账号" category filter here. Secondary real-name status
// is a scored safety signal, not one of the cross-platform hard requirements.
// Applying PXB's "可二次实名" filter at collection time would silently give
// this source a narrower (and safer) population than Jiaoyimao and Panzhi.
export const PXB_REQUIRED_ACCOUNT_FILTERS = [
  {
    attrId: "103711",
    attrType: 1,
    attrValList: ["103711"],
    optionType: 1
  }
] as const;

// PXB's public product metadata identifies both required operator skins under
// the same "干员皮肤" attribute. The public frontend encodes “全部满足” as
// filterType=1/isAll=true, so these two item IDs have AND semantics.
export const PXB_REQUIRED_OPERATOR_SKIN_FILTER = {
  attrId: "1037114",
  attrType: 1,
  filterType: 1,
  attrValList: ["174203185348623", "161525538259004"],
  categoryId: "103714",
  isAll: true
} as const;

const ProductSchema = z
  .object({
    productId: z.string().regex(/^\d+$/),
    bizProd: z.union([z.literal("1"), z.literal(1)]),
    gameId: z.literal("10371"),
    gameName: z.literal("三角洲行动"),
    price: z.number().finite().nonnegative(),
    showTitle: z.string().min(1),
    attrNameList: z.array(z.string()).optional(),
    important: z.array(z.string()).optional(),
    importantHighlights: z.array(z.string()).optional(),
    productUniqueNo: z.string().min(1),
    guarantee: z.number().finite()
  })
  .passthrough();

const SearchResponseSchema = z
  .object({
    success: z.literal(true),
    data: z
      .object({
        list: z.array(ProductSchema),
        properties: z
          .object({
            pageToken: z.string().optional()
          })
          .passthrough()
      })
      .passthrough()
  })
  .passthrough();

const SearchBodySchema = z.object({
  query: z.literal(BROAD_SEARCH_QUERY),
  gameId: z.literal("10371"),
  pageIndex: z.number().int().positive(),
  pageSize: z.literal(16),
  bizProd: z.literal(1),
  type: z.literal("4"),
  posType: z.literal(1),
  filterDTOList: z.tuple([
    z.strictObject({
      attrId: z.literal(PXB_REQUIRED_ACCOUNT_FILTERS[0].attrId),
      attrType: z.literal(PXB_REQUIRED_ACCOUNT_FILTERS[0].attrType),
      attrValList: z.tuple([
        z.literal(PXB_REQUIRED_ACCOUNT_FILTERS[0].attrValList[0])
      ]),
      optionType: z.literal(PXB_REQUIRED_ACCOUNT_FILTERS[0].optionType)
    }),
    z.strictObject({
      attrId: z.literal("price"),
      attrType: z.literal(3),
      attrValList: z.tuple([
        z.literal(CANDIDATE_PRICE_MIN_CNY),
        z.literal(CANDIDATE_PRICE_MAX_CNY)
      ])
    }),
    z.strictObject({
      attrId: z.literal(PXB_REQUIRED_OPERATOR_SKIN_FILTER.attrId),
      attrType: z.literal(PXB_REQUIRED_OPERATOR_SKIN_FILTER.attrType),
      filterType: z.literal(
        PXB_REQUIRED_OPERATOR_SKIN_FILTER.filterType
      ),
      attrValList: z.tuple([
        z.literal(PXB_REQUIRED_OPERATOR_SKIN_FILTER.attrValList[0]),
        z.literal(PXB_REQUIRED_OPERATOR_SKIN_FILTER.attrValList[1])
      ]),
      categoryId: z.literal(
        PXB_REQUIRED_OPERATOR_SKIN_FILTER.categoryId
      ),
      isAll: z.literal(PXB_REQUIRED_OPERATOR_SKIN_FILTER.isAll)
    })
  ]),
  combineFilterList: z.tuple([]),
  pageToken: z.string().min(1).optional()
});

type SearchResponse = z.infer<typeof SearchResponseSchema>;
type Product = z.infer<typeof ProductSchema>;

function parseSearchResponse(content: string): SearchResponse | null {
  try {
    return SearchResponseSchema.parse(JSON.parse(content));
  } catch {
    return null;
  }
}

function makeListRequest(
  pageIndex: number,
  pageToken?: string
): SourceRequest {
  return {
    url: LIST_API_URL,
    options: {
      method: "POST",
      accept: "application/json, text/plain, */*",
      contentType: "application/json",
      origin: BASE_URL.slice(0, -1),
      referer: BASE_URL,
      body: JSON.stringify({
        query: BROAD_SEARCH_QUERY,
        gameId: "10371",
        pageIndex,
        pageSize: 16,
        bizProd: 1,
        type: "4",
        posType: 1,
        filterDTOList: [
          ...PXB_REQUIRED_ACCOUNT_FILTERS.map((filter) => ({
            ...filter,
            attrValList: [...filter.attrValList]
          })),
          {
            attrId: "price",
            attrType: 3,
            attrValList: [
              CANDIDATE_PRICE_MIN_CNY,
              CANDIDATE_PRICE_MAX_CNY
            ]
          },
          {
            ...PXB_REQUIRED_OPERATOR_SKIN_FILTER,
            attrValList: [
              ...PXB_REQUIRED_OPERATOR_SKIN_FILTER.attrValList
            ]
          }
        ],
        combineFilterList: [],
        ...(pageToken ? { pageToken } : {})
      })
    }
  };
}

function splitShowTitle(showTitle: string): ReturnType<typeof toEvidenceRecords> {
  const records: string[] = [];
  const normalized = showTitle.replace(/\r\n?/g, "\n");

  for (const line of normalized.split(/\n+/)) {
    let cursor = 0;
    let label = "";
    for (const match of line.matchAll(/【[^】]+】/g)) {
      const text = line.slice(cursor, match.index).trim();
      if (text) records.push(`${label}${text}`);
      label = match[0];
      cursor = (match.index ?? 0) + match[0].length;
    }
    const tail = line.slice(cursor).trim();
    if (tail) records.push(`${label}${tail}`);
  }

  return toEvidenceRecords(records);
}

function parseLogin(text: string): Pick<
  ListingDetail,
  "loginPlatform" | "service"
> {
  const hasQq = /QQ登录/i.test(text);
  const hasWechat = /微信登录/.test(text);
  if (hasQq === hasWechat) {
    return { loginPlatform: "unknown", service: "unknown" };
  }
  return hasQq
    ? { loginPlatform: "qq", service: "official" }
    : { loginPlatform: "wechat", service: "unknown" };
}

function embeddedDetail(product: Product): ListingDetail {
  const titleEvidence = splitShowTitle(product.showTitle);
  const evidence = toEvidenceRecords([
    ...new Set([
      ...(product.attrNameList ?? []),
      ...(product.important ?? []),
      ...(product.importantHighlights ?? []),
      ...titleEvidence.map(({ text }) => text)
    ])
  ]);
  const text = evidence.map((record) => record.text).join("\n");
  const totalAssets = parseChineseAmount(text, "总资产");
  const cannotSecond = /不可二次实名/.test(text);
  const canSecond = !cannotSecond && /可二次实名/.test(text);
  const noCoverage = /不支持.{0,8}包赔|无包赔/.test(text);
  const hasCoverage =
    !noCoverage && /支持.{0,8}包赔|人脸包赔|找回包赔/.test(text);

  return {
    evidence,
    ...parseLogin(text),
    totalAssetsM:
      totalAssets === null ? null : totalAssets / 1_000_000,
    hafCoins: parseChineseAmount(text, "哈夫币"),
    realNameStatus: cannotSecond
      ? "already_second"
      : canSecond
        ? "second_available"
        : "unknown",
    secondRealNameAvailable: cannotSecond
      ? false
      : canSecond
        ? true
        : null,
    recoveryCoverage: noCoverage ? false : hasCoverage ? true : null,
    verificationAt: null,
    banNotes: []
  };
}

export const pxb7Adapter: SourceAdapter = {
  source: "pxb7",
  entryUrl: BASE_URL,
  allowPagesWithoutNewItems: true,

  discoverCatalog(html, query) {
    if (isBlockedHtml(html)) {
      return { kind: "blocked", reason: "captcha_required" };
    }
    const $ = load(html);
    let foundCatalog = false;
    $("a[href]").each((_, node) => {
      if (foundCatalog) return;
      const link = $(node);
      const href = link.attr("href");
      if (!href || !isVisibleLink(link)) return;
      const candidate = new URL(href, BASE_URL);
      foundCatalog =
        candidate.origin === BASE_URL.slice(0, -1) &&
        candidate.pathname === "/buy/10371/1" &&
        compactText(link.text()).includes(query);
    });
    const officialNuxtShell =
      $("#__nuxt").length === 1 &&
      $("#teleports").length === 1 &&
      $('meta[name="keywords"]')
        .attr("content")
        ?.includes("螃蟹账号交易平台") === true &&
      $("script").toArray().some((node) => {
        const text = $(node).text();
        return (
          text.includes("window.__NUXT__") &&
          /baseUrl\s*:\s*["']https:\/\/api-pc\.pxb7\.com["']/.test(text)
        );
      }) &&
      $('script[type="module"][src]').toArray().some((node) => {
        const src = $(node).attr("src");
        if (!src) return false;
        try {
          const url = new URL(src);
          return (
            url.origin === "https://g.pxb7.com" &&
            url.port === "" &&
            /^\/pc\/version\/[^/]+\/entry\.[A-Za-z0-9_-]+\.js$/.test(
              url.pathname
            )
          );
        } catch {
          return false;
        }
      });
    if (!foundCatalog && !officialNuxtShell) {
      return { kind: "blocked", reason: "catalog_not_found" };
    }
    return { kind: "ok", request: makeListRequest(1) };
  },

  parseList(content) {
    if (isBlockedHtml(content)) {
      return { kind: "blocked", reason: "captcha_required" };
    }
    const response = parseSearchResponse(content);
    if (!response) {
      return { kind: "blocked", reason: "structure_changed" };
    }

    return {
      kind: "ok",
      items: response.data.list.map((product) => {
        const detail = embeddedDetail(product);
        return {
          source: "pxb7" as const,
          sourceListingId: product.productId,
          url: `${BASE_URL}product/${product.productId}/1`,
          title: product.productUniqueNo,
          rawText: detail.evidence.map(({ text }) => text).join("\n"),
          priceCny: product.price / 100,
          embeddedDetail: detail
        };
      })
    };
  },

  nextPage(content, currentRequest) {
    const response = parseSearchResponse(content);
    const body = currentRequest.options?.body;
    if (
      !response ||
      currentRequest.url !== LIST_API_URL ||
      currentRequest.options?.method !== "POST" ||
      !body
    ) {
      return null;
    }

    let currentBody: z.infer<typeof SearchBodySchema>;
    try {
      currentBody = SearchBodySchema.parse(JSON.parse(body));
    } catch {
      return null;
    }

    if (response.data.list.length === 0) return null;

    const pageToken = response.data.properties.pageToken?.trim();
    if (!pageToken) return null;

    // The live PXB endpoint can keep the same server-issued pageToken for
    // several pages while pageIndex advances. Treating an unchanged token as
    // the end would silently truncate the scan after page 2.
    return makeListRequest(currentBody.pageIndex + 1, pageToken);
  },

  detailRequest(summary) {
    return { url: summary.url };
  },

  parseDetail(_content, summary) {
    return summary.embeddedDetail
      ? { kind: "ok", detail: summary.embeddedDetail }
      : { kind: "blocked", reason: "unverified_structure" };
  }
};
