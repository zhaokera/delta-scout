import { requiresCandidateDetail } from "../../domain/priceRange.js";
import type { BrowserListItem } from "./contracts.js";

function hasCompleteCardEvidence(rawText: string): boolean {
  return (
    /(?:QQ双端|安卓QQ|苹果QQ|QQ帐号)/i.test(rawText) &&
    /骇爪[-·—\s]*维什戴尔/.test(rawText) &&
    /露娜[-·—\s]*黑[·—\s]*天际线/.test(rawText) &&
    /(?:不可|可)二次实名/.test(rawText) &&
    /(?:永久包赔|找回包赔|人脸包赔|无包赔|不支持.{0,8}包赔)/.test(
      rawText
    ) &&
    /总资产[】：:\s]*[\d.]+\s*(?:亿|[bBmM]|万|[wW])?/.test(rawText)
  );
}

/**
 * Trading Cat's filtered list cards already expose the critical evidence used
 * by eligibility and scoring. A detail navigation is only needed when a card
 * omits any of those fields; optional M7/Haf-coin enrichment must not force
 * hundreds of otherwise redundant page visits.
 */
export function requiresBrowserListItemDetail(
  item: BrowserListItem
): boolean {
  return (
    requiresCandidateDetail(item.priceCny) &&
    !hasCompleteCardEvidence(item.rawText)
  );
}

