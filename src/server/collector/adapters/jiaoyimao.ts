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
  isBlockedHtml,
  isVisibleLink,
  parseChineseAmount
} from "./shared.js";

const BASE_URL = "https://www.jiaoyimao.com/";
const FILTERED_CATALOG_URL =
  "https://www.jiaoyimao.com/jg2007840/f8845003-c8845004/o110/?searchCondition=%7B%22is_second_real_name%22%3A%7B%22selectType%22%3A1%2C%22conditionList%22%3A%5B%2210071%22%5D%2C%22statConditionList%22%3A%5B%22%E5%8F%AF%E4%BA%8C%E6%AC%A1%E5%AE%9E%E5%90%8D%22%5D%2C%22conditionType%22%3A2%7D%2C%22attr_7393855783477590029%22%3A%7B%22selectType%22%3A2%2C%22multiSearchCondition%22%3Atrue%2C%22conditionList%22%3A%5B%5D%2C%22childCondition%22%3A%7B%22mp_7393855783922186253%22%3A%7B%22%E6%9E%81%E5%93%81%7CS%22%3A%5B%22M7%E6%88%98%E6%96%97%E6%AD%A5%E6%9E%AA-%E6%A3%B1%E9%95%9C%E6%94%BB%E5%8A%BFS2%22%5D%2C%22%E6%9E%81%E5%93%81%7CA%22%3A%5B%22M7%E6%88%98%E6%96%97%E6%AD%A5%E6%9E%AA-%E6%A3%B1%E9%95%9C%E6%94%BB%E5%8A%BFS2%22%5D%7D%7D%2C%22statConditionList%22%3A%5B%5D%2C%22conditionType%22%3A3%7D%7D&enforcePlat=2&newPage=true";

function normalizedM7Evidence(text: string): string | null {
  const match = text.match(
    /M7\s*[-·：:]?\s*极品(?:\||\s)*([SA])/i
  );
  return match ? `M7棱镜攻势(极品${match[1].toUpperCase()})` : null;
}

function parseNumber(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value.replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseVerificationAt(text: string): string | null {
  const match = text.match(
    /验号时间[：:\s]*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/
  );
  if (!match) return null;
  const parsed = new Date(`${match[1]}T${match[2]}+08:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
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
  if (!head || !report) {
    return { kind: "blocked", reason: "structure_changed" };
  }

  const evidence = toEvidenceRecords(
    [...new Set([head, report, safety].filter(Boolean))]
  );
  const currentProductText = evidence.map(({ text }) => text).join("\n");
  const totalAssetsRaw = parseChineseAmount(
    currentProductText,
    "总资产"
  );
  const totalAssetsM =
    totalAssetsRaw === null ? null : totalAssetsRaw / 1_000_000;
  const hafCoinsMatch = currentProductText.match(
    /哈夫币(?:数量)?[】:\s]*([\d,.]+)/
  );
  const loginPlatform = /QQ双端帐号|安卓QQ/.test(head)
    ? "qq"
    : /微信双端帐号|安卓微信/.test(head)
      ? "wechat"
      : "unknown";
  const cannotSecond = /不可二次实名/.test(currentProductText);
  const canSecond =
    !cannotSecond && /(?:是否可二次实名)?可二次实名/.test(currentProductText);
  const noCoverage = /不支持永久包赔|无包赔/.test(currentProductText);
  const hasCoverage = !noCoverage && /永久包赔/.test(currentProductText);
  const hasBanWarning =
    /黑号校验(?:未通过|异常)|(?:存在|有)封号记录/.test(
      currentProductText
    );

  return {
    kind: "ok",
    detail: {
      evidence,
      loginPlatform,
      service: loginPlatform === "qq" ? "official" : "unknown",
      totalAssetsM,
      hafCoins: parseNumber(hafCoinsMatch?.[1]),
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
      verificationAt: parseVerificationAt(currentProductText),
      banNotes: hasBanWarning ? ["页面提示存在封号或黑号风险"] : []
    }
  };
}

export const jiaoyimaoAdapter: SourceAdapter = {
  source: "jiaoyimao",
  entryUrl: FILTERED_CATALOG_URL,

  discoverCatalog(html, _query) {
    if (isBlockedHtml(html)) {
      return { kind: "blocked", reason: "captcha_required" };
    }
    const $ = load(html);
    const verifiedCard = $(
      ".pcGoodsListItem[data-goodsid][data-price][href]"
    ).first();
    return verifiedCard.length > 0 && isVisibleLink(verifiedCard)
      ? { kind: "ok", url: FILTERED_CATALOG_URL }
      : { kind: "blocked", reason: "unverified_structure" };
  },

  parseList(html) {
    if (isBlockedHtml(html)) {
      return { kind: "blocked", reason: "captcha_required" };
    }
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
  },

  nextPage(html) {
    const $ = load(html);
    const link = $("a[rel='next'][href]").first();
    const href = link.attr("href");
    return href && isVisibleLink(link) ? absoluteUrl(BASE_URL, href) : null;
  },

  detailUrl(summary) {
    return summary.url;
  },

  parseDetail: extractDetail
};
