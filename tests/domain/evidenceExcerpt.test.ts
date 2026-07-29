import {
  buildEvidenceExcerpt,
  type EvidenceExcerpt
} from "../../src/domain/evidenceExcerpt.js";

function excerptText(excerpt: EvidenceExcerpt): string {
  return excerpt.segments.map(({ text }) => text).join("");
}

describe("M7 evidence excerpt", () => {
  it("centers a bounded continuous excerpt around real M7 evidence", () => {
    const text =
      `${"前置描述".repeat(60)}M7 棱镜攻势 极品 品质:A级${"后置描述".repeat(60)}`;
    const excerpt = buildEvidenceExcerpt(text);
    const rendered = excerptText(excerpt);

    expect(rendered.length).toBeLessThanOrEqual(180);
    expect(text).toContain(rendered);
    expect(excerpt.leadingEllipsis).toBe(true);
    expect(excerpt.trailingEllipsis).toBe(true);
    expect(
      excerpt.segments
        .filter(({ highlighted }) => highlighted)
        .map(({ text: segment }) => segment)
        .join("")
    ).toMatch(/M7|棱镜攻势|极品|品质:A级/);
  });

  it("preserves the original casing and characters in highlighted segments", () => {
    const text = "原文写作：m7 | s级，另有棱镜攻势。";
    const excerpt = buildEvidenceExcerpt(text);

    expect(excerptText(excerpt)).toBe(text);
    expect(
      excerpt.segments
        .filter(({ highlighted }) => highlighted)
        .map(({ text: segment }) => segment)
    ).toEqual(expect.arrayContaining(["m7 | s级", "棱镜攻势"]));
  });

  it("does not treat naked quality letters as M7 evidence or a crop center", () => {
    const text = `SKIN ABC ${"普通账号描述".repeat(50)}末尾`;
    const excerpt = buildEvidenceExcerpt(text);

    expect(excerpt.leadingEllipsis).toBe(false);
    expect(excerpt.trailingEllipsis).toBe(true);
    expect(excerptText(excerpt)).toBe(text.slice(0, 180));
    expect(
      excerpt.segments.some(({ highlighted }) => highlighted)
    ).toBe(false);
  });

  it("safely truncates from the beginning when no keyword is present", () => {
    const text = "普通商品原始说明".repeat(40);
    const excerpt = buildEvidenceExcerpt(text, 80);

    expect(excerpt).toEqual({
      leadingEllipsis: false,
      trailingEllipsis: true,
      segments: [{ text: text.slice(0, 80), highlighted: false }]
    });
  });

  it("uses only a leading ellipsis for a keyword near the end", () => {
    const text = `${"其它信息".repeat(80)}棱镜攻势`;
    const excerpt = buildEvidenceExcerpt(text, 100);

    expect(excerpt.leadingEllipsis).toBe(true);
    expect(excerpt.trailingEllipsis).toBe(false);
    expect(excerptText(excerpt).endsWith("棱镜攻势")).toBe(true);
  });

  it("returns an empty safe segment list for empty evidence", () => {
    expect(buildEvidenceExcerpt("")).toEqual({
      leadingEllipsis: false,
      trailingEllipsis: false,
      segments: []
    });
  });
});
