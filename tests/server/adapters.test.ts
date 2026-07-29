// @vitest-environment node
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { jiaoyimaoAdapter } from "../../src/server/collector/adapters/jiaoyimao.js";
import { panzhiAdapter } from "../../src/server/collector/adapters/panzhi.js";
import { pxb7Adapter } from "../../src/server/collector/adapters/pxb7.js";
import {
  APPROVED_JIAOYIMAO_MTOP_ENDPOINT,
  isApprovedJiaoyimaoMtopRequest
} from "../../src/server/collector/mtop.js";

async function fixture(name: string): Promise<string> {
  return readFile(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
}

describe("pagination progress policy", () => {
  it("enables strict progress only for Jiaoyimao", () => {
    expect(jiaoyimaoAdapter.strictPaginationProgress).toBe(true);
    expect(panzhiAdapter.strictPaginationProgress).toBeUndefined();
    expect(pxb7Adapter.strictPaginationProgress).toBeUndefined();
  });
});

describe("panzhi adapter", () => {
  it("discovers the visible Delta Force catalog link", async () => {
    const result = panzhiAdapter.discoverCatalog(
      await fixture("panzhi-home.html"),
      "三角洲行动"
    );
    expect(result).toEqual({
      kind: "ok",
      request: { url: "https://www.pzds.com/goodsList/391/6" }
    });
  });

  it("parses Panzhi product summaries", async () => {
    const html = await fixture("panzhi-list.html");
    const result = panzhiAdapter.parseList(html);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("expected parsed list");
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      source: "panzhi",
      sourceListingId: "SA2PEAK",
      url: "https://www.pzds.com/goodsDetails/SA2PEAK/6",
      priceCny: 5288
    });
  });

  it("keeps only canonical relative and absolute Panzhi detail URLs", () => {
    const result = panzhiAdapter.parseList(`
      <main class="goods-list-with-game">
        <a href="/goodsDetails/RELATIVE_1/6?from=商品列表">
          <p>合法相对链接</p><strong>¥ 100</strong>
        </a>
        <a href="https://www.pzds.com/goodsDetails/ABSOLUTE-2/6">
          <p>合法绝对链接</p><strong>¥ 200</strong>
        </a>
        <a href="https://evil.example/goodsDetails/EVIL/6">
          <p>跨域链接</p><strong>¥ 300</strong>
        </a>
      </main>
    `);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("expected parsed list");
    expect(
      result.items.map(({ sourceListingId, url }) => ({
        sourceListingId,
        url
      }))
    ).toEqual([
      {
        sourceListingId: "RELATIVE_1",
        url: "https://www.pzds.com/goodsDetails/RELATIVE_1/6"
      },
      {
        sourceListingId: "ABSOLUTE-2",
        url: "https://www.pzds.com/goodsDetails/ABSOLUTE-2/6"
      }
    ]);
    expect(result.items.map((item) => panzhiAdapter.detailRequest(item)))
      .toEqual(result.items.map(({ url }) => ({ url })));
  });

  it.each([
    ["external host", "https://evil.example/goodsDetails/EVIL/6"],
    ["empty ID", "/goodsDetails//6"],
    [
      "userinfo",
      "https://user:pass@www.pzds.com/goodsDetails/USERINFO/6"
    ],
    ["non-default port", "https://www.pzds.com:444/goodsDetails/PORT/6"],
    ["explicit default port", "https://www.pzds.com:443/goodsDetails/PORT/6"],
    ["hash", "/goodsDetails/HASH/6#fragment"],
    ["extra path", "/goodsDetails/EXTRA/6/more"]
  ])("blocks a catalog containing only an invalid %s detail URL", (_label, href) => {
    const result = panzhiAdapter.parseList(`
      <main class="goods-list-with-game">
        <a href="${href}">
          <p>无效商品</p><strong>¥ 100</strong>
        </a>
      </main>
    `);

    expect(result).toEqual({
      kind: "blocked",
      reason: "structure_changed"
    });
  });

  it("increments deterministic Panzhi result URLs without changing filters", async () => {
    const html = await fixture("panzhi-list-page-2.html");
    expect(
      panzhiAdapter.nextPage(html, {
        url: "https://www.pzds.com/goodsList/391/6"
      })
    ).toEqual({
      url: "https://www.pzds.com/goodsList/391/6?page=2"
    });
    expect(
      panzhiAdapter.nextPage(html, {
        url:
          "https://www.pzds.com/goodsList/391/6?page=2&sort=price&keyword=M7&game=391"
      })
    ).toEqual({
      url:
        "https://www.pzds.com/goodsList/391/6?page=3&sort=price&keyword=M7&game=391"
    });
  });

  it.each([
    "https://example.com/goodsList/391/6?page=2",
    "https://www.pzds.com/goodsList/391/7?page=2",
    "https://user:pass@www.pzds.com/goodsList/391/6?page=2",
    "https://www.pzds.com:444/goodsList/391/6?page=2",
    "https://www.pzds.com/goodsList/391/6?page=",
    "https://www.pzds.com/goodsList/391/6?page=next",
    "https://www.pzds.com/goodsList/391/6?page=0",
    "https://www.pzds.com/goodsList/391/6?page=-1",
    "https://www.pzds.com/goodsList/391/6?page=1.5"
  ])("rejects an invalid Panzhi result URL: %s", async (url) => {
    expect(
      panzhiAdapter.nextPage(await fixture("panzhi-list.html"), { url })
    ).toBeNull();
  });

  it("blocks a Panzhi login wall before applying the empty marker", () => {
    const html = `
      <main class="goods-list-with-game">
        <form action="/login">
          <input type="password" name="password">
          <button>登录</button>
        </form>
      </main>
    `;

    expect(panzhiAdapter.parseList(html)).toEqual({
      kind: "blocked",
      reason: "structure_changed"
    });
    expect(
      panzhiAdapter.nextPage(html, {
        url: "https://www.pzds.com/goodsList/391/6?page=2"
      })
    ).toBeNull();
  });

  it("does not mistake incidental login text for a Panzhi login wall", () => {
    expect(
      panzhiAdapter.parseList(`
        <main class="goods-list-with-game">
          <p>当前没有商品，登录后可同步筛选条件</p>
        </main>
      `)
    ).toEqual({
      kind: "ok",
      items: []
    });
  });

  it("treats only a verified empty Panzhi catalog as a natural end", () => {
    const html = `
      <main class="goods-list-with-game">
        <p>暂时没有符合条件的商品</p>
      </main>
    `;

    expect(panzhiAdapter.parseList(html)).toEqual({
      kind: "ok",
      items: []
    });
    expect(
      panzhiAdapter.nextPage(html, {
        url: "https://www.pzds.com/goodsList/391/6?page=3"
      })
    ).toBeNull();
  });

  it("blocks a Panzhi catalog whose product links cannot be parsed", () => {
    const html = `
      <main class="goods-list-with-game">
        <a href="/goodsDetails/BROKEN/6"></a>
      </main>
    `;

    expect(panzhiAdapter.parseList(html)).toEqual({
      kind: "blocked",
      reason: "structure_changed"
    });
  });

  it.each([
    [
      "arbitrary HTML",
      "<html><body><article>平台公告</article></body></html>",
      "structure_changed"
    ],
    [
      "a login page",
      "<html><body><form action='/login'><input name='password'></form></body></html>",
      "structure_changed"
    ],
    [
      "a captcha page",
      "<html><body><div>请完成安全验证</div></body></html>",
      "captcha_required"
    ]
  ])("blocks %s instead of treating it as an empty catalog", (_label, html, reason) => {
    expect(panzhiAdapter.parseList(html)).toEqual({
      kind: "blocked",
      reason
    });
  });

  it("parses detail evidence and account safety fields", async () => {
    const summary = {
      source: "panzhi" as const,
      sourceListingId: "SA2PEAK",
      url: "https://www.pzds.com/goodsDetails/SA2PEAK/6",
      title: "SA2PEAK",
      rawText: "M7棱镜攻势(极品A)",
      priceCny: 5288
    };
    const result = panzhiAdapter.parseDetail(
      await fixture("panzhi-detail.html"),
      summary
    );
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("expected parsed detail");
    expect(result.detail).toMatchObject({
      loginPlatform: "qq",
      service: "official",
      totalAssetsM: 268,
      hafCoins: 28_880_000,
      realNameStatus: "second_available",
      secondRealNameAvailable: true,
      recoveryCoverage: true
    });
    expect(result.detail.evidence.map(({ text }) => text)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("M7战斗步枪-棱镜攻势S2(极品A"),
        expect.stringContaining("威龙 红皮"),
        expect.stringContaining("巨浪(极品)")
      ])
    );
  });

  it("does not add positive safety evidence from a negated phrase", () => {
    const summary = {
      source: "panzhi" as const,
      sourceListingId: "NEGATED",
      url: "https://www.pzds.com/goodsDetails/NEGATED/6",
      title: "NEGATED",
      rawText: "M7棱镜攻势(优品B)",
      priceCny: 1197
    };
    const result = panzhiAdapter.parseDetail(
      `
        <body>
          <div class="description">
            <p>【传说典藏】M7棱镜攻势(优品B)</p>
          </div>
          <span>三角洲行动-QQ</span>
          <span>不可二次实名</span>
          <span>不支持人脸包赔</span>
        </body>
      `,
      summary
    );
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("expected parsed detail");
    expect(result.detail.evidence.map(({ text }) => text)).not.toContain(
      "可二次实名"
    );
    expect(result.detail.evidence.map(({ text }) => text)).not.toContain(
      "支持人脸包赔"
    );
  });

  it("ignores embedded application scripts when collecting evidence", () => {
    const summary = {
      source: "panzhi" as const,
      sourceListingId: "SCRIPT",
      url: "https://www.pzds.com/goodsDetails/SCRIPT/6",
      title: "SCRIPT",
      rawText: "M7棱镜(优品B)",
      priceCny: 1458
    };
    const result = panzhiAdapter.parseDetail(
      `
        <body>
          <p>【传说典藏】M7战斗步枪-棱镜攻势S2(优品B/其他)</p>
          <span>三角洲行动-QQ</span>
          <script>window.__NUXT__ = "K416(极品C)\\u002FM7棱镜(优品B)"</script>
        </body>
      `,
      summary
    );
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("expected parsed detail");
    expect(
      result.detail.evidence.some(({ text }) => text.includes("__NUXT__"))
    ).toBe(false);
  });
});

