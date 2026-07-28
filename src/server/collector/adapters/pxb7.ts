import type { SourceAdapter } from "../types.js";
import {
  findVisibleCatalogLink,
  isBlockedHtml
} from "./shared.js";

const BASE_URL = "https://www.pxb7.com/";

export const pxb7Adapter: SourceAdapter = {
  source: "pxb7",
  entryUrl: BASE_URL,

  discoverCatalog(html, query) {
    if (isBlockedHtml(html)) {
      return { kind: "blocked", reason: "captcha_required" };
    }
    const url = findVisibleCatalogLink(html, BASE_URL, query);
    return url
      ? { kind: "ok", url }
      : { kind: "blocked", reason: "catalog_not_found" };
  },

  parseList(html) {
    return {
      kind: "blocked",
      reason: isBlockedHtml(html)
        ? "captcha_required"
        : "unverified_structure"
    };
  },

  nextPage() {
    return null;
  },

  detailUrl(summary) {
    return summary.url;
  },

  parseDetail(html) {
    return {
      kind: "blocked",
      reason: isBlockedHtml(html)
        ? "captcha_required"
        : "unverified_structure"
    };
  }
};
