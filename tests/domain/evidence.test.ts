import {
  parseJulang,
  parseM7,
  parseRedSkins,
  toEvidenceRecords
} from "../../src/domain/evidence";

describe("M7 棱镜攻势 evidence", () => {
  it.each([
    [["M7 棱镜攻势 极品"], "peak"],
    [["M7 棱镜攻势 优品"], "premium"],
    [["M7 棱镜攻势", "另一件皮肤 极品"], "unknown"],
    [["M7 未拥有棱镜攻势 极品"], "conflicting"],
    [["M7 棱镜攻势 极品 优品"], "conflicting"],
    [["M7 无棱镜攻势"], "absent"],
    [["其它收藏"], "absent"]
  ] as const)("maps %j to %s without crossing records", (lines, expected) => {
    const result = parseM7(toEvidenceRecords([...lines]));

    expect(result.status).toBe(expected);
  });
});

describe("character red-skin evidence", () => {
  it("only names characters explicitly tied to red quality", () => {
    const result = parseRedSkins(
      toEvidenceRecords(["威龙 红皮", "露娜 红色品质", "无名 普通皮肤"])
    );

    expect(result.names).toEqual(["威龙", "露娜"]);
    expect(result.unnamed).toBe(false);
  });

  it("keeps unnamed red-skin claims uncertain", () => {
    const result = parseRedSkins(toEvidenceRecords(["账号有红皮"]));

    expect(result.names).toEqual([]);
    expect(result.unnamed).toBe(true);
  });

  it("recognizes known red-quality character skins from marketplace text", () => {
    const result = parseRedSkins(
      toEvidenceRecords([
        "【角色皮肤】威龙-凌霄戍卫/露娜-黑·天际线/红狼-电锯惊魂",
        "骇爪-维什戴尔/蛊-能天使·午夜邮差"
      ])
    );

    expect(result.names).toEqual(["威龙", "露娜", "骇爪", "蛊"]);
    expect(result.evidence).toHaveLength(2);
  });
});

describe("巨浪 evidence", () => {
  it("extracts an explicitly owned 巨浪 and its quality", () => {
    const result = parseJulang(toEvidenceRecords(["巨浪 极品"]));

    expect(result).toMatchObject({
      status: "owned",
      quality: "极品"
    });
  });

  it.each(["无巨浪", "未拥有巨浪"])(
    "treats negative evidence as absent: %s",
    (line) => {
      expect(parseJulang(toEvidenceRecords([line])).status).toBe("absent");
    }
  );
});

describe("evidence storage", () => {
  it("caps each stored record and marks truncation", () => {
    const [record] = toEvidenceRecords(["M7 ".padEnd(2_100, "长")]);

    expect([...record.text]).toHaveLength(2_000);
    expect(record.truncated).toBe(true);
  });
});
