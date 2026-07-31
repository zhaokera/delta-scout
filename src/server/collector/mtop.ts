import { createHash } from "node:crypto";
import type {
  AnonymousMtopRequestOptions,
  SourceRequest
} from "./types.js";

export const APPROVED_JIAOYIMAO_MTOP_ENDPOINT =
  "https://mtop.jiaoyimao.com/h5/mtop.com.jym.layout.pc.goodslist.getunifiedgoodslist/1.0/";
export const APPROVED_JIAOYIMAO_REFERER =
  "https://www.jiaoyimao.com/jg2007840/f8845003-c8845004/o110/?searchCondition=%7B%22attr_7393855783477590029%22%3A%7B%22selectType%22%3A2%2C%22multiSearchCondition%22%3Atrue%2C%22conditionList%22%3A%5B%5D%2C%22childCondition%22%3A%7B%22mp_7393855783922186253%22%3A%7B%22%E6%9E%81%E5%93%81%7CS%22%3A%5B%22M7%E6%88%98%E6%96%97%E6%AD%A5%E6%9E%AA-%E6%A3%B1%E9%95%9C%E6%94%BB%E5%8A%BFS2%22%5D%2C%22%E6%9E%81%E5%93%81%7CA%22%3A%5B%22M7%E6%88%98%E6%96%97%E6%AD%A5%E6%9E%AA-%E6%A3%B1%E9%95%9C%E6%94%BB%E5%8A%BFS2%22%5D%2C%22%E6%9E%81%E5%93%81%7CB%22%3A%5B%22M7%E6%88%98%E6%96%97%E6%AD%A5%E6%9E%AA-%E6%A3%B1%E9%95%9C%E6%94%BB%E5%8A%BFS2%22%5D%2C%22%E6%9E%81%E5%93%81%7CC%22%3A%5B%22M7%E6%88%98%E6%96%97%E6%AD%A5%E6%9E%AA-%E6%A3%B1%E9%95%9C%E6%94%BB%E5%8A%BFS2%22%5D%2C%22%E4%BC%98%E5%93%81%7CS%22%3A%5B%22M7%E6%88%98%E6%96%97%E6%AD%A5%E6%9E%AA-%E6%A3%B1%E9%95%9C%E6%94%BB%E5%8A%BFS2%22%5D%7D%7D%2C%22statConditionList%22%3A%5B%5D%2C%22conditionType%22%3A3%7D%7D&enforcePlat=2&newPage=true";

const APPROVED_API =
  "mtop.com.jym.layout.pc.goodslist.getunifiedgoodslist";
const APPROVED_VERSION = "1.0";
const APPROVED_APP_KEY = "12574478";
const APPROVED_ORIGIN = "https://www.jiaoyimao.com";
const APPROVED_CONTENT_TYPE = "application/x-www-form-urlencoded";
const APPROVED_CLASS =
  "com.jym.delivery.hsf.dto.unifiedgoodslist.GoodsListQueryParams";
const APPROVED_PRISM_VALUE = "M7战斗步枪-棱镜攻势S2";
const APPROVED_QUALITY_KEYS = [
  "极品|S",
  "极品|A",
  "极品|B",
  "极品|C",
  "优品|S"
] as const;

export function signMtop(
  token: string,
  timestamp: number,
  appKey: string,
  data: string
): string {
  return createHash("md5")
    .update(`${token}&${timestamp}&${appKey}&${data}`)
    .digest("hex");
}

export function buildMtopUrl(
  endpoint: string,
  options: AnonymousMtopRequestOptions,
  timestamp: number,
  sign: string
): string {
  const query = new URLSearchParams([
    ["jsv", "2.7.2"],
    ["appKey", options.appKey],
    ["t", String(timestamp)],
    ["sign", sign],
    ["api", options.api],
    ["v", options.version],
    ["type", "original"],
    ["dataType", "json"]
  ]);
  return `${endpoint}?${query.toString()}`;
}

export function buildJymMeta(
  timestamp: number,
  random: number
): string {
  const prefix = Math.floor(random * 400) + 200;
  const sid = `${prefix}${timestamp}`;
  return JSON.stringify({
    sid,
    ssids: sid,
    ch: "",
    plat: "JYM_IOS_TOUCH",
    platform: "JYM_IOS_TOUCH",
    terminal: "pc",
    osCode: "other",
    chCode: "h5",
    ieuAppCode: "",
    webEntryType: "",
    ttidExtInfo: "#H5"
  });
}

export interface AnonymousMtopSession {
  readonly token: string;
  readonly cookieHeader: string;
}

