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
    [
      [
        "【传说典藏】M7战斗步枪-棱镜攻势S2(极品C/其他)/AS Val突击步枪-悬赏令(优品C)"
      ],
      "peak"
    ],
    [
      [
        "M7棱镜(极品C)/ASVal悬赏令(优品C)，M250电玩(优品A)"
      ],
      "absent"
    ],
    [
      ["M7棱镜(极品C)/M7棱镜(优品A)"],
      "absent"
    ],
    [["M7 无棱镜攻势"], "absent"],
    [["其它收藏"], "absent"]
  ] as const)("maps %j to %s without crossing records", (lines, expected) => {
    const result = parseM7(toEvidenceRecords([...lines]));

    expect(result.status).toBe(expected);
  });

  it.each([
    ["M7棱镜攻势：极品A", "A"],
    ["M7-棱镜攻势(极品S)", "S"],
    ["M7战斗步枪-棱镜攻势S2(极品C/其他)", "C"]
  ] as const)("extracts the exact peak grade from %s", (text, quality) => {
    const result = parseM7(toEvidenceRecords([text]));

    expect(result).toMatchObject({ status: "peak", quality });
  });

  it.each([
    [
      "典藏传说枪械极品|Bx1M7战...势S2优品|Ax2其它枪械",
      "B"
    ],
    [
      "极品|Cx2AS Val突击步枪-悬赏令M7战…势S2优品|Bx3其它枪械",
      "C"
    ],
    [
      "极品|Ax1腾龙...极品|Cx1M7战...势S2",
      "C"
    ]
  ] as const)(
    "extracts local truncated Jiaoyimao peak quality from %s",
    (text, quality) => {
      expect(parseM7(toEvidenceRecords([text]))).toMatchObject({
        status: "peak",
        quality
      });
    }
  );

  it.each([
    "优品|Bx1M7战...势S2",
    "M7战...势S2",
    "极品|M7战...势S2",
    "极品|Bx0M7战...势S2",
    "极品|Bx1非 M7战...势S2",
    "极品|Bx1未拥有 M7战...势S2",
    "极品|Bx1未拥有M7战...势S2",
    "极品|Bx1无M7可选",
    "极品|Bx1M7战...其它S2",
    "极品|Ax1腾龙优品|Bx1M7战...势S2",
    `极品|Bx1${"其它枪械".repeat(50)}M7战...势S2`
  ])("does not infer a truncated peak outside one bounded peak group: %s", (text) => {
    expect(parseM7(toEvidenceRecords([text])).status).toBe("absent");
  });

  it.each([
    "极品|Bx1未拥有腾龙 M7战...势S2",
    "极品|Bx2未拥有M7战...势S2 M7战…势S2"
  ])("keeps a non-negated truncated target positive: %s", (text) => {
    expect(parseM7(toEvidenceRecords([text]))).toMatchObject({
      status: "peak",
      quality: "B"
    });
  });

  it("keeps one quality when repeated truncated peak groups agree", () => {
    expect(
      parseM7(
        toEvidenceRecords([
          "极品|Bx1M7战...势S2极品|Bx2AS Val M7战…势S2"
        ])
      )
    ).toMatchObject({
      status: "peak",
      quality: "B"
    });
  });

  it("keeps peak but clears quality when truncated peak groups conflict", () => {
    expect(
      parseM7(
        toEvidenceRecords([
          "极品|Ax1M7战...势S2极品|Cx1M7战…势S2"
        ])
      )
    ).toMatchObject({
      status: "peak",
      quality: undefined
    });
  });

  it.each([
    "M7棱镜幻影(极品S)",
    "M7棱镜(极品C)",
    "M7战斗步枪-棱镜攻势S2 / 其它武器极品",
    "M7战斗步枪-棱镜攻势S2 当前有皮肤，AS Val突击步枪-悬赏令(极品S)"
  ])("does not infer peak from non-target or later quality: %s", (text) => {
    expect(parseM7(toEvidenceRecords([text])).status).not.toBe("peak");
  });

  it("does not combine another evidence record's quality", () => {
    const result = parseM7(
      toEvidenceRecords([
        "M7战斗步枪-棱镜攻势S2",
        "其它字段 极品S"
      ])
    );

    expect(result).toMatchObject({
      status: "unknown",
      quality: undefined
    });
  });

  it("clears the grade when M7 evidence conflicts", () => {
    const result = parseM7(
      toEvidenceRecords([
        "M7棱镜攻势(极品A)",
        "M7棱镜攻势(优品B)"
      ])
    );

    expect(result).toMatchObject({
      status: "conflicting",
      quality: undefined
    });
  });

  it("keeps explicit peak quality when an inventory record repeats it without quality", () => {
    const result = parseM7(
      toEvidenceRecords([
        "【传说典藏皮肤】M7战斗步枪-棱镜攻势S2(极品C)",
        "【步枪皮肤】M7战斗步枪-棱镜攻势S2"
      ])
    );

    expect(result).toMatchObject({
      status: "peak",
      quality: "C"
    });
  });

  it.each([
    ["XM7战斗步枪-棱镜攻势S2(极品A)", "absent"],
    ["非M7战斗步枪-棱镜攻势S2(极品A)", "absent"]
  ] as const)("does not positively match a prefixed target: %s", (text, status) => {
    expect(parseM7(toEvidenceRecords([text])).status).toBe(status);
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

  it("recognizes 乌鲁鲁-狂怒 as a named red-quality skin", () => {
    const result = parseRedSkins(
      toEvidenceRecords(["乌鲁鲁-狂怒 M7-极品S"])
    );

    expect(result.names).toEqual(["乌鲁鲁"]);
    expect(result.unnamed).toBe(false);
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
