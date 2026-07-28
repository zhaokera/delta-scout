import { load } from "cheerio";
import { toEvidenceRecords } from "../../../domain/evidence.js";
import type {
  DetailParseResult,
  ListingSummary,
  SourceAdapter
} from "../types.js";
import {
  absoluteUrl,
  compactText,
  findVisibleCatalogLink,
  isBlockedHtml,
  isVisibleLink,
  parseChineseAmount,
  parsePrice
} from "./shared.js";

const BASE_URL = "https://www.pzds.com/";

function extractEvidence(html: string): ReturnType<typeof toEvidenceRecords> {
  const $ = load(html);
  $("script, style, noscript").remove();
  const records: string[] = [];

  $(".description p, .description li").each((_, node) => {
    const text = compactText($(node).text());
    if (text) records.push(text);
  });

  if (records.length === 0) {
    const body = $("body").text();
    for (const line of body.split(/\n+/)) {
      const text = compactText(line);
      if (
        text &&
        (/^【[^】]+】/.test(text) ||
          /M7.*棱镜|二次实名|人脸包赔|无封号/.test(text))
      ) {
        records.push(text);
      }
    }
  }

  const fullBody = $("body").text();
  if (fullBody.includes("QQ")) records.push("QQ");
  if (fullBody.includes("不可二次实名")) {
    records.push("不可二次实名");
  } else if (fullBody.includes("可二次实名")) {
    records.push("可二次实名");
  }
  if (fullBody.includes("不支持人脸包赔")) {
    records.push("不支持人脸包赔");
  } else if (fullBody.includes("支持人脸包赔")) {
    records.push("支持人脸包赔");
  }
  if (fullBody.includes("无封号")) records.push("无封号");

  return toEvidenceRecords([...new Set(records)]);
}

function parseDetail(
  html: string,
  _summary: ListingSummary
): DetailParseResult {
  if (isBlockedHtml(html)) {
    return { kind: "blocked", reason: "captcha_required" };
  }
  const $ = load(html);
  $("script, style, noscript").remove();
  const body = compactText($("body").text());
  const evidence = extractEvidence(html);
  if (evidence.length === 0) {
    return { kind: "blocked", reason: "structure_changed" };
  }

  const totalAssetsRaw = parseChineseAmount(body, "总资产");
  const totalAssetsM =
    totalAssetsRaw === null ? null : totalAssetsRaw / 1_000_000;

  const loginPlatform = /三角洲行动[-—\s]*QQ|(?:^|\s)QQ(?:\s|$)/i.test(body)
    ? "qq"
    : /微信/.test(body)
      ? "wechat"
      : "unknown";
  const service =
    /三角洲行动[-—\s]*QQ(?:官服)?|QQ官服/.test(body)
      ? "official"
      : /渠道服|非官服/.test(body)
        ? "non_official"
        : "unknown";

  const cannotSecond = /不可二次实名/.test(body);
  const canSecond = !cannotSecond && /可二次实名/.test(body);
  const secondRealNameAvailable = cannotSecond
    ? false
    : canSecond
      ? true
      : null;
  const realNameStatus = cannotSecond
    ? "already_second"
    : canSecond
      ? "second_available"
      : /原实名/.test(body)
        ? "original"
        : "unknown";

  const noCoverage = /不支持人脸包赔|无包赔/.test(body);
  const hasCoverage = !noCoverage && /支持人脸包赔|人脸包赔/.test(body);

  return {
    kind: "ok",
    detail: {
      evidence,
      loginPlatform,
      service,
      totalAssetsM,
      hafCoins: parseChineseAmount(body, "哈夫币"),
      realNameStatus,
      secondRealNameAvailable,
      recoveryCoverage: noCoverage ? false : hasCoverage ? true : null,
      verificationAt: null,
      banNotes: /有封号|封禁记录/.test(body) ? ["页面提示存在封号记录"] : []
    }
  };
}

export const panzhiAdapter: SourceAdapter = {
  source: "panzhi",
  entryUrl: BASE_URL,

  discoverCatalog(html, query) {
    if (isBlockedHtml(html)) {
      return { kind: "blocked", reason: "captcha_required" };
    }
    const url = findVisibleCatalogLink(html, BASE_URL, query);
    return url
      ? { kind: "ok", request: { url } }
      : { kind: "blocked", reason: "catalog_not_found" };
  },

  parseList(html) {
    if (isBlockedHtml(html)) {
      return { kind: "blocked", reason: "captcha_required" };
    }
    const $ = load(html);
    const items: ListingSummary[] = [];
    const goodsLinks = $("a[href*='/goodsDetails/']");
    goodsLinks.each((_, node) => {
      const link = $(node);
      if (!isVisibleLink(link)) return;
      const href = link.attr("href");
      if (!href) return;
      const match = href.match(/\/goodsDetails\/([^/?#]+)\//);
      const rawText = compactText(link.text());
      if (!rawText) return;
      items.push({
        source: "panzhi",
        sourceListingId: match?.[1] ?? null,
        url: absoluteUrl(BASE_URL, href),
        title: compactText(link.find("p").first().text()) || rawText,
        rawText,
        priceCny: parsePrice(rawText)
      });
    });
    if (
      items.length > 0 ||
      ($(".goods-list-with-game").length > 0 && goodsLinks.length === 0)
    ) {
      return { kind: "ok", items };
    }
    return { kind: "blocked", reason: "structure_changed" };
  },

  nextPage(html, currentRequest) {
    const $ = load(html);
    if (
      $(".goods-list-with-game").length > 0 &&
      $("a[href*='/goodsDetails/']").length === 0
    ) {
      return null;
    }

    let currentUrl: URL;
    try {
      currentUrl = new URL(currentRequest.url);
    } catch {
      return null;
    }
    if (
      currentUrl.origin !== "https://www.pzds.com" ||
      currentUrl.pathname !== "/goodsList/391/6"
    ) {
      return null;
    }

    const pageValues = currentUrl.searchParams.getAll("page");
    if (pageValues.length > 1) return null;
    const pageText = pageValues[0] ?? "1";
    if (!/^[1-9]\d*$/.test(pageText)) return null;
    const page = Number(pageText);
    if (!Number.isSafeInteger(page) || page === Number.MAX_SAFE_INTEGER) {
      return null;
    }

    currentUrl.searchParams.set("page", String(page + 1));
    return { url: currentUrl.toString() };
  },

  detailRequest(summary) {
    return { url: summary.url };
  },

  parseDetail
};
