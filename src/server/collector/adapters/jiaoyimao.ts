import { load } from "cheerio";
import { parseJiaoyimaoVisibleDetail } from "../../browserRefresh/visibleDetail.js";
import type {
  DetailParseResult,
  ListParseResult,
  ListingSummary,
  SourceAdapter,
  SourceRequest
} from "../types.js";
import {
  APPROVED_JIAOYIMAO_MTOP_ENDPOINT,
  APPROVED_JIAOYIMAO_REFERER,
  isApprovedJiaoyimaoMtopRequest
} from "../mtop.js";
import {
  absoluteUrl,
  compactText,
  isBlockedHtml,
  isVisibleLink
} from "./shared.js";

const BASE_URL = "https://www.jiaoyimao.com/";
const BROAD_CATALOG_URL = APPROVED_JIAOYIMAO_REFERER;
const BROAD_SEARCH_CONDITION = {
  attr_7393855783477590029: {
    selectType: 2,
    multiSearchCondition: true,
    conditionList: [],
    childCondition: {
      mp_7393855783922186253: {
        "极品|S": ["M7战斗步枪-棱镜攻势S2"],
        "极品|A": ["M7战斗步枪-棱镜攻势S2"],
        "极品|B": ["M7战斗步枪-棱镜攻势S2"],
        "极品|C": ["M7战斗步枪-棱镜攻势S2"]
      }
    },
    statConditionList: [],
    conditionType: 3
  }
};
const GAME_CONDITION = {
  gameId: 2_007_840,
  platformId: 2,
  clientId: 110
};

function normalizedM7Evidence(text: string): string | null {
  const match = text.match(
    /M7\s*[-·：:]?\s*极品(?:\||\s)*([SABC])/i
  );
  return match ? `M7棱镜攻势(极品${match[1].toUpperCase()})` : null;
}

function parseNumber(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value.replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

type MtopEnvelope =
  | { kind: "not_json" }
  | { kind: "invalid" }
  | {
      kind: "ok";
      hasNextPage: boolean;
      deliverComps: unknown[];
    };

function parseMtopEnvelope(content: string): MtopEnvelope {
  let root: unknown;
  try {
    root = JSON.parse(content);
  } catch {
    return { kind: "not_json" };
  }
  if (
    !isRecord(root) ||
    !Array.isArray(root.ret) ||
    !root.ret.every((value) => typeof value === "string") ||
    !root.ret.includes("SUCCESS::调用成功") ||
    !isRecord(root.data) ||
    !isRecord(root.data.result) ||
    !Array.isArray(root.data.result.deliverComps)
  ) {
    return { kind: "invalid" };
  }
  const hasNextPage = root.data.result.hasNextPage;
  if (
    typeof hasNextPage !== "boolean" &&
    hasNextPage !== "true" &&
    hasNextPage !== "false"
  ) {
    return { kind: "invalid" };
  }
  return {
    kind: "ok",
    hasNextPage:
      typeof hasNextPage === "boolean"
        ? hasNextPage
        : hasNextPage === "true",
    deliverComps: root.data.result.deliverComps
  };
}

function parseMtopPrice(value: unknown): number | null {
  if (
    typeof value !== "number" &&
    (typeof value !== "string" || value.trim().length === 0)
  ) {
    return null;
  }
  const price = Number(value);
  return Number.isFinite(price) && price >= 0 ? price : null;
}

function parseMtopDetailUrl(
  value: unknown,
  goodsId: string
): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.origin === "https://www.jiaoyimao.com" &&
      url.pathname === `/jg2007840/${goodsId}.html`
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? compactText(value)
    : null;
}

function mtopComponentText(data: Record<string, unknown>): string[] {
  const sellPoints = Array.isArray(data.sellPoints)
    ? data.sellPoints.flatMap((point) =>
        isRecord(point) && stringField(point.desc)
          ? [stringField(point.desc)!]
          : []
      )
    : [];
  const tags = isRecord(data.tagMap)
    ? Object.values(data.tagMap).flatMap((group) =>
        Array.isArray(group)
          ? group.flatMap((tag) =>
              isRecord(tag) && stringField(tag.tagName)
                ? [stringField(tag.tagName)!]
                : []
            )
          : []
      )
    : [];
  return [
    stringField(data.title),
    stringField(data.publishName),
    stringField(data.serverName),
    ...sellPoints,
    ...tags
  ].filter((value): value is string => value !== null);
}

function parseMtopComponent(component: unknown): ListingSummary | null {
  if (
    !isRecord(component) ||
    component.type !== "8" ||
    component.subType !== "10" ||
    !isRecord(component.data)
  ) {
    return null;
  }
  const data = component.data;
  const goodsId =
    typeof data.goodsId === "string" && /^\d+$/.test(data.goodsId)
      ? data.goodsId
      : null;
  if (!goodsId) return null;
  const title = stringField(data.title);
  const priceCny = parseMtopPrice(data.price);
  const url = parseMtopDetailUrl(data.detailUrlSeo, goodsId);
  if (!title || priceCny === null || !url) return null;
  return {
    source: "jiaoyimao",
    sourceListingId: goodsId,
    url,
    title,
    rawText: [...new Set(mtopComponentText(data))].join("\n"),
    priceCny,
    detailFetchHint: "m7_prism_query"
  };
}

