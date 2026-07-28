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
const SEARCH_CONDITION = JSON.stringify({
  attr_7393855783477590029: {
    selectType: 2,
    multiSearchCondition: true,
    conditionList: [],
    childCondition: {
      mp_7393855783922186253: {
        "极品|S": ["M7战斗步枪-棱镜攻势S2"],
        "极品|A": ["M7战斗步枪-棱镜攻势S2"],
        "极品|B": ["M7战斗步枪-棱镜攻势S2"],
        "极品|C": ["M7战斗步枪-棱镜攻势S2"]
      }
    },
    statConditionList: [],
    conditionType: 3
  }
});
const GAME_CONDITION = JSON.stringify({
  gameId: 2_007_840,
  platformId: 2,
  clientId: 110
});
const DATA = JSON.stringify({
  searchCondition: SEARCH_CONDITION,
  relateId: "10101",
  pageSize: 16,
  modelType: "h5",
  queryType: 1,
  goodsScene: "goods_search_new",
  gameCondition: GAME_CONDITION,
  categoryId: 8_845_004,
  parentId: 8_845_003,
  class:
    "com.jym.delivery.hsf.dto.unifiedgoodslist.GoodsListQueryParams",
  page: "2"
});
const SUCCESS_BODY =
  '{"ret":["SUCCESS::调用成功"],"data":{"result":{"deliverComps":[],"hasNextPage":"false"}}}';

function approvedRequest(body = DATA): SourceRequest {
  return {
    url: ENDPOINT,
    options: {
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      origin: "https://www.jiaoyimao.com",
      referer: ENTRY_URL,
      body,
      anonymousMtop: {
        api: API,
        version: "1.0",
        appKey: APP_KEY
      }
    }
  };
}

