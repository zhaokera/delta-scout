import { createHash } from "node:crypto";
import type {
  AnonymousMtopRequestOptions,
  SourceRequest
} from "./types.js";

export const APPROVED_JIAOYIMAO_MTOP_ENDPOINT =
  "https://mtop.jiaoyimao.com/h5/mtop.com.jym.layout.pc.goodslist.getunifiedgoodslist/1.0/";
export const APPROVED_JIAOYIMAO_REFERER =
  "https://www.jiaoyimao.com/jg2007840/f8845003-c8845004/o110/?searchCondition=%7B%22attr_7393855783477590029%22%3A%7B%22selectType%22%3A2%2C%22multiSearchCondition%22%3Atrue%2C%22conditionList%22%3A%5B%5D%2C%22childCondition%22%3A%7B%22mp_7393855783922186253%22%3A%7B%22%E6%9E%81%E5%93%81%7CS%22%3A%5B%22M7%E6%88%98%E6%96%97%E6%AD%A5%E6%9E%AA-%E6%A3%B1%E9%95%9C%E6%94%BB%E5%8A%BFS2%22%5D%2C%22%E6%9E%81%E5%93%81%7CA%22%3A%5B%22M7%E6%88%98%E6%96%97%E6%AD%A5%E6%9E%AA-%E6%A3%B1%E9%95%9C%E6%94%BB%E5%8A%BFS2%22%5D%2C%22%E6%9E%81%E5%93%81%7CB%22%3A%5B%22M7%E6%88%98%E6%96%97%E6%AD%A5%E6%9E%AA-%E6%A3%B1%E9%95%9C%E6%94%BB%E5%8A%BFS2%22%5D%2C%22%E6%9E%81%E5%93%81%7CC%22%3A%5B%22M7%E6%88%98%E6%96%97%E6%AD%A5%E6%9E%AA-%E6%A3%B1%E9%95%9C%E6%94%BB%E5%8A%BFS2%22%5D%7D%7D%2C%22statConditionList%22%3A%5B%5D%2C%22conditionType%22%3A3%7D%7D&enforcePlat=2&newPage=true";

const APPROVED_API =
  "mtop.com.jym.layout.pc.goodslist.getunifiedgoodslist";
const APPROVED_VERSION = "1.0";
const APPROVED_APP_KEY = "12574478";
const APPROVED_ORIGIN = "https://www.jiaoyimao.com";
const APPROVED_CONTENT_TYPE = "application/x-www-form-urlencoded";

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
  if (cookieLines.length !== 2) return null;

  const cookies = new Map<string, string>();
  for (const cookieLine of cookieLines) {
    const pair = cookieLine.split(";", 1)[0]?.trim();
    const separator = pair?.indexOf("=") ?? -1;
    if (!pair || separator <= 0) return null;
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (
      (name !== "_m_h5_tk" && name !== "_m_h5_tk_enc") ||
      value.length === 0 ||
      cookies.has(name)
    ) {
      return null;
    }
    cookies.set(name, value);
  }

  const tokenCookie = cookies.get("_m_h5_tk");
  const encodedCookie = cookies.get("_m_h5_tk_enc");
  const tokenSeparator = tokenCookie?.indexOf("_") ?? -1;
  if (
    !tokenCookie ||
    !encodedCookie ||
    tokenSeparator <= 0 ||
    tokenSeparator === tokenCookie.length - 1
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
    options.body !== undefined
  );
}

function splitCombinedSetCookie(header: string | null): string[] {
  if (header === null) return [];
  return header
    .split(/,(?=\s*[^;,=\s]+=[^;,]*)/)
    .map((cookie) => cookie.trim());
}
