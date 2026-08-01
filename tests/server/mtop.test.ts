// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { PublicPageFetcher } from "../../src/server/collector/fetcher.js";
import {
  APPROVED_JIAOYIMAO_REFERER,
  APPROVED_JIAOYIMAO_SEARCH_CONDITION,
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
const ENTRY_URL = APPROVED_JIAOYIMAO_REFERER;
const USER_AGENT =
  "DeltaAccountScout/0.1 (+local personal comparison tool)";
const SEARCH_CONDITION = JSON.stringify(
  APPROVED_JIAOYIMAO_SEARCH_CONDITION
);
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

function dataForPage(page: number): string {
  return mutateData((outer) => {
    outer.page = String(page);
  });
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
    [
      "unrelated first",
      [
        "cookie2=unrelated-secret; Path=/",
        "_m_h5_tk=token_123; Path=/",
        "_m_h5_tk_enc=encoded; Path=/"
      ]
    ],
    [
      "unrelated between required cookies",
      [
        "_m_h5_tk=token_123; Path=/",
        "login_session=unrelated-secret; Path=/",
        "_m_h5_tk_enc=encoded; Path=/"
      ]
    ],
    [
      "unrelated last",
      [
        "_m_h5_tk_enc=encoded; Path=/",
        "_m_h5_tk=token_123; Path=/",
        "cookie2=unrelated-secret; Path=/"
      ]
    ]
  ])(
    "ignores an %s and returns only the two approved cookies",
    (_name, cookieLines) => {
      const headers = new Headers();
      for (const cookie of cookieLines) {
        headers.append("set-cookie", cookie);
      }

      const session = extractAnonymousMtopSession(headers);
      expect(session).toEqual({
        token: "token",
        cookieHeader: "_m_h5_tk=token_123; _m_h5_tk_enc=encoded"
      });
      expect(JSON.stringify(session)).not.toContain("unrelated-secret");
      expect(JSON.stringify(session)).not.toContain("cookie2");
      expect(JSON.stringify(session)).not.toContain("login_session");
    }
  );

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
    ],
    [
      "duplicate token cookies",
      [
        "_m_h5_tk=first_123; Path=/",
        "_m_h5_tk=second_456; Path=/",
        "_m_h5_tk_enc=encoded; Path=/"
      ]
    ],
    [
      "duplicate encoded cookies",
      [
        "_m_h5_tk=token_123; Path=/",
        "_m_h5_tk_enc=first; Path=/",
        "_m_h5_tk_enc=second; Path=/"
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
    expect(
      isApprovedJiaoyimaoMtopRequest(
        approvedRequest(dataForPage(1))
      )
    ).toBe(true);
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
      "item filter",
      mutateData((outer) => {
        outer.searchCondition = JSON.stringify({
          m7: "棱镜攻势极品S"
        });
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
      "missing required operator-skin filter",
      mutateData((outer) => {
        const search = JSON.parse(
          String(outer.searchCondition)
        ) as Record<string, unknown>;
        delete search.selling_point_7322805066952352771;
        outer.searchCondition = JSON.stringify(search);
      })
    ],
    [
      "only one required operator skin",
      mutateData((outer) => {
        const search = JSON.parse(
          String(outer.searchCondition)
        ) as Record<string, {
          conditionList: string[];
          statConditionList: string[];
        }>;
        const condition =
          search.selling_point_7322805066952352771;
        condition.conditionList = ["骇爪-维什戴尔"];
        condition.statConditionList = ["骇爪-维什戴尔"];
        outer.searchCondition = JSON.stringify(search);
      })
    ],
    [
      "OR-style operator-skin selector",
      mutateData((outer) => {
        const search = JSON.parse(
          String(outer.searchCondition)
        ) as Record<string, Record<string, unknown>>;
        search.selling_point_7322805066952352771.selectType = 2;
        outer.searchCondition = JSON.stringify(search);
      })
    ],
    [
      "array search condition",
      mutateData((outer) => {
        outer.searchCondition = JSON.stringify([]);
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
  it("refuses an approved MTop descriptor outside a Jiaoyimao lifecycle source", async () => {
    const fetchFn = vi.fn();
    const fetcher = new PublicPageFetcher({
      fetchFn,
      minimumIntervalMs: 0
    });
    fetcher.beginSource("jiaoyimao");

    await expect(
      fetcher.fetchPage(approvedRequest(), "panzhi")
    ).resolves.toEqual({
      kind: "failed",
      url: ENDPOINT,
      error: "unapproved_mtop_request"
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("refuses to bootstrap page 3 before page 2 initializes the session", async () => {
    const fetchFn = vi.fn();
    const fetcher = new PublicPageFetcher({
      fetchFn,
      minimumIntervalMs: 0
    });
    fetcher.beginSource("jiaoyimao");

    await expect(
      fetcher.fetchPage(
        approvedRequest(dataForPage(3)),
        "jiaoyimao"
      )
    ).resolves.toEqual({
      kind: "failed",
      url: ENDPOINT,
      error: "unapproved_mtop_request"
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns the signed native-filtered page one used to prime the session", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (calls.length === 1) {
        return responseWithCookies(
          '{"ret":["FAIL_SYS_TOKEN_EMPTY::令牌为空"]}',
          [
            "_m_h5_tk=page-one-token_1; Path=/",
            "_m_h5_tk_enc=page-one-enc; Path=/"
          ]
        );
      }
      return new Response(SUCCESS_BODY, { status: 200 });
    });
    const fetcher = new PublicPageFetcher({
      fetchFn,
      now: () => 1_700_000_000_000,
      minimumIntervalMs: 0
    });
    fetcher.beginSource("jiaoyimao");

    await expect(
      fetcher.fetchPage(
        approvedRequest(dataForPage(1)),
        "jiaoyimao"
      )
    ).resolves.toEqual({
      kind: "ok",
      url: ENDPOINT,
      status: 200,
      html: SUCCESS_BODY
    });

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(
      calls.map(({ init }) =>
        new URLSearchParams(String(init?.body)).get("data")
      )
    ).toEqual([dataForPage(1), dataForPage(1)]);
  });

  it("bootstraps page 2 with a page-1 handshake and signed prime", async () => {
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
            "_m_h5_tk_enc=anonymous-enc; Path=/; Secure",
            "login_session=must-not-leak; Path=/; HttpOnly"
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
    fetcher.beginSource("jiaoyimao");

    await expect(
      fetcher.fetchPage(approvedRequest(), "jiaoyimao")
    ).resolves.toEqual({
      kind: "ok",
      url: ENDPOINT,
      status: 200,
      html: SUCCESS_BODY
    });
    expect(fetchFn).toHaveBeenCalledTimes(3);

    const firstUrl = new URL(calls[0]!.url);
    const secondUrl = new URL(calls[1]!.url);
    const thirdUrl = new URL(calls[2]!.url);
    const pageOneData = dataForPage(1);
    expect(`${firstUrl.origin}${firstUrl.pathname}`).toBe(ENDPOINT);
    expect(firstUrl.searchParams.get("t")).toBe("1700000000000");
    expect(firstUrl.searchParams.get("sign")).toBe(
      signMtop("", 1_700_000_000_000, APP_KEY, pageOneData)
    );
    expect(secondUrl.searchParams.get("t")).toBe("1700000000001");
    expect(secondUrl.searchParams.get("sign")).toBe(
      signMtop(
        "anonymous-token",
        1_700_000_000_001,
        APP_KEY,
        pageOneData
      )
    );
    expect(thirdUrl.searchParams.get("sign")).toBe(
      signMtop(
        "anonymous-token",
        1_700_000_000_001,
        APP_KEY,
        DATA
      )
    );

    const encodedPageOne = new URLSearchParams({
      data: pageOneData
    }).toString();
    const encodedPageTwo = new URLSearchParams({ data: DATA }).toString();
    expect(calls[0]!.init?.body).toBe(encodedPageOne);
    expect(calls[1]!.init?.body).toBe(encodedPageOne);
    expect(calls[2]!.init?.body).toBe(encodedPageTwo);

    const firstHeaders = new Headers(calls[0]!.init?.headers);
    const secondHeaders = new Headers(calls[1]!.init?.headers);
    const thirdHeaders = new Headers(calls[2]!.init?.headers);
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
    expect(thirdHeaders.get("cookie")).toBe(
      "_m_h5_tk=anonymous-token_1700000000000; _m_h5_tk_enc=anonymous-enc"
    );
    expect(secondHeaders.get("cookie")).not.toContain("must-not-leak");
    expect(thirdHeaders.get("cookie")).not.toContain("must-not-leak");
    expect([
      firstHeaders.get("jym-meta-h5"),
      secondHeaders.get("jym-meta-h5"),
      thirdHeaders.get("jym-meta-h5")
    ]).toEqual([
      firstHeaders.get("jym-meta-h5"),
      firstHeaders.get("jym-meta-h5"),
      firstHeaders.get("jym-meta-h5")
    ]);
  });

  it("reuses the primed session and metadata for page 3", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const headers = new Headers(init?.headers);
      if (!headers.has("cookie")) {
        return responseWithCookies(
          '{"ret":["FAIL_SYS_TOKEN_EMPTY::令牌为空"]}',
          [
            "_m_h5_tk=reused-token_1; Path=/",
            "_m_h5_tk_enc=reused-enc; Path=/"
          ]
        );
      }
      return new Response(SUCCESS_BODY);
    });
    const fetcher = new PublicPageFetcher({
      fetchFn,
      now: () => 1_700_000_000_000,
      random: () => 0.25,
      minimumIntervalMs: 0
    });
    fetcher.beginSource("jiaoyimao");

    await expect(
      fetcher.fetchPage(approvedRequest(), "jiaoyimao")
    ).resolves.toMatchObject({ kind: "ok" });
    await expect(
      fetcher.fetchPage(
        approvedRequest(dataForPage(3)),
        "jiaoyimao"
      )
    ).resolves.toMatchObject({ kind: "ok" });

    expect(fetchFn).toHaveBeenCalledTimes(4);
    expect(
      new URLSearchParams(String(calls[3]!.init?.body)).get("data")
    ).toBe(dataForPage(3));
    const firstMeta = new Headers(calls[0]!.init?.headers).get(
      "jym-meta-h5"
    );
    expect(
      calls.map(({ init }) =>
        new Headers(init?.headers).get("jym-meta-h5")
      )
    ).toEqual([firstMeta, firstMeta, firstMeta, firstMeta]);
    expect(new Headers(calls[3]!.init?.headers).get("cookie")).toBe(
      "_m_h5_tk=reused-token_1; _m_h5_tk_enc=reused-enc"
    );
  });

  it("bootstraps again after a later page returns an invalid response", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (calls.length === 4) {
        return new Response("not json");
      }
      const headers = new Headers(init?.headers);
      if (!headers.has("cookie")) {
        return responseWithCookies(
          '{"ret":["FAIL_SYS_TOKEN_EMPTY::令牌为空"]}',
          [
            `_m_h5_tk=token-${calls.length}_1; Path=/`,
            `_m_h5_tk_enc=enc-${calls.length}; Path=/`
          ]
        );
      }
      return new Response(SUCCESS_BODY);
    });
    const fetcher = new PublicPageFetcher({
      fetchFn,
      now: () => 1_700_000_000_000,
      random: () => 0.25,
      minimumIntervalMs: 0
    });
    fetcher.beginSource("jiaoyimao");

    await expect(
      fetcher.fetchPage(approvedRequest(), "jiaoyimao")
    ).resolves.toMatchObject({ kind: "ok" });
    await expect(
      fetcher.fetchPage(
        approvedRequest(dataForPage(3)),
        "jiaoyimao"
      )
    ).resolves.toEqual({
      kind: "failed",
      url: ENDPOINT,
      error: "invalid_mtop_response"
    });
    await expect(
      fetcher.fetchPage(approvedRequest(), "jiaoyimao")
    ).resolves.toMatchObject({ kind: "ok" });

    expect(fetchFn).toHaveBeenCalledTimes(7);
    expect(new Headers(calls[4]!.init?.headers).has("cookie")).toBe(false);
    expect(
      new URLSearchParams(String(calls[4]!.init?.body)).get("data")
    ).toBe(dataForPage(1));
  });

  it("clears the session at source end and bootstraps the next lifecycle", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const headers = new Headers(init?.headers);
      if (!headers.has("cookie")) {
        const lifecycle = calls.filter(
          ({ init: callInit }) =>
            !new Headers(callInit?.headers).has("cookie")
        ).length;
        return responseWithCookies(
          '{"ret":["FAIL_SYS_TOKEN_EMPTY::令牌为空"]}',
          [
            `_m_h5_tk=token-${lifecycle}_1; Path=/`,
            `_m_h5_tk_enc=enc-${lifecycle}; Path=/`
          ]
        );
      }
      return new Response(SUCCESS_BODY);
    });
    const random = vi
      .fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.5);
    const fetcher = new PublicPageFetcher({
      fetchFn,
      now: () => 1_700_000_000_000,
      random,
      minimumIntervalMs: 0
    });

    fetcher.beginSource("jiaoyimao");
    await expect(
      fetcher.fetchPage(approvedRequest(), "jiaoyimao")
    ).resolves.toMatchObject({ kind: "ok" });
    fetcher.endSource("jiaoyimao");
    fetcher.beginSource("jiaoyimao");
    await expect(
      fetcher.fetchPage(approvedRequest(), "jiaoyimao")
    ).resolves.toMatchObject({ kind: "ok" });

    expect(fetchFn).toHaveBeenCalledTimes(6);
    expect(new Headers(calls[0]!.init?.headers).has("cookie")).toBe(false);
    expect(new Headers(calls[3]!.init?.headers).has("cookie")).toBe(false);
    const firstMeta = new Headers(calls[0]!.init?.headers).get(
      "jym-meta-h5"
    );
    const secondMeta = new Headers(calls[3]!.init?.headers).get(
      "jym-meta-h5"
    );
    expect(firstMeta).not.toBe(secondMeta);
    expect(
      calls.slice(0, 3).every(
        ({ init }) =>
          new Headers(init?.headers).get("jym-meta-h5") === firstMeta
      )
    ).toBe(true);
    expect(
      calls.slice(3).every(
        ({ init }) =>
          new Headers(init?.headers).get("jym-meta-h5") === secondMeta
      )
    ).toBe(true);
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
      if (calls.length === 4) {
        return responseWithCookies(
          '{"ret":["FAIL_SYS_TOKEN_EXPIRED::令牌过期"]}',
          [
            "_m_h5_tk=replacement-token_2; Path=/",
            "_m_h5_tk_enc=replacement-enc; Path=/",
            "login_session=must-not-rotate; Path=/"
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
    fetcher.beginSource("jiaoyimao");

    await expect(
      fetcher.fetchPage(approvedRequest(), "jiaoyimao")
    ).resolves.toMatchObject({ kind: "ok" });
    await expect(
      fetcher.fetchPage(
        approvedRequest(dataForPage(3)),
        "jiaoyimao"
      )
    ).resolves.toMatchObject({ kind: "ok" });
    expect(fetchFn).toHaveBeenCalledTimes(5);
    expect(new Headers(calls[3]!.init?.headers).get("cookie")).toBe(
      "_m_h5_tk=first-token_1; _m_h5_tk_enc=first-enc"
    );
    expect(new Headers(calls[4]!.init?.headers).get("cookie")).toBe(
      "_m_h5_tk=replacement-token_2; _m_h5_tk_enc=replacement-enc"
    );
    expect(new Headers(calls[4]!.init?.headers).get("cookie"))
      .not.toContain("must-not-rotate");
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
        new Response(SUCCESS_BODY)
      )
      .mockResolvedValueOnce(
        new Response(SUCCESS_BODY)
      )
      .mockResolvedValueOnce(
        new Response('{"ret":["FAIL_SYS_TOKEN_EXPIRED::令牌过期"]}')
      );
    const fetcher = new PublicPageFetcher({
      fetchFn,
      minimumIntervalMs: 0
    });
    fetcher.beginSource("jiaoyimao");

    await expect(
      fetcher.fetchPage(approvedRequest(), "jiaoyimao")
    ).resolves.toMatchObject({ kind: "ok" });
    await expect(
      fetcher.fetchPage(
        approvedRequest(dataForPage(3)),
        "jiaoyimao"
      )
    ).resolves.toEqual({
      kind: "failed",
      url: ENDPOINT,
      error: "mtop_token_expired_without_replacement"
    });
    expect(fetchFn).toHaveBeenCalledTimes(4);
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

  it.each([
    [
      "an invalid prime response",
      () => new Response('{"ret":["SUCCESS::调用成功"],"data":{}}'),
      "invalid_mtop_response"
    ],
    [
      "a prime redirect",
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://example.test/not-allowed" }
        }),
      "redirect_not_allowed"
    ],
    [
      "a prime token error",
      () =>
        responseWithCookies(
          '{"ret":["FAIL_SYS_TOKEN_EXPIRED::令牌过期"]}',
          [
            "_m_h5_tk=secret-replacement_2; Path=/",
            "_m_h5_tk_enc=secret-replacement-enc; Path=/"
          ]
        ),
      "mtop_request_failed"
    ]
  ])(
    "fails closed after %s without sending page 2",
    async (_name, primeResponse, expectedError) => {
      const calls: Array<{ url: string; init?: RequestInit }> = [];
      const fetchFn = vi.fn(
        async (url: string, init?: RequestInit) => {
          calls.push({ url, init });
          if (calls.length === 1) {
            return responseWithCookies(
              '{"ret":["FAIL_SYS_TOKEN_EMPTY::令牌为空"]}',
              [
                "_m_h5_tk=secret-token_1; Path=/",
                "_m_h5_tk_enc=secret-enc; Path=/"
              ]
            );
          }
          return primeResponse();
        }
      );
      const fetcher = new PublicPageFetcher({
        fetchFn,
        minimumIntervalMs: 0
      });
      fetcher.beginSource("jiaoyimao");

      const result = await fetcher.fetchPage(
        approvedRequest(),
        "jiaoyimao"
      );

      expect(result).toEqual({
        kind: "failed",
        url: ENDPOINT,
        error: expectedError
      });
      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(
        calls.map(({ init }) =>
          new URLSearchParams(String(init?.body)).get("data")
        )
      ).toEqual([dataForPage(1), dataForPage(1)]);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("secret-token");
      expect(serialized).not.toContain("secret-enc");
      expect(serialized).not.toContain("secret-replacement");
    }
  );

  it("does not retry a failed bootstrap request", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("socket reset with secret-token");
    });
    const fetcher = new PublicPageFetcher({
      fetchFn,
      minimumIntervalMs: 0
    });
    fetcher.beginSource("jiaoyimao");

    await expect(
      fetcher.fetchPage(approvedRequest(), "jiaoyimao")
    ).resolves.toEqual({
      kind: "failed",
      url: ENDPOINT,
      error: "network_error"
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("does not exceed three bootstrap calls when requested page token expires", async () => {
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
      .mockResolvedValueOnce(new Response(SUCCESS_BODY))
      .mockResolvedValueOnce(
        responseWithCookies(
          '{"ret":["FAIL_SYS_TOKEN_EXPIRED::令牌过期"]}',
          [
            "_m_h5_tk=replacement-token_2; Path=/",
            "_m_h5_tk_enc=replacement-enc; Path=/"
          ]
        )
      )
      .mockResolvedValueOnce(new Response(SUCCESS_BODY));
    const fetcher = new PublicPageFetcher({
      fetchFn,
      minimumIntervalMs: 0
    });
    fetcher.beginSource("jiaoyimao");

    await expect(
      fetcher.fetchPage(approvedRequest(), "jiaoyimao")
    ).resolves.toEqual({
      kind: "failed",
      url: ENDPOINT,
      error: "mtop_request_failed"
    });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("never exceeds the later-page budget when replacement fails", async () => {
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
      if (calls === 4) {
        return responseWithCookies(
          '{"ret":["FAIL_SYS_TOKEN_EXPIRED::令牌过期"]}',
          [
            "_m_h5_tk=replacement-token_2; Path=/",
            "_m_h5_tk_enc=replacement-enc; Path=/"
          ]
        );
      }
      if (calls === 5) throw new Error("socket reset");
      return new Response(SUCCESS_BODY);
    });
    const fetcher = new PublicPageFetcher({
      fetchFn,
      minimumIntervalMs: 0
    });
    fetcher.beginSource("jiaoyimao");

    await expect(
      fetcher.fetchPage(approvedRequest(), "jiaoyimao")
    ).resolves.toMatchObject({ kind: "ok" });
    await expect(
      fetcher.fetchPage(
        approvedRequest(dataForPage(3)),
        "jiaoyimao"
      )
    ).resolves.toEqual({
      kind: "failed",
      url: ENDPOINT,
      error: "network_error"
    });
    expect(fetchFn).toHaveBeenCalledTimes(5);
  });

  it("uses one transient retry when the three-call budget allows it", async () => {
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
      .mockResolvedValueOnce(new Response(SUCCESS_BODY))
      .mockResolvedValueOnce(new Response(SUCCESS_BODY))
      .mockRejectedValueOnce(new Error("socket reset"))
      .mockResolvedValueOnce(new Response(SUCCESS_BODY));
    const fetcher = new PublicPageFetcher({
      fetchFn,
      minimumIntervalMs: 0
    });
    fetcher.beginSource("jiaoyimao");

    await expect(
      fetcher.fetchPage(approvedRequest(), "jiaoyimao")
    ).resolves.toMatchObject({ kind: "ok" });
    await expect(
      fetcher.fetchPage(
        approvedRequest(dataForPage(3)),
        "jiaoyimao"
      )
    ).resolves.toMatchObject({ kind: "ok" });
    expect(fetchFn).toHaveBeenCalledTimes(5);
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
