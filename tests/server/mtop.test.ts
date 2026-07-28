// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { PublicPageFetcher } from "../../src/server/collector/fetcher.js";
import {
  buildJymMeta,
  buildMtopUrl,
  extractAnonymousMtopSession,
  isApprovedJiaoyimaoMtopRequest,
  signMtop
} from "../../src/server/collector/mtop.js";
import type { SourceRequest } from "../../src/server/collector/types.js";

const ENDPOINT =
  "https://mtop.jiaoyimao.com/h5/mtop.com.jym.layout.pc.goodslist.getunifiedgoodslist/1.0/";
const API =
  "mtop.com.jym.layout.pc.goodslist.getunifiedgoodslist";
const APP_KEY = "12574478";
const ENTRY_URL =
  "https://www.jiaoyimao.com/jg2007840/f8845003-c8845004/o110/?searchCondition=%7B%22attr_7393855783477590029%22%3A%7B%22selectType%22%3A2%2C%22multiSearchCondition%22%3Atrue%2C%22conditionList%22%3A%5B%5D%2C%22childCondition%22%3A%7B%22mp_7393855783922186253%22%3A%7B%22%E6%9E%81%E5%93%81%7CS%22%3A%5B%22M7%E6%88%98%E6%96%97%E6%AD%A5%E6%9E%AA-%E6%A3%B1%E9%95%9C%E6%94%BB%E5%8A%BFS2%22%5D%2C%22%E6%9E%81%E5%93%81%7CA%22%3A%5B%22M7%E6%88%98%E6%96%97%E6%AD%A5%E6%9E%AA-%E6%A3%B1%E9%95%9C%E6%94%BB%E5%8A%BFS2%22%5D%2C%22%E6%9E%81%E5%93%81%7CB%22%3A%5B%22M7%E6%88%98%E6%96%97%E6%AD%A5%E6%9E%AA-%E6%A3%B1%E9%95%9C%E6%94%BB%E5%8A%BFS2%22%5D%2C%22%E6%9E%81%E5%93%81%7CC%22%3A%5B%22M7%E6%88%98%E6%96%97%E6%AD%A5%E6%9E%AA-%E6%A3%B1%E9%95%9C%E6%94%BB%E5%8A%BFS2%22%5D%7D%7D%2C%22statConditionList%22%3A%5B%5D%2C%22conditionType%22%3A3%7D%7D&enforcePlat=2&newPage=true";
const USER_AGENT =
  "DeltaAccountScout/0.1 (+local personal comparison tool)";
const DATA =
  '{"searchCondition":"{\\"conditionType\\":3}","page":"2"}';

function approvedRequest(): SourceRequest {
  return {
    url: ENDPOINT,
    options: {
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      origin: "https://www.jiaoyimao.com",
      referer: ENTRY_URL,
      body: DATA,
      anonymousMtop: {
        api: API,
        version: "1.0",
        appKey: APP_KEY
      }
    }
  };
}

function responseWithCookies(
  body: string,
  cookies: readonly string[]
): Response {
  const headers = new Headers({
    "content-type": "application/json"
  });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(body, { status: 200, headers });
}