function parseSsrList(html: string): ListParseResult {
  const $ = load(html);
  const items: ListingSummary[] = [];
  $(".pcGoodsListItem[data-goodsid][data-price][href]").each(
    (_, node) => {
      const card = $(node);
      if (!isVisibleLink(card)) return;
      const href = card.attr("href");
      const sourceListingId = card.attr("data-goodsid");
      if (!href || !sourceListingId) return;
      const visibleText = compactText(card.text());
      if (!visibleText) return;
      const m7Evidence = normalizedM7Evidence(visibleText);
      const title =
        compactText(
          card.find("[data-goods-name]").first().attr("data-goods-name") ??
            ""
        ) || visibleText;
      items.push({
        source: "jiaoyimao",
        sourceListingId,
        url: absoluteUrl(BASE_URL, href),
        title,
        rawText: m7Evidence
          ? `${visibleText}\n${m7Evidence}`
          : visibleText,
        priceCny: parseNumber(card.attr("data-price"))
      });
    }
  );
  return items.length > 0
    ? { kind: "ok", items }
    : { kind: "blocked", reason: "structure_changed" };
}

function makeMtopListRequest(page: number): SourceRequest {
  return {
    url: APPROVED_JIAOYIMAO_MTOP_ENDPOINT,
    options: {
      method: "POST",
      accept: "application/json",
      contentType: "application/x-www-form-urlencoded",
      origin: "https://www.jiaoyimao.com",
      referer: BROAD_CATALOG_URL,
      body: JSON.stringify({
        searchCondition: JSON.stringify(BROAD_SEARCH_CONDITION),
        relateId: "10101",
        pageSize: 16,
        modelType: "h5",
        queryType: 1,
        goodsScene: "goods_search_new",
        gameCondition: JSON.stringify(GAME_CONDITION),
        categoryId: 8_845_004,
        parentId: 8_845_003,
        class:
          "com.jym.delivery.hsf.dto.unifiedgoodslist.GoodsListQueryParams",
        page: String(page)
      }),
      anonymousMtop: {
        api: "mtop.com.jym.layout.pc.goodslist.getunifiedgoodslist",
        version: "1.0",
        appKey: "12574478"
      }
    }
  };
}

function extractDetail(
  html: string,
  _summary: ListingSummary
): DetailParseResult {
  if (isBlockedHtml(html)) {
    return { kind: "blocked", reason: "captcha_required" };
  }

  const $ = load(html);
  const head = compactText($(".item-head-info-card").first().text());
  const report = compactText($(".cmp-elevator-container").first().text());
  const safety = compactText($(".safe-report-container").first().text());
  const description = compactText(
    $(
      "#cmp-elevator-content-商品描述, " +
        "[id*='商品描述'], .goods-description, .item-description"
    ).first().text()
  );

  return parseJiaoyimaoVisibleDetail(
    { head, report, safety, description },
    _summary
  );
}

export const jiaoyimaoAdapter: SourceAdapter = {
  source: "jiaoyimao",
  entryUrl: BROAD_CATALOG_URL,
  strictPaginationProgress: true,

  discoverCatalog(html, _query) {
    if (isBlockedHtml(html)) {
      return { kind: "blocked", reason: "captcha_required" };
    }
    const $ = load(html);
    const verifiedCard = $(
      ".pcGoodsListItem[data-goodsid][data-price][href]"
    ).first();
    return verifiedCard.length > 0 && isVisibleLink(verifiedCard)
      ? { kind: "ok", request: { url: BROAD_CATALOG_URL } }
      : { kind: "blocked", reason: "unverified_structure" };
  },

  parseList(content) {
    const envelope = parseMtopEnvelope(content);
    if (envelope.kind === "invalid") {
      return { kind: "blocked", reason: "structure_changed" };
    }
    if (envelope.kind === "ok") {
      return {
        kind: "ok",
        items: envelope.deliverComps.flatMap((component) => {
          const item = parseMtopComponent(component);
          return item ? [item] : [];
        })
      };
    }
    if (isBlockedHtml(content)) {
      return { kind: "blocked", reason: "captcha_required" };
    }
    return parseSsrList(content);
  },

  nextPage(content, currentRequest) {
    const envelope = parseMtopEnvelope(content);
    if (envelope.kind === "ok") {
      if (
        !envelope.hasNextPage ||
        !isApprovedJiaoyimaoMtopRequest(currentRequest)
      ) {
        return null;
      }
      const body = JSON.parse(
        currentRequest.options?.body ?? ""
      ) as { page?: unknown };
      const currentPage = Number(body.page);
      return Number.isSafeInteger(currentPage) && currentPage >= 2
        ? makeMtopListRequest(currentPage + 1)
        : null;
    }
    if (
      envelope.kind === "invalid" ||
      currentRequest.url !== BROAD_CATALOG_URL ||
      currentRequest.options !== undefined
    ) {
      return null;
    }
    return parseSsrList(content).kind === "ok"
      ? makeMtopListRequest(2)
      : null;
  },

  detailRequest(summary) {
    return { url: summary.url };
  },

  parseDetail: extractDetail
};
