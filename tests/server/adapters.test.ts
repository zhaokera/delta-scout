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
      url: "https://www.pzds.com/goodsList/391/6"
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
    expect(panzhiAdapter.nextPage(html)).toBe(
      "https://www.pzds.com/goodsList/391/6?page=2"
    );
    expect(
      panzhiAdapter.nextPage(await fixture("panzhi-list-page-2.html"))
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

describe("blocked source adapters", () => {
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

  it("discovers Pangxie catalog but blocks an unverified client shell", async () => {
    expect(
      pxb7Adapter.discoverCatalog(
        await fixture("pxb7-home.html"),
        "三角洲行动"
      )
    ).toEqual({
      kind: "ok",
      url: "https://www.pxb7.com/buy/10371/1"
    });
    expect(
      pxb7Adapter.parseList(await fixture("pxb7-list.html"))
    ).toEqual({
      kind: "blocked",
      reason: "unverified_structure"
    });
  });
});
