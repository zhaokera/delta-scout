// @vitest-environment node
import { readFile } from "node:fs/promises";
import { load } from "cheerio";
import { describe, expect, it } from "vitest";
import {
  parseJulang,
  parseM7,
  parseM7RareFinishes,
  parseRedSkins
} from "../../src/domain/evidence.js";
import type { ListingSummary } from "../../src/server/collector/types.js";
import {
  parseJiaoyimaoVisibleDetail,
  type JiaoyimaoVisibleSections
} from "../../src/server/browserRefresh/visibleDetail.js";
import { BROWSER_REFRESH_LIMITS } from "../../src/server/browserRefresh/contracts.js";

async function fixture(name: string): Promise<string> {
  return readFile(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
}

const summary: ListingSummary = {
  source: "jiaoyimao",
  sourceListingId: "1784435272636913",
  url: "https://www.jiaoyimao.com/jg2007840/1784435272636913.html",
  title: "总资产91.9M 7干员外观",
  rawText: "M7棱镜攻势(极品S) QQ双端帐号",
  priceCny: 3600
};

async function fixtureSections(): Promise<JiaoyimaoVisibleSections> {
  const $ = load(await fixture("jiaoyimao-detail.html"));
  const text = (selector: string) =>
    $(selector).first().text().replace(/\s+/g, " ").trim();
  return {
    head: text(".item-head-info-card"),
    report: text(".cmp-elevator-container"),
    safety: text(".safe-report-container"),
    description: ""
  };
}

describe("parseJiaoyimaoVisibleDetail", () => {
  it("recognizes a visibly unavailable listing without normal detail blocks", () => {
    const result = parseJiaoyimaoVisibleDetail(
      {
        head:
          "商品已下架 很抱歉，无法查看【商品已下架】的商品信息 返回首页查看类似商品",
        report: "",
        safety: "",
        description: ""
      },
      summary
    );

    expect(result).toEqual({
      kind: "unavailable",
      reason: "listing_unavailable"
    });
  });

  it("parses the existing fixture into equivalent local detail fields and evidence", async () => {
    const result = parseJiaoyimaoVisibleDetail(
      await fixtureSections(),
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
    expect(result.detail.evidence.map(({ text }) => text)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("M7-极品S"),
        expect.stringContaining("哈夫币数量524,506"),
        expect.stringContaining("永久包赔")
      ])
    );
  });

  it.each([
    [{ head: "", report: "总资产1M", safety: "", description: "" }],
    [{ head: "QQ双端帐号", report: "", safety: "", description: "" }]
  ])("blocks when the minimum visible structure is absent", (sections) => {
    expect(parseJiaoyimaoVisibleDetail(sections, summary)).toEqual({
      kind: "blocked",
      reason: "structure_changed"
    });
  });

  it("preserves rare-finish description text as local evidence", () => {
    const result = parseJiaoyimaoVisibleDetail(
      {
        head: "QQ双端帐号 M7棱镜攻势S2 极品A",
        report: "总资产88M 哈夫币数量123,456",
        safety: "永久包赔",
        description: "M7棱镜攻势S2 珠光 炫彩 糖果纸"
      },
      summary
    );

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("expected parsed detail");
    expect(result.detail.evidence.map(({ text }) => text)).toContain(
      "M7棱镜攻势S2 珠光 炫彩 糖果纸"
    );
  });

  it("parses late facts without enlarging individual evidence records", () => {
    const padding = "普通可见说明".repeat(350);
    const result = parseJiaoyimaoVisibleDetail(
      {
        head:
          `QQ双端帐号 ${padding} ` +
          "M7棱镜攻势S2 极品A 珠光",
        report:
          `${padding} 总资产88M 哈夫币数量123,456 ` +
          "验号时间：2026-07-30 13:00:00",
        safety:
          `${padding} 可二次实名 永久包赔 ` +
          "黑号校验异常",
        description:
          `${padding} M7棱镜攻势S2 炫彩 糖果纸`
      },
      summary
    );

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("expected parsed detail");
    expect(result.detail).toMatchObject({
      loginPlatform: "qq",
      service: "official",
      totalAssetsM: 88,
      hafCoins: 123_456,
      realNameStatus: "second_available",
      secondRealNameAvailable: true,
      recoveryCoverage: true,
      verificationAt: "2026-07-30T05:00:00.000Z",
      banNotes: ["页面提示存在封号或黑号风险"]
    });
    expect(
      result.detail.evidence.every(
        ({ text }) => [...text].length <= 2_000
      )
    ).toBe(true);
    expect(
      result.detail.evidence.some(
        ({ text, truncated }) =>
          truncated &&
          text.includes("M7棱镜攻势S2 炫彩 糖果纸")
      )
    ).toBe(true);
  });

  it("preserves middle facts for the actual downstream evidence parsers", () => {
    const prefix = "前置普通描述".repeat(450);
    const suffix = "后置普通描述".repeat(450);
    const facts =
      "M7战斗步枪-棱镜攻势S2极品A 全炫彩 珠光 糖果纸，" +
      "威龙-凌霄戍卫 红皮，巨浪(极品)";
    const result = parseJiaoyimaoVisibleDetail(
      {
        head: "QQ双端帐号",
        report: "总资产88M",
        safety: "永久包赔",
        description: `${prefix}${facts}${suffix}`
      },
      summary
    );

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("expected parsed detail");
    const { evidence } = result.detail;
    expect(evidence.every(({ text }) => [...text].length <= 2_000))
      .toBe(true);
    expect(evidence.length).toBeGreaterThan(4);
    expect(parseM7(evidence)).toMatchObject({
      status: "peak",
      quality: "A"
    });
    expect(parseM7RareFinishes(evidence).finishes).toEqual([
      "pearl",
      "iridescent",
      "candy"
    ]);
    expect(parseRedSkins(evidence).names).toContain("威龙");
    expect(parseJulang(evidence)).toMatchObject({
      status: "owned",
      quality: "极品"
    });
  });

  it.each([
    {
      head: "QQ双端帐号",
      report: "总资产88M",
      safety: "",
      description: "字".repeat(
        BROWSER_REFRESH_LIMITS.maxSectionChars + 1
      )
    },
    {
      head: `QQ双端帐号${"字".repeat(8_000)}`,
      report: `总资产88M${"字".repeat(8_000)}`,
      safety: `永久包赔${"字".repeat(8_000)}`,
      description: `M7棱镜攻势${"字".repeat(8_000)}`
    }
  ])("blocks detail text outside contract bounds", (sections) => {
    expect(parseJiaoyimaoVisibleDetail(sections, summary)).toEqual({
      kind: "blocked",
      reason: "structure_changed"
    });
  });
});
