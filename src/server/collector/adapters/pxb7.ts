import { load } from "cheerio";
import { z } from "zod";
import { toEvidenceRecords } from "../../../domain/evidence.js";
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
const SINGLE_SELECT_SEARCH_QUERIES = [
  "M7战斗步枪-棱镜攻势S2 极品 S",
  "M7战斗步枪-棱镜攻势S2 极品 A",
  "M7战斗步枪-棱镜攻势S2 极品 B",
  "M7战斗步枪-棱镜攻势S2 极品 C",
  "M7战斗步枪-棱镜攻势S2 优品 S"
] as const;

const ProductSchema = z
  .object({
    productId: z.string().regex(/^\d+$/),
    bizProd: z.union([z.literal("1"), z.literal(1)]),
    gameId: z.literal("10371"),
    gameName: z.literal("三角洲行动"),
    price: z.number().finite().nonnegative(),
    showTitle: z.string().min(1),
    attrNameList: z.array(z.string()).optional(),
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
  query: z.enum(SINGLE_SELECT_SEARCH_QUERIES),
  gameId: z.literal("10371"),
  pageIndex: z.number().int().positive(),
  pageSize: z.literal(16),
  bizProd: z.literal(1),
  type: z.literal("4"),
  posType: z.literal(1),
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
  searchIndex: number,
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
        query: SINGLE_SELECT_SEARCH_QUERIES[searchIndex],
        gameId: "10371",
        pageIndex,
        pageSize: 16,
        bizProd: 1,
        type: "4",
        posType: 1,
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
    return { kind: "ok", request: makeListRequest(0, 1) };
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

    const pageToken = response.data.properties.pageToken?.trim();
    const searchIndex = SINGLE_SELECT_SEARCH_QUERIES.indexOf(
      currentBody.query
    );
    if (pageToken && pageToken !== currentBody.pageToken) {
      return makeListRequest(
        searchIndex,
        currentBody.pageIndex + 1,
        pageToken
      );
    }
    const nextSearchIndex = searchIndex + 1;
    return nextSearchIndex < SINGLE_SELECT_SEARCH_QUERIES.length
      ? makeListRequest(nextSearchIndex, 1)
      : null;
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
