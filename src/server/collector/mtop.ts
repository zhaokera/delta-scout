import { createHash } from "node:crypto";
import type {
  AnonymousMtopRequestOptions,
  SourceRequest
} from "./types.js";

export const APPROVED_JIAOYIMAO_MTOP_ENDPOINT =
  "https://mtop.jiaoyimao.com/h5/mtop.com.jym.layout.pc.goodslist.getunifiedgoodslist/1.0/";
export const APPROVED_JIAOYIMAO_SEARCH_CONDITION = {
  price: {
    conditionList: ["1900,4000"],
    groupName: "价格范围",
    statConditionList: ["1900-4000"]
  },
  is_second_real_name: {
    selectType: 1,
    conditionList: ["10071"],
    statConditionList: ["可二次实名"],
    conditionType: 2
  },
  selling_point_7322805066952352771: {
    selectType: 1,
    multiSearchCondition: false,
    conditionList: ["骇爪-维什戴尔", "露娜-黑·天际线"],
    statConditionList: ["骇爪-维什戴尔", "露娜-黑·天际线"],
    conditionType: 3
  }
} as const;
export const APPROVED_JIAOYIMAO_SEARCH_CONDITION_JSON = JSON.stringify(
  APPROVED_JIAOYIMAO_SEARCH_CONDITION
);
export const APPROVED_JIAOYIMAO_BROWSER_PRICE_CONDITION = {
  price: {
    conditionList: ["1900,4000"],
    statConditionList: ["1900-4000"]
  }
} as const;
export const APPROVED_JIAOYIMAO_BROWSER_PRICE_CONDITION_JSON = JSON.stringify(
  APPROVED_JIAOYIMAO_BROWSER_PRICE_CONDITION
);
export const APPROVED_JIAOYIMAO_BROWSER_SEARCH_CONDITION = {
  is_second_real_name: {
    selectType: 1,
    conditionList: ["10071"],
    statConditionList: ["可二次实名"],
    conditionType: 2
  },
  selling_point_7322805066952352771: {
    selectType: 1,
    multiSearchCondition: false,
    conditionList: ["骇爪-维什戴尔", "露娜-黑·天际线"],
    statConditionList: ["骇爪-维什戴尔", "露娜-黑·天际线"],
    conditionType: 3
  }
} as const;
export const APPROVED_JIAOYIMAO_BROWSER_SEARCH_CONDITION_JSON = JSON.stringify(
  APPROVED_JIAOYIMAO_BROWSER_SEARCH_CONDITION
);
export const APPROVED_JIAOYIMAO_REFERER =
  "https://www.jiaoyimao.com/jg2007840/f8845003-c8845004/" +
  "o1687157900084320/?rId=108" +
  `&priceCondition=${encodeURIComponent(
    APPROVED_JIAOYIMAO_BROWSER_PRICE_CONDITION_JSON
  )}` +
  `&searchCondition=${encodeURIComponent(
    APPROVED_JIAOYIMAO_BROWSER_SEARCH_CONDITION_JSON
  )}&enforcePlat=2&newPage=true`;

const APPROVED_API =
  "mtop.com.jym.layout.pc.goodslist.getunifiedgoodslist";
const APPROVED_VERSION = "1.0";
const APPROVED_APP_KEY = "12574478";
const APPROVED_ORIGIN = "https://www.jiaoyimao.com";
const APPROVED_CONTENT_TYPE = "application/x-www-form-urlencoded";
const APPROVED_CLASS =
  "com.jym.delivery.hsf.dto.unifiedgoodslist.GoodsListQueryParams";

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
      /^[1-9]\d*$/.test(outer.page)
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
  if (outer.page !== "1" && outer.page !== "2") return null;
  outer.page = "1";
  return JSON.stringify(outer);
}

function isApprovedSearchCondition(value: string): boolean {
  const search: unknown = JSON.parse(value);
  if (
    !isRecordWithExactKeys(search, [
      "price",
      "is_second_real_name",
      "selling_point_7322805066952352771"
    ])
  ) {
    return false;
  }
  const price = search.price;
  const secondRealName = search.is_second_real_name;
  const operatorSkins = search.selling_point_7322805066952352771;
  return (
    isRecordWithExactKeys(price, [
      "conditionList",
      "groupName",
      "statConditionList"
    ]) &&
    Array.isArray(price.conditionList) &&
    price.conditionList.length === 1 &&
    price.conditionList[0] === "1900,4000" &&
    price.groupName === "价格范围" &&
    Array.isArray(price.statConditionList) &&
    price.statConditionList.length === 1 &&
    price.statConditionList[0] === "1900-4000" &&
    isRecordWithExactKeys(secondRealName, [
      "selectType",
      "conditionList",
      "statConditionList",
      "conditionType"
    ]) &&
    secondRealName.selectType === 1 &&
    Array.isArray(secondRealName.conditionList) &&
    secondRealName.conditionList.length === 1 &&
    secondRealName.conditionList[0] === "10071" &&
    Array.isArray(secondRealName.statConditionList) &&
    secondRealName.statConditionList.length === 1 &&
    secondRealName.statConditionList[0] === "可二次实名" &&
    secondRealName.conditionType === 2 &&
    isRecordWithExactKeys(operatorSkins, [
      "selectType",
      "multiSearchCondition",
      "conditionList",
      "statConditionList",
      "conditionType"
    ]) &&
    operatorSkins.selectType === 1 &&
    operatorSkins.multiSearchCondition === false &&
    Array.isArray(operatorSkins.conditionList) &&
    operatorSkins.conditionList.length === 2 &&
    operatorSkins.conditionList[0] === "骇爪-维什戴尔" &&
    operatorSkins.conditionList[1] === "露娜-黑·天际线" &&
    Array.isArray(operatorSkins.statConditionList) &&
    operatorSkins.statConditionList.length === 2 &&
    operatorSkins.statConditionList[0] === "骇爪-维什戴尔" &&
    operatorSkins.statConditionList[1] === "露娜-黑·天际线" &&
    operatorSkins.conditionType === 3
  );
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

function splitCombinedSetCookie(header: string | null): string[] {
  if (header === null) return [];
  return header
    .split(/,(?=\s*[^;,=\s]+=[^;,]*)/)
    .map((cookie) => cookie.trim());
}
