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
const CATALOG_PATH = "/goodsList/391/6";
const CATALOG_URL = new URL(CATALOG_PATH, BASE_URL).toString();

function parsePanzhiDetailLink(
  href: string
): { sourceListingId: string; url: string } | null {
  const absoluteAuthority = href
    .trim()
    .match(/^(?:https:)?\/\/([^/?#]+)/i)?.[1];
  if (absoluteAuthority?.includes(":")) return null;
  try {
    const url = new URL(href, BASE_URL);
    const match = url.pathname.match(
      /^\/goodsDetails\/([A-Za-z0-9_-]+)\/6$/
    );
    if (
      url.origin !== "https://www.pzds.com" ||
      url.username ||
      url.password ||
      url.hash ||
      !match
    ) {
      return null;
    }
    return {
      sourceListingId: match[1],
      url: absoluteUrl(BASE_URL, url.toString())
    };
  } catch {
    return null;
  }
}

function isPanzhiLoginWall($: ReturnType<typeof load>): boolean {
  const hasLoginAction = $("form[action]")
    .toArray()
    .some((node) =>
      /(?:^|\/)login(?:[/?#]|$)/i.test($(node).attr("action") ?? "")
    );
  const hasPasswordInput = $("input")
    .toArray()
    .some((node) => {
      const input = $(node);
      return (
        input.attr("type")?.toLowerCase() === "password" ||
        /password|passwd/i.test(input.attr("name") ?? "")
      );
    });
  const hasLoginText =
    /登录|登\s*录|sign\s*in|log\s*in/i.test(compactText($("body").text()));
  return hasLoginAction || (hasPasswordInput && hasLoginText);
}

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
        : loginPlatform === "qq"
          ? "official"
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
  // The current public list API requires a browser-generated signature and
  // presents an Aliyun WAF challenge to an unsigned public client. The SSR
  // route only contains an unfiltered first batch, so treating it as the
  // requested native filter would produce a false successful scan. Use the
  // separately validated browser-snapshot ingestion path instead.
  requiresBrowserSnapshot: true,
  allowPagesWithoutNewItems: true,

  discoverCatalog(html, query) {
    if (isBlockedHtml(html)) {
      return { kind: "blocked", reason: "captcha_required" };
    }
    const catalogUrl = findVisibleCatalogLink(html, BASE_URL, query);
    if (!catalogUrl) {
      return { kind: "blocked", reason: "catalog_not_found" };
    }
    let parsedCatalogUrl: URL;
    try {
      parsedCatalogUrl = new URL(catalogUrl);
    } catch {
      return { kind: "blocked", reason: "catalog_not_found" };
    }
    if (
      parsedCatalogUrl.origin !== "https://www.pzds.com" ||
      parsedCatalogUrl.username ||
      parsedCatalogUrl.password ||
      parsedCatalogUrl.port ||
      parsedCatalogUrl.pathname !== CATALOG_PATH
    ) {
      return { kind: "blocked", reason: "catalog_not_found" };
    }
    return { kind: "ok", request: { url: CATALOG_URL } };
  },

  parseList(html) {
    if (isBlockedHtml(html)) {
      return { kind: "blocked", reason: "captcha_required" };
    }
    const $ = load(html);
    if (isPanzhiLoginWall($)) {
      return { kind: "blocked", reason: "structure_changed" };
    }
    const items: ListingSummary[] = [];
    const goodsLinks = $("a[href*='/goodsDetails/']");
    goodsLinks.each((_, node) => {
      const link = $(node);
      if (!isVisibleLink(link)) return;
      const href = link.attr("href");
      if (!href) return;
      const detailLink = parsePanzhiDetailLink(href);
      if (!detailLink) return;
      const rawText = compactText(link.text());
      if (!rawText) return;
      items.push({
        source: "panzhi",
        sourceListingId: detailLink.sourceListingId,
        url: detailLink.url,
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

  nextPage(html, _currentRequest) {
    const $ = load(html);
    if (isBlockedHtml(html) || isPanzhiLoginWall($)) {
      return null;
    }
    if (
      $(".goods-list-with-game").length > 0 &&
      $("a[href*='/goodsDetails/']").length === 0
    ) {
      return null;
    }

    return null;
  },

  detailRequest(summary) {
    return { url: summary.url };
  },

  parseDetail
};
