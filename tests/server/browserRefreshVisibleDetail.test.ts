// @vitest-environment node
import { readFile } from "node:fs/promises";
import { load } from "cheerio";
import { describe, expect, it } from "vitest";
import type { ListingSummary } from "../../src/server/collector/types.js";
import {
  parseJiaoyimaoVisibleDetail,
  type JiaoyimaoVisibleSections
} from "../../src/server/browserRefresh/visibleDetail.js";

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

  it("parses late facts from full sections without enlarging stored evidence", () => {
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
});