describe("anonymous MTop helpers", () => {
  it("signs the exact unencoded data string with lowercase MD5", () => {
    expect(
      signMtop(
        "token",
        1_700_000_000_000,
        APP_KEY,
        '{"page":"2"}'
      )
    ).toBe("bf573cb8bbaeccb886951b7658a7e29e");
  });

  it("builds the exact approved MTop query", () => {
    expect(
      buildMtopUrl(
        ENDPOINT,
        { api: API, version: "1.0", appKey: APP_KEY },
        1_700_000_000_000,
        "abc123"
      )
    ).toBe(
      `${ENDPOINT}?jsv=2.7.2&appKey=12574478&t=1700000000000&sign=abc123&api=mtop.com.jym.layout.pc.goodslist.getunifiedgoodslist&v=1.0&type=original&dataType=json`
    );
  });

  it("builds one-line JYM metadata with the exact fields", () => {
    const meta = buildJymMeta(1_700_000_000_000, 0.5);
    expect(meta).not.toContain("\n");
    expect(JSON.parse(meta)).toEqual({
      sid: "4001700000000000",
      ssids: "4001700000000000",
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
  });

  it("keeps the metadata random prefix in the inclusive 200..599 range", () => {
    expect(JSON.parse(buildJymMeta(1_700_000_000_000, 0)).sid).toBe(
      "2001700000000000"
    );
    expect(
      JSON.parse(buildJymMeta(1_700_000_000_000, 0.999_999)).sid
    ).toBe("5991700000000000");
  });

  it("extracts only the two anonymous MTop cookies", () => {
    const headers = new Headers();
    headers.append(
      "set-cookie",
      "_m_h5_tk=token-value_1700000000000; Path=/; HttpOnly"
    );
    headers.append(
      "set-cookie",
      "_m_h5_tk_enc=encoded-value; Path=/; Secure"
    );

    expect(extractAnonymousMtopSession(headers)).toEqual({
      token: "token-value",
      cookieHeader:
        "_m_h5_tk=token-value_1700000000000; _m_h5_tk_enc=encoded-value"
    });
  });

  it.each([
    ["missing token cookie", ["_m_h5_tk_enc=encoded; Path=/"]],
    ["missing encoded cookie", ["_m_h5_tk=token_123; Path=/"]],
    [
      "token without timestamp separator",
      [
        "_m_h5_tk=token; Path=/",
        "_m_h5_tk_enc=encoded; Path=/"
      ]
    ],
    [
      "an unrelated cookie",
      [
        "_m_h5_tk=token_123; Path=/",
        "_m_h5_tk_enc=encoded; Path=/",
        "login_session=secret; Path=/"
      ]
    ],
    [
      "an empty encoded cookie",
      ["_m_h5_tk=token_123; Path=/", "_m_h5_tk_enc=; Path=/"]
    ]
  ])("rejects %s", (_name, cookies) => {
    const headers = new Headers();
    for (const cookie of cookies) headers.append("set-cookie", cookie);
    expect(extractAnonymousMtopSession(headers)).toBeNull();
  });
});

describe("anonymous MTop whitelist", () => {
  it("accepts only the exact Jiaoyimao public goods-list request", () => {
    expect(isApprovedJiaoyimaoMtopRequest(approvedRequest())).toBe(true);
  });

  it.each([
    ["host", { url: ENDPOINT.replace("mtop.", "evil.") }],
    ["path", { url: `${ENDPOINT}adjacent` }],
    [
      "api",
      {
        anonymousMtop: {
          api: "mtop.com.jym.layout.pc.goods.detail",
          version: "1.0",
          appKey: APP_KEY
        }
      }
    ],
    [
      "version",
      { anonymousMtop: { api: API, version: "2.0", appKey: APP_KEY } }
    ],
    [
      "app key",
      { anonymousMtop: { api: API, version: "1.0", appKey: "wrong" } }
    ],
    ["origin", { origin: "https://evil.example" }],
    ["referer", { referer: `${ENTRY_URL}&is_second_real_name=true` }],
    ["method", { method: "GET" }],
    ["content type", { contentType: "application/json" }],
    ["missing body", { body: undefined }]
  ])("rejects a request with a changed %s", (_name, mutation) => {
    const request = approvedRequest();
    const { url, ...optionMutation } = mutation as {
      url?: string;
    } & NonNullable<SourceRequest["options"]>;
    expect(
      isApprovedJiaoyimaoMtopRequest({
        url: url ?? request.url,
        options: { ...request.options, ...optionMutation }
      })
    ).toBe(false);
  });
});

describe("PublicPageFetcher anonymous MTop transport", () => {
  it("performs an empty-token handshake and one signed retry", async () => {
    let now = 1_700_000_000_000;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const successBody =
      '{"ret":["SUCCESS::调用成功"],"data":{"result":{"deliverComps":[],"hasNextPage":"false"}}}';
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (calls.length === 1) {
        now += 1;
        return responseWithCookies(
          '{"ret":["FAIL_SYS_TOKEN_EMPTY::令牌为空"]}',
          [
            "_m_h5_tk=anonymous-token_1700000000000; Path=/; HttpOnly",
            "_m_h5_tk_enc=anonymous-enc; Path=/; Secure"
          ]
        );
      }
      return new Response(successBody, { status: 200 });
    });
    const fetcher = new PublicPageFetcher({
      fetchFn,
      now: () => now,
      random: () => 0.5,
      minimumIntervalMs: 0
    });

    await expect(
      fetcher.fetchPage(approvedRequest(), "jiaoyimao")
    ).resolves.toEqual({
      kind: "ok",
      url: ENDPOINT,
      status: 200,
      html: successBody
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);

    const firstUrl = new URL(calls[0]!.url);
    const secondUrl = new URL(calls[1]!.url);
    expect(`${firstUrl.origin}${firstUrl.pathname}`).toBe(ENDPOINT);
    expect(firstUrl.searchParams.get("t")).toBe("1700000000000");
    expect(firstUrl.searchParams.get("sign")).toBe(
      signMtop("", 1_700_000_000_000, APP_KEY, DATA)
    );
    expect(secondUrl.searchParams.get("t")).toBe("1700000000001");
    expect(secondUrl.searchParams.get("sign")).toBe(
      signMtop(
        "anonymous-token",
        1_700_000_000_001,
        APP_KEY,
        DATA
      )
    );

    const encodedBody = new URLSearchParams({ data: DATA }).toString();
    expect(calls[0]!.init?.body).toBe(encodedBody);
    expect(calls[1]!.init?.body).toBe(encodedBody);
    expect(new URLSearchParams(String(calls[1]!.init?.body)).get("data")).toBe(
      DATA
    );

    const firstHeaders = new Headers(calls[0]!.init?.headers);
    const secondHeaders = new Headers(calls[1]!.init?.headers);
    expect(firstHeaders.get("accept")).toBe("application/json");
    expect(firstHeaders.get("content-type")).toBe(
      "application/x-www-form-urlencoded"
    );
    expect(firstHeaders.get("origin")).toBe(
      "https://www.jiaoyimao.com"
    );
    expect(firstHeaders.get("referer")).toBe(ENTRY_URL);
    expect(firstHeaders.get("user-agent")).toBe(USER_AGENT);
    expect(firstHeaders.get("x-ua")).toBe(USER_AGENT);
    expect(JSON.parse(firstHeaders.get("jym-meta-h5")!)).toMatchObject({
      sid: "4001700000000000",
      ssids: "4001700000000000"
    });
    expect(firstHeaders.has("cookie")).toBe(false);
    expect(firstHeaders.has("authorization")).toBe(false);
    expect(secondHeaders.get("cookie")).toBe(
      "_m_h5_tk=anonymous-token_1700000000000; _m_h5_tk_enc=anonymous-enc"
    );
  });

  it("uses one replacement session after a signed token expires", async () => {
    let now = 1_700_000_000_000;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      now += 1;
      if (calls.length === 1) {
        return responseWithCookies(
          '{"ret":["FAIL_SYS_TOKEN_EMPTY::令牌为空"]}',
          [
            "_m_h5_tk=first-token_1; Path=/",
            "_m_h5_tk_enc=first-enc; Path=/"
          ]
        );
      }
      if (calls.length === 2) {
        return responseWithCookies(
          '{"ret":["FAIL_SYS_TOKEN_EXPIRED::令牌过期"]}',
          [
            "_m_h5_tk=replacement-token_2; Path=/",
            "_m_h5_tk_enc=replacement-enc; Path=/"
          ]
        );
      }
      return new Response('{"ret":["SUCCESS::调用成功"]}');
    });
    const fetcher = new PublicPageFetcher({
      fetchFn,
      now: () => now,
      random: () => 0,
      minimumIntervalMs: 0
    });

    await expect(
      fetcher.fetchPage(approvedRequest(), "jiaoyimao")
    ).resolves.toMatchObject({ kind: "ok" });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(new Headers(calls[1]!.init?.headers).get("cookie")).toBe(
      "_m_h5_tk=first-token_1; _m_h5_tk_enc=first-enc"
    );
    expect(new Headers(calls[2]!.init?.headers).get("cookie")).toBe(
      "_m_h5_tk=replacement-token_2; _m_h5_tk_enc=replacement-enc"
    );
  });

  it("fails without looping when expiry has no replacement session", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        responseWithCookies(
          '{"ret":["FAIL_SYS_TOKEN_EMPTY::令牌为空"]}',
          [
            "_m_h5_tk=first-token_1; Path=/",
            "_m_h5_tk_enc=first-enc; Path=/"
          ]
        )
      )
      .mockResolvedValueOnce(
        new Response('{"ret":["FAIL_SYS_TOKEN_EXPIRED::令牌过期"]}')
      );
    const fetcher = new PublicPageFetcher({
      fetchFn,
      minimumIntervalMs: 0
    });

    await expect(
      fetcher.fetchPage(approvedRequest(), "jiaoyimao")
    ).resolves.toEqual({
      kind: "failed",
      url: ENDPOINT,
      error: "mtop_token_expired_without_replacement"
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["invalid JSON", "not json"],
    ["missing ret", '{"data":{}}'],
    ["non-array ret", '{"ret":"FAIL_SYS_TOKEN_EMPTY"}'],
    ["non-string ret member", '{"ret":[123]}']
  ])("fails once for %s", async (_name, body) => {
    const fetchFn = vi.fn(async () => new Response(body));
    const fetcher = new PublicPageFetcher({
      fetchFn,
      minimumIntervalMs: 0
    });

    await expect(
      fetcher.fetchPage(approvedRequest(), "jiaoyimao")
    ).resolves.toEqual({
      kind: "failed",
      url: ENDPOINT,
      error: "invalid_mtop_response"
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
