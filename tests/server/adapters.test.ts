// @vitest-environment node
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { jiaoyimaoAdapter } from "../../src/server/collector/adapters/jiaoyimao.js";
import { panzhiAdapter } from "../../src/server/collector/adapters/panzhi.js";
import { pxb7Adapter } from "../../src/server/collector/adapters/pxb7.js";

async function fixture(name: string): Promise<string> {
  return readFile(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
}

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

  it("parses summaries and only follows a real next link", async () => {
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
    expect(
      panzhiAdapter.nextPage(html, {
        url: "https://www.pzds.com/goodsList/391/6"
      })
    ).toEqual({
      url: "https://www.pzds.com/goodsList/391/6?page=2"
    });
    expect(
      panzhiAdapter.nextPage(await fixture("panzhi-list-page-2.html"), {
        url: "https://www.pzds.com/goodsList/391/6?page=2"
      })
    ).toBeNull();
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

  it("recognizes the verified filtered catalog and parses its cards", async () => {
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
    expect(
      jiaoyimaoAdapter.nextPage(html, {
        url: jiaoyimaoAdapter.entryUrl
      })
    ).toBeNull();
  });

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