function mutateData(
  mutate: (outer: Record<string, unknown>) => void
): string {
  const outer = JSON.parse(DATA) as Record<string, unknown>;
  mutate(outer);
  return JSON.stringify(outer);
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

  it("uses the final underscore to separate a numeric token expiry", () => {
    const headers = new Headers();
    headers.append(
      "set-cookie",
      "_m_h5_tk=token_with_parts_1700000000000; Path=/"
    );
    headers.append(
      "set-cookie",
      "_m_h5_tk_enc=encoded; Path=/"
    );

    expect(extractAnonymousMtopSession(headers)).toEqual({
      token: "token_with_parts",
      cookieHeader:
        "_m_h5_tk=token_with_parts_1700000000000; _m_h5_tk_enc=encoded"
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
    ],
    [
      "a nonnumeric token expiry",
      [
        "_m_h5_tk=token_not-a-timestamp; Path=/",
        "_m_h5_tk_enc=encoded; Path=/"
      ]
    ],
    [
      "an empty token expiry",
      [
        "_m_h5_tk=token_; Path=/",
        "_m_h5_tk_enc=encoded; Path=/"
      ]
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

  it.each([
    [
      "filter value",
      mutateData((outer) => {
        const search = JSON.parse(String(outer.searchCondition)) as {
          attr_7393855783477590029: {
            childCondition: {
              mp_7393855783922186253: Record<string, string[]>;
            };
          };
        };
        search.attr_7393855783477590029.childCondition
          .mp_7393855783922186253["极品|S"] = ["changed"];
        outer.searchCondition = JSON.stringify(search);
      })
    ],
    [
      "extra second-real-name filter",
      mutateData((outer) => {
        const search = JSON.parse(
          String(outer.searchCondition)
        ) as Record<string, unknown>;
        search.is_second_real_name = true;
        outer.searchCondition = JSON.stringify(search);
      })
    ],
    [
      "game condition",
      mutateData((outer) => {
        const game = JSON.parse(String(outer.gameCondition)) as {
          clientId: number;
        };
        game.clientId = 111;
        outer.gameCondition = JSON.stringify(game);
      })
    ],
    [
      "category",
      mutateData((outer) => {
        outer.categoryId = 1;
      })
    ],
    [
      "class",
      mutateData((outer) => {
        outer.class = "com.jym.delivery.Other";
      })
    ],
    [
      "zero page",
      mutateData((outer) => {
        outer.page = "0";
      })
    ],
    [
      "non-integer page",
      mutateData((outer) => {
        outer.page = "2.5";
      })
    ],
    [
      "numeric page",
      mutateData((outer) => {
        outer.page = 2;
      })
    ],
    [
      "extra outer field",
      mutateData((outer) => {
        outer.extra = true;
      })
    ],
    [
      "missing fixed field",
      mutateData((outer) => {
        delete outer.goodsScene;
      })
    ]
  ])("rejects a body with a changed %s", (_name, body) => {
    expect(
      isApprovedJiaoyimaoMtopRequest(approvedRequest(body))
    ).toBe(false);
  });
});

describe("PublicPageFetcher anonymous MTop transport", () => {
  it("performs an empty-token handshake and one signed retry", async () => {
    let now = 1_700_000_000_000;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
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
      return new Response(SUCCESS_BODY, { status: 200 });
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
      html: SUCCESS_BODY
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
      return new Response(SUCCESS_BODY);
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
    ["ret-only success", '{"ret":["SUCCESS::调用成功"]}'],
    [
      "missing result",
      '{"ret":["SUCCESS::调用成功"],"data":{}}'
    ],
    [
      "missing deliverComps",
      '{"ret":["SUCCESS::调用成功"],"data":{"result":{"hasNextPage":false}}}'
    ],
    [
      "missing hasNextPage",
      '{"ret":["SUCCESS::调用成功"],"data":{"result":{"deliverComps":[]}}}'
    ],
    [
      "invalid hasNextPage",
      '{"ret":["SUCCESS::调用成功"],"data":{"result":{"deliverComps":[],"hasNextPage":"yes"}}}'
    ]
  ])("rejects %s as an invalid success payload", async (_name, body) => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        responseWithCookies(
          '{"ret":["FAIL_SYS_TOKEN_EMPTY::令牌为空"]}',
          [
            "_m_h5_tk=token_1; Path=/",
            "_m_h5_tk_enc=enc; Path=/"
          ]
        )
      )
      .mockResolvedValueOnce(new Response(body));
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
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("never makes a fourth call when the final signed request fails", async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return responseWithCookies(
          '{"ret":["FAIL_SYS_TOKEN_EMPTY::令牌为空"]}',
          [
            "_m_h5_tk=first-token_1; Path=/",
            "_m_h5_tk_enc=first-enc; Path=/"
          ]
        );
      }
      if (calls === 2) {
        return responseWithCookies(
          '{"ret":["FAIL_SYS_TOKEN_EXPIRED::令牌过期"]}',
          [
            "_m_h5_tk=replacement-token_2; Path=/",
            "_m_h5_tk_enc=replacement-enc; Path=/"
          ]
        );
      }
      if (calls === 3) throw new Error("socket reset");
      return new Response(SUCCESS_BODY);
    });
    const fetcher = new PublicPageFetcher({
      fetchFn,
      minimumIntervalMs: 0
    });

    await expect(
      fetcher.fetchPage(approvedRequest(), "jiaoyimao")
    ).resolves.toEqual({
      kind: "failed",
      url: ENDPOINT,
      error: "network_error"
    });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("uses one transient retry when the three-call budget allows it", async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket reset"))
      .mockResolvedValueOnce(
        responseWithCookies(
          '{"ret":["FAIL_SYS_TOKEN_EMPTY::令牌为空"]}',
          [
            "_m_h5_tk=token_1; Path=/",
            "_m_h5_tk_enc=enc; Path=/"
          ]
        )
      )
      .mockResolvedValueOnce(new Response(SUCCESS_BODY));
    const fetcher = new PublicPageFetcher({
      fetchFn,
      minimumIntervalMs: 0
    });

    await expect(
      fetcher.fetchPage(approvedRequest(), "jiaoyimao")
    ).resolves.toMatchObject({ kind: "ok" });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("uses manual redirects and rejects a 302 without another call", async () => {
    const fetchFn = vi.fn(
      async (_url: string, init?: RequestInit) => {
        expect(init?.redirect).toBe("manual");
        return new Response(null, {
          status: 302,
          headers: {
            location:
              "https://mtop.jiaoyimao.com/h5/adjacent.api/1.0/"
          }
        });
      }
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
      error: "redirect_not_allowed"
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("sanitizes thrown errors that contain signed request secrets", async () => {
    const fetchFn = vi.fn(
      async (url: string, init?: RequestInit) => {
        if (fetchFn.mock.calls.length === 1) {
          return responseWithCookies(
            '{"ret":["FAIL_SYS_TOKEN_EMPTY::令牌为空"]}',
            [
              "_m_h5_tk=secret-token_1700000000000; Path=/",
              "_m_h5_tk_enc=secret-enc; Path=/"
            ]
          );
        }
        const cookie = new Headers(init?.headers).get("cookie");
        throw new Error(
          `request failed url=${url} Cookie=${cookie}`
        );
      }
    );
    const fetcher = new PublicPageFetcher({
      fetchFn,
      minimumIntervalMs: 0
    });

    const result = await fetcher.fetchPage(
      approvedRequest(),
      "jiaoyimao"
    );
    expect(result).toEqual({
      kind: "failed",
      url: ENDPOINT,
      error: "network_error"
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain("secret-enc");
    expect(serialized).not.toContain("sign=");
    expect(serialized).not.toContain("Cookie=");
  });

  it("cancels a declared oversized MTop response body", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      }
    });
    const fetchFn = vi.fn(async () =>
      new Response(body, {
        headers: { "content-length": "6" }
      })
    );
    const fetcher = new PublicPageFetcher({
      fetchFn,
      maximumBytes: 5,
      minimumIntervalMs: 0
    });

    await expect(
      fetcher.fetchPage(approvedRequest(), "jiaoyimao")
    ).resolves.toMatchObject({
      kind: "failed",
      error: "response_too_large"
    });
    expect(cancelled).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("cancels a chunked MTop response as soon as it crosses the cap", async () => {
    const chunks = [
      new TextEncoder().encode("abc"),
      new TextEncoder().encode("def")
    ];
    let index = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const chunk = chunks[index];
          index += 1;
          if (chunk === undefined) {
            controller.close();
          } else {
            controller.enqueue(chunk);
          }
        },
        cancel() {
          cancelled = true;
        }
      },
      { highWaterMark: 0 }
    );
    const fetchFn = vi.fn(async () => new Response(body));
    const fetcher = new PublicPageFetcher({
      fetchFn,
      maximumBytes: 5,
      minimumIntervalMs: 0
    });

    await expect(
      fetcher.fetchPage(approvedRequest(), "jiaoyimao")
    ).resolves.toMatchObject({
      kind: "failed",
      error: "response_too_large"
    });
    expect(cancelled).toBe(true);
    expect(index).toBe(2);
    expect(fetchFn).toHaveBeenCalledTimes(1);
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