export function extractAnonymousMtopSession(
  headers: Headers
): AnonymousMtopSession | null {
  const withGetSetCookie = headers as Headers & {
    getSetCookie?: () => string[];
  };
  const cookieLines =
    withGetSetCookie.getSetCookie?.() ??
    splitCombinedSetCookie(headers.get("set-cookie"));

  const cookies = new Map<string, string>();
  for (const cookieLine of cookieLines) {
    const pair = cookieLine.split(";", 1)[0]?.trim();
    const separator = pair?.indexOf("=") ?? -1;
    if (!pair) continue;
    if (separator <= 0) {
      if (pair === "_m_h5_tk" || pair === "_m_h5_tk_enc") {
        return null;
      }
      continue;
    }
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (name !== "_m_h5_tk" && name !== "_m_h5_tk_enc") {
      continue;
    }
    if (value.length === 0 || cookies.has(name)) {
      return null;
    }
    cookies.set(name, value);
  }

  const tokenCookie = cookies.get("_m_h5_tk");
  const encodedCookie = cookies.get("_m_h5_tk_enc");
  const tokenSeparator = tokenCookie?.lastIndexOf("_") ?? -1;
  const expiry = tokenCookie?.slice(tokenSeparator + 1);
  if (
    !tokenCookie ||
    !encodedCookie ||
    tokenSeparator <= 0 ||
    expiry === undefined ||
    !/^\d+$/.test(expiry)
  ) {
    return null;
  }

  return {
    token: tokenCookie.slice(0, tokenSeparator),
    cookieHeader:
      `_m_h5_tk=${tokenCookie}; _m_h5_tk_enc=${encodedCookie}`
  };
}

export function isApprovedJiaoyimaoMtopRequest(
  request: SourceRequest
): boolean {
  const options = request.options;
  const mtop = options?.anonymousMtop;
  return (
    request.url === APPROVED_JIAOYIMAO_MTOP_ENDPOINT &&
    options?.method === "POST" &&
    mtop?.api === APPROVED_API &&
    mtop.version === APPROVED_VERSION &&
    mtop.appKey === APPROVED_APP_KEY &&
    options.origin === APPROVED_ORIGIN &&
    options.referer === APPROVED_JIAOYIMAO_REFERER &&
    options.contentType === APPROVED_CONTENT_TYPE &&
    options.body !== undefined &&
    isApprovedJiaoyimaoMtopData(options.body)
  );
}

export function isApprovedJiaoyimaoMtopData(data: string): boolean {
  try {
    const outer: unknown = JSON.parse(data);
    if (
      !isRecordWithExactKeys(outer, [
        "searchCondition",
        "relateId",
        "pageSize",
        "modelType",
        "queryType",
        "goodsScene",
        "gameCondition",
        "categoryId",
        "parentId",
        "class",
        "page"
      ]) ||
      typeof outer.searchCondition !== "string" ||
      typeof outer.gameCondition !== "string"
    ) {
      return false;
    }

    return (
      isApprovedSearchCondition(outer.searchCondition) &&
      outer.relateId === "10101" &&
      outer.pageSize === 16 &&
      outer.modelType === "h5" &&
      outer.queryType === 1 &&
      outer.goodsScene === "goods_search_new" &&
      isApprovedGameCondition(outer.gameCondition) &&
      outer.categoryId === 8_845_004 &&
      outer.parentId === 8_845_003 &&
      outer.class === APPROVED_CLASS &&
      typeof outer.page === "string" &&
      /^(?:[2-9]|[1-9]\d+)$/.test(outer.page)
    );
  } catch {
    return false;
  }
}

export function deriveApprovedJiaoyimaoMtopPageOneData(
  data: string
): string | null {
  if (!isApprovedJiaoyimaoMtopData(data)) return null;
  const outer = JSON.parse(data) as Record<string, unknown>;
  if (outer.page !== "2") return null;
  outer.page = "1";
  return JSON.stringify(outer);
}

function isApprovedSearchCondition(value: string): boolean {
  const search: unknown = JSON.parse(value);
  if (
    !isRecordWithExactKeys(search, [
      "attr_7393855783477590029"
    ])
  ) {
    return false;
  }
  const attribute = search.attr_7393855783477590029;
  if (
    !isRecordWithExactKeys(attribute, [
      "selectType",
      "multiSearchCondition",
      "conditionList",
      "childCondition",
      "statConditionList",
      "conditionType"
    ]) ||
    attribute.selectType !== 2 ||
    attribute.multiSearchCondition !== true ||
    !isEmptyArray(attribute.conditionList) ||
    !isEmptyArray(attribute.statConditionList) ||
    attribute.conditionType !== 3
  ) {
    return false;
  }
  const child = attribute.childCondition;
  if (
    !isRecordWithExactKeys(child, [
      "mp_7393855783922186253"
    ])
  ) {
    return false;
  }
  const qualities = child.mp_7393855783922186253;
  if (
    !isRecordWithExactKeys(
      qualities,
      [...APPROVED_QUALITY_KEYS]
    )
  ) {
    return false;
  }
  return APPROVED_QUALITY_KEYS.every((key) => {
    const selection = qualities[key];
    return (
      Array.isArray(selection) &&
      selection.length === 1 &&
      selection[0] === APPROVED_PRISM_VALUE
    );
  });
}

function isApprovedGameCondition(value: string): boolean {
  const game: unknown = JSON.parse(value);
  return (
    isRecordWithExactKeys(game, [
      "gameId",
      "platformId",
      "clientId"
    ]) &&
    game.gameId === 2_007_840 &&
    game.platformId === 2 &&
    game.clientId === 110
  );
}

function isRecordWithExactKeys(
  value: unknown,
  keys: readonly string[]
): value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return false;
  }
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function isEmptyArray(value: unknown): value is [] {
  return Array.isArray(value) && value.length === 0;
}

function splitCombinedSetCookie(header: string | null): string[] {
  if (header === null) return [];
  return header
    .split(/,(?=\s*[^;,=\s]+=[^;,]*)/)
    .map((cookie) => cookie.trim());
}
