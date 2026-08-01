import { load, type Cheerio } from "cheerio";
import { normalizeListingUrl } from "../../../domain/url.js";

const BLOCKED_PATTERN =
  /验证码|安全验证|_____tmd_____|\/punish|action\s*[:=]\s*["']captcha["']|请完成.{0,10}验证|访问过于频繁|aliyun_waf_(?:aa|bb)|aliyunCaptcha-sliding-slider/i;

export function isBlockedHtml(html: string): boolean {
  return BLOCKED_PATTERN.test(html);
}

export function absoluteUrl(base: string, href: string): string {
  return normalizeListingUrl(new URL(href, base).toString());
}

export function isVisibleLink(element: Cheerio<any>): boolean {
  if (element.attr("hidden") !== undefined) return false;
  if (element.attr("aria-hidden") === "true") return false;
  return !/display\s*:\s*none/i.test(element.attr("style") ?? "");
}

export function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function parsePrice(text: string): number | null {
  const match = text.match(/(?:¥|￥)\s*([\d,.]+)/);
  if (!match) return null;
  const value = Number(match[1].replaceAll(",", ""));
  return Number.isFinite(value) ? value : null;
}

export function parseChineseAmount(
  text: string,
  label: string
): number | null {
  const match = text.match(
    new RegExp(`${label}[】：:\\s]*([\\d.]+)\\s*(亿|[wW万]|[mM]|[bB])?`)
  );
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = match[2]?.toLowerCase();
  if (unit === "亿") return value * 100_000_000;
  if (unit === "w" || unit === "万") return value * 10_000;
  if (unit === "m") return value * 1_000_000;
  if (unit === "b") return value * 1_000_000_000;
  return value;
}

export function findVisibleCatalogLink(
  html: string,
  baseUrl: string,
  query: string
): string | null {
  const $ = load(html);
  let result: string | null = null;
  $("a[href]").each((_, node) => {
    if (result) return;
    const link = $(node);
    if (
      isVisibleLink(link) &&
      compactText(link.text()).includes(query) &&
      link.attr("href")
    ) {
      result = absoluteUrl(baseUrl, link.attr("href")!);
    }
  });
  return result;
}