describe("jiaoyimao adapter", () => {
  it("does not bypass Jiaoyimao captcha", async () => {
    const result = jiaoyimaoAdapter.discoverCatalog(
      await fixture("jiaoyimao-home.html"),
      "三角洲行动"
    );
    expect(result).toEqual({
      kind: "blocked",
      reason: "captcha_required"
    });
  });

  it("uses the broad S/A/B/C catalog without a second-real-name filter", () => {
    const entry = new URL(jiaoyimaoAdapter.entryUrl);
    const search = JSON.parse(
      entry.searchParams.get("searchCondition") ?? ""
    ) as Record<string, unknown>;
    expect(search).not.toHaveProperty("is_second_real_name");
    expect(search).toEqual({
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
  });

  it("recognizes the verified broad catalog and parses its SSR cards", async () => {
    const html = await fixture("jiaoyimao-list.html");
    const discovery = jiaoyimaoAdapter.discoverCatalog(
      html,
      "三角洲行动"
    );
    expect(discovery).toEqual({
      kind: "ok",
      request: { url: jiaoyimaoAdapter.entryUrl }
    });

    const result = jiaoyimaoAdapter.parseList(html);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("expected parsed list");
    expect(result.items).toHaveLength(3);
    expect(result.items[0]).toMatchObject({
      source: "jiaoyimao",
      sourceListingId: "1784435272636913",
      url:
        "https://www.jiaoyimao.com/jg2007840/1784435272636913.html?isGray=true",
      title:
        "总资产91.9M 7干员外观 2近战 26传说枪械 烽火：钻石 战场：无军衔",
      priceCny: 3600
    });
    expect(result.items[0].rawText).toContain(
      "M7棱镜攻势(极品S)"
    );
    expect(result.items[1].rawText).not.toContain("M7棱镜攻势");
    expect(result.items[2].rawText).toContain(
      "M7棱镜攻势(极品A)"
    );
  });

  it("continues from SSR page one with the approved MTop page-two request", async () => {
    const html = await fixture("jiaoyimao-list.html");
    const next = jiaoyimaoAdapter.nextPage(html, {
      url: jiaoyimaoAdapter.entryUrl
    });

    expect(next).not.toBeNull();
    expect(next?.url).toBe(APPROVED_JIAOYIMAO_MTOP_ENDPOINT);
    expect(next?.options).toMatchObject({
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      origin: "https://www.jiaoyimao.com",
      referer: jiaoyimaoAdapter.entryUrl,
      anonymousMtop: {
        api: "mtop.com.jym.layout.pc.goodslist.getunifiedgoodslist",
        version: "1.0",
        appKey: "12574478"
      }
    });
    expect(isApprovedJiaoyimaoMtopRequest(next!)).toBe(true);
    expect(JSON.parse(next?.options?.body ?? "")).toMatchObject({
      page: "2",
      pageSize: 16,
      categoryId: 8845004,
      parentId: 8845003
    });
  });

  it("maps MTop products, ignores decorations, and advances only the page", async () => {
    const page = await fixture("jiaoyimao-list-page-2.json");
    const parsed = jiaoyimaoAdapter.parseList(page);
    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") throw new Error("expected MTop list");
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]).toMatchObject({
      source: "jiaoyimao",
      sourceListingId: "1784550994519222",
      url:
        "https://www.jiaoyimao.com/jg2007840/1784550994519222.html?isGray=true",
      title: "总资产33.3M 6干员外观",
      priceCny: 2000
    });
    expect(parsed.items[0].rawText).toContain("QQ双端");
    expect(parsed.items[0].rawText).toContain("安卓QQ");
    expect(parsed.items[0].rawText).toContain("威龙-凌霄戍卫");
    expect(parsed.items[0].rawText).toContain("不可二次实名");
    expect(parsed.items[0].rawText).toContain("赠永久包赔");
    expect(parsed.items[0]).toMatchObject({
      detailFetchHint: "m7_prism_query"
    });
    expect(parsed.items[0].rawText).not.toContain(
      "M7战斗步枪-棱镜攻势S2(极品)"
    );
    expect(jiaoyimaoAdapter.detailRequest(parsed.items[0])).toEqual({
      url: parsed.items[0].url
    });

    const pageTwo = jiaoyimaoAdapter.nextPage(
      await fixture("jiaoyimao-list.html"),
      { url: jiaoyimaoAdapter.entryUrl }
    );
    if (!pageTwo?.options?.body) {
      throw new Error("expected page-two MTop request");
    }
    const pageThree = jiaoyimaoAdapter.nextPage(page, pageTwo);
    expect(pageThree).not.toBeNull();
    expect(isApprovedJiaoyimaoMtopRequest(pageThree!)).toBe(true);
    const pageTwoBody = JSON.parse(pageTwo.options.body) as Record<
      string,
      unknown
    >;
    const pageThreeBody = JSON.parse(
      pageThree?.options?.body ?? ""
    ) as Record<string, unknown>;
    expect(pageThreeBody).toEqual({ ...pageTwoBody, page: "3" });
  });

  it.each([
    ["non-numeric goodsId", "goodsId", "invalid-id"],
    ["invalid price", "price", "free"],
    ["negative price", "price", "-1"],
    ["non-finite price", "price", "Infinity"],
    ["empty title", "title", "   "],
    [
      "external detail URL",
      "detailUrlSeo",
      "https://example.com/jg2007840/1784550994519222.html"
    ],
    [
      "goodsId/path mismatch",
      "detailUrlSeo",
      "https://www.jiaoyimao.com/jg2007840/1784550994519999.html"
    ]
  ] as const)(
    "ignores a product with %s while retaining its valid sibling",
    async (_label, field, value) => {
      const response = JSON.parse(
        await fixture("jiaoyimao-list-page-2.json")
      ) as {
        data: {
          result: {
            deliverComps: Array<{
              type: string;
              subType: string;
              data: Record<string, unknown>;
            }>;
          };
        };
      };
      const product = response.data.result.deliverComps.find(
        ({ type }) => type === "8"
      );
      if (!product) throw new Error("expected fixture product");
      const validSibling = structuredClone(product);
      validSibling.data.goodsId = "1784550994519244";
      validSibling.data.detailUrlSeo =
        "https://www.jiaoyimao.com/jg2007840/1784550994519244.html?isGray=true";
      product.data[field] = value;
      response.data.result.deliverComps.push(validSibling);

      const parsed = jiaoyimaoAdapter.parseList(
        JSON.stringify(response)
      );
      expect(parsed.kind).toBe("ok");
      if (parsed.kind !== "ok") throw new Error("expected MTop list");
      expect(parsed.items.map(({ sourceListingId }) => sourceListingId))
        .toEqual(["1784550994519244"]);
    }
  );

  it("accepts a valid envelope containing only decorations and invalid products", async () => {
    const response = JSON.parse(
      await fixture("jiaoyimao-list-page-2.json")
    ) as {
      data: {
        result: {
          deliverComps: Array<{
            type: string;
            data: Record<string, unknown>;
          }>;
        };
      };
    };
    const product = response.data.result.deliverComps.find(
      ({ type }) => type === "8"
    );
    if (!product) throw new Error("expected fixture product");
    product.data.goodsId = "invalid-id";

    expect(
      jiaoyimaoAdapter.parseList(JSON.stringify(response))
    ).toEqual({ kind: "ok", items: [] });
  });

  it("validates MTop JSON before applying HTML block-page detection", async () => {
    const page = (await fixture("jiaoyimao-list-page-2.json")).replace(
      "赠永久包赔",
      "安全验证服务"
    );
    const parsed = jiaoyimaoAdapter.parseList(page);
    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") throw new Error("expected MTop list");
    expect(parsed.items[0].rawText).toContain("安全验证服务");
  });

  it("stops at the MTop natural last page", async () => {
    const page = await fixture("jiaoyimao-list-page-last.json");
    const parsed = jiaoyimaoAdapter.parseList(page);
    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") throw new Error("expected MTop list");
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].sourceListingId).toBe("1784550994519333");

    const pageTwo = jiaoyimaoAdapter.nextPage(
      await fixture("jiaoyimao-list.html"),
      { url: jiaoyimaoAdapter.entryUrl }
    );
    const pageThree = jiaoyimaoAdapter.nextPage(
      await fixture("jiaoyimao-list-page-2.json"),
      pageTwo!
    );
    expect(jiaoyimaoAdapter.nextPage(page, pageThree!)).toBeNull();
  });

  it.each([
    ["invalid JSON", "{"],
    [
      "failed ret",
      JSON.stringify({
        ret: ["FAIL_SYS_TOKEN_EXPIRED::令牌过期"],
        data: { result: { hasNextPage: false, deliverComps: [] } }
      })
    ],
    [
      "missing deliverComps",
      JSON.stringify({
        ret: ["SUCCESS::调用成功"],
        data: { result: { hasNextPage: false } }
      })
    ],
    [
      "invalid hasNextPage",
      JSON.stringify({
        ret: ["SUCCESS::调用成功"],
        data: { result: { hasNextPage: "yes", deliverComps: [] } }
      })
    ]
  ])("blocks malformed MTop payload: %s", (_label, content) => {
    expect(jiaoyimaoAdapter.parseList(content)).toEqual({
      kind: "blocked",
      reason: "structure_changed"
    });
  });

  it.each(["B", "C"])(
    "normalizes SSR M7 peak quality %s into detail-fetch evidence",
    (quality) => {
      const url =
        `https://www.jiaoyimao.com/jg2007840/${quality}123.html`;
      const result = jiaoyimaoAdapter.parseList(`
        <a
          class="pcGoodsListItem"
          href="${url}"
          data-goodsid="${quality}123"
          data-price="5888"
        >
          <span data-goods-name="M7 account ${quality}"></span>
          M7-极品${quality} 安卓QQ
        </a>
      `);
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") throw new Error("expected SSR list");
      expect(result.items[0].rawText).toContain(
        `M7棱镜攻势(极品${quality})`
      );
      expect(result.items[0].rawText).toMatch(/M7.*棱镜/);
      expect(jiaoyimaoAdapter.detailRequest(result.items[0])).toEqual({
        url
      });
    }
  );

  it("parses only the current product detail and safety report", async () => {
    const summary = {
      source: "jiaoyimao" as const,
      sourceListingId: "1784435272636913",
      url: "https://www.jiaoyimao.com/jg2007840/1784435272636913.html",
      title:
        "总资产91.9M 7干员外观 2近战 26传说枪械 烽火：钻石",
      rawText:
        "乌鲁鲁-狂怒 骇爪-维什戴尔 红狼-蚀金玫瑰 M7棱镜攻势(极品S) QQ双端帐号",
      priceCny: 3600
    };
    const result = jiaoyimaoAdapter.parseDetail(
      await fixture("jiaoyimao-detail.html"),
      summary
    );
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("expected parsed detail");
    expect(result.detail).toMatchObject({
      loginPlatform: "qq",
      service: "official",
      totalAssetsM: 91.9,
      hafCoins: 524_506,
      realNameStatus: "second_available",
      secondRealNameAvailable: true,
      recoveryCoverage: true,
      verificationAt: "2026-07-19T05:00:27.000Z",
      banNotes: []
    });
    const evidence = result.detail.evidence.map(({ text }) => text);
    expect(evidence).toEqual(
      expect.arrayContaining([
        expect.stringContaining("骇爪-维什戴尔"),
        expect.stringContaining("哈夫币数量524,506"),
        expect.stringContaining("永久包赔")
      ])
    );
    expect(evidence.join(" ")).not.toContain("M7-优品B");
  });
});

describe("pxb7 adapter", () => {
  it("accepts the current official Nuxt shell when catalog links are client-rendered", () => {
    const result = pxb7Adapter.discoverCatalog(
      `
        <html>
          <head>
            <meta name="keywords" content="螃蟹账号交易平台,游戏账号交易">
            <script type="module"
              src="https://g.pxb7.com/pc/version/2_10_16/entry.B0ryMWOO.js">
            </script>
          </head>
          <body>
            <div id="__nuxt"></div>
            <div id="teleports"></div>
            <script>
              window.__NUXT__={};
              window.__NUXT__.config={public:{baseUrl:"https://api-pc.pxb7.com"}};
            </script>
          </body>
        </html>
      `,
      "三角洲行动"
    );

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("expected PXB discovery");
    expect(result.request.url).toContain("selectSearchPageList");
  });

  it("ignores an earlier same-name promo link and verifies the exact catalog", () => {
    const result = pxb7Adapter.discoverCatalog(
      `
        <a href="/specialArea/5?activeGameId=10013">三角洲行动</a>
        <a href="/buy/10371/1">三角洲行动</a>
      `,
      "三角洲行动"
    );

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("expected PXB discovery");
    expect(result.request.url).toContain("selectSearchPageList");
  });

  it("discovers Delta Force and builds the exact approved search request", async () => {
    const result = pxb7Adapter.discoverCatalog(
      await fixture("pxb7-home.html"),
      "三角洲行动"
    );

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("expected PXB discovery");
    expect(result.request).toMatchObject({
      url:
        "https://api-pc.pxb7.com/api/search/product/v2/selectSearchPageList",
      options: {
        method: "POST",
        accept: "application/json, text/plain, */*",
        contentType: "application/json",
        origin: "https://www.pxb7.com",
        referer: "https://www.pxb7.com/"
      }
    });
    expect(JSON.parse(result.request.options?.body ?? "")).toEqual({
      query: "M7战斗步枪-棱镜攻势S2 极品",
      gameId: "10371",
      pageIndex: 1,
      pageSize: 16,
      bizProd: 1,
      type: "4",
      posType: 1
    });
  });

  it("maps public JSON products to summaries with embedded detail", async () => {
    const result = pxb7Adapter.parseList(
      await fixture("pxb7-list-page-1.json")
    );

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("expected PXB list");
    expect(result.items).toHaveLength(16);
    expect(result.items[0]).toMatchObject({
      source: "pxb7",
      sourceListingId: "2307751656489872901",
      url:
        "https://www.pxb7.com/product/2307751656489872901/1",
      priceCny: 5288,
      embeddedDetail: {
        loginPlatform: "qq",
        service: "official",
        totalAssetsM: 268,
        hafCoins: 28_880_000,
        secondRealNameAvailable: true,
        recoveryCoverage: null
      }
    });
    const evidence =
      result.items[0].embeddedDetail?.evidence.map(({ text }) => text) ?? [];
    expect(evidence).toEqual(
      expect.arrayContaining([
        expect.stringContaining("M7战斗步枪-棱镜攻势S2(极品A)"),
        expect.stringContaining("威龙-凌霄戍卫"),
        expect.stringContaining("巨浪(极品)")
      ])
    );
  });

  it("uses only the response cursor to build an immutable next request", async () => {
    const discovery = pxb7Adapter.discoverCatalog(
      await fixture("pxb7-home.html"),
      "三角洲行动"
    );
    if (discovery.kind !== "ok") throw new Error("expected PXB discovery");

    const next = pxb7Adapter.nextPage(
      await fixture("pxb7-list-page-1.json"),
      discovery.request
    );
    expect(next).not.toBeNull();
    expect(JSON.parse(next?.options?.body ?? "")).toEqual({
      query: "M7战斗步枪-棱镜攻势S2 极品",
      gameId: "10371",
      pageIndex: 2,
      pageSize: 16,
      bizProd: 1,
      type: "4",
      posType: 1,
      pageToken: "fixture-page-2"
    });
    expect(
      pxb7Adapter.nextPage(
        await fixture("pxb7-list-page-3.json"),
        next!
      )
    ).toBeNull();

    const repeatedBody = {
      ...JSON.parse(next?.options?.body ?? ""),
      pageToken: "fixture-page-2"
    };
    expect(
      pxb7Adapter.nextPage(
        await fixture("pxb7-list-page-1.json"),
        {
          ...next!,
          options: {
            ...next!.options,
            body: JSON.stringify(repeatedBody)
          }
        }
      )
    ).toBeNull();
  });

  it("keeps微信, dual-login, and unknown-login products out of QQ mapping", async () => {
    const result = pxb7Adapter.parseList(
      await fixture("pxb7-list-page-1.json")
    );
    if (result.kind !== "ok") throw new Error("expected PXB list");

    expect(result.items[8].embeddedDetail).toMatchObject({
      loginPlatform: "wechat",
      service: "unknown"
    });
    expect(result.items[12].embeddedDetail).toMatchObject({
      loginPlatform: "unknown",
      service: "unknown"
    });
    expect(result.items[13].embeddedDetail).toMatchObject({
      loginPlatform: "unknown",
      service: "unknown"
    });
  });

  it.each([
    ["invalid JSON", "{"],
    [
      "failed response",
      JSON.stringify({ success: false, data: { list: [], properties: {} } })
    ],
    [
      "missing list",
      JSON.stringify({ success: true, data: { properties: {} } })
    ]
  ])("blocks %s as a structure change", (_label, content) => {
    expect(pxb7Adapter.parseList(content)).toEqual({
      kind: "blocked",
      reason: "structure_changed"
    });
  });

  it.each([
    ["productId", "unsafe-id"],
    ["bizProd", 2],
    ["gameName", 10371],
    ["productUniqueNo", 99],
    ["guarantee", "平台验号"],
    ["attrNameList", "QQ登录"]
  ])("blocks an invalid %s field for the whole page", async (field, value) => {
    const response = JSON.parse(
      await fixture("pxb7-list-page-1.json")
    ) as {
      data: { list: Array<Record<string, unknown>> };
    };
    response.data.list[0][field] = value;

    expect(pxb7Adapter.parseList(JSON.stringify(response))).toEqual({
      kind: "blocked",
      reason: "structure_changed"
    });
  });

  it("blocks a present non-string page token", async () => {
    const response = JSON.parse(
      await fixture("pxb7-list-page-1.json")
    ) as {
      data: { properties: { pageToken: unknown } };
    };
    response.data.properties.pageToken = 2;

    expect(pxb7Adapter.parseList(JSON.stringify(response))).toEqual({
      kind: "blocked",
      reason: "structure_changed"
    });
  });
});
