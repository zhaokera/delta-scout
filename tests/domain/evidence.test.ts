import {
  parseJulang,
  parseM7,
  parseM7RareFinishes,
  parseRedSkins,
  parseRequiredRedSkins,
  toEvidenceRecords
} from "../../src/domain/evidence";
import type { EvidenceRecord } from "../../src/domain/evidence";

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
      "unknown"
    ],
    [
      ["M7棱镜(极品C)/M7棱镜(优品A)"],
      "unknown"
    ],
    [["M7 无棱镜攻势"], "absent"],
    [["其它收藏"], "unknown"]
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
    ["M7战斗步枪-棱镜攻势S2(优品S)", "S"],
    ["M7棱镜攻势（优品 A）", "A"],
    ["M7棱镜攻势:优品B", "B"],
    ["M7棱镜攻势 优品C", "C"]
  ] as const)("extracts the exact premium grade from %s", (text, quality) => {
    const result = parseM7(toEvidenceRecords([text]));

    expect(result).toMatchObject({ status: "premium", quality });
  });

  it("keeps one premium quality when repeated records agree", () => {
    const result = parseM7(
      toEvidenceRecords([
        "M7棱镜攻势(优品S)",
        "M7战斗步枪-棱镜攻势S2 优品 S"
      ])
    );

    expect(result).toMatchObject({
      status: "premium",
      quality: "S"
    });
  });

  it("keeps premium status but clears quality when premium records disagree", () => {
    const result = parseM7(
      toEvidenceRecords([
        "M7棱镜攻势(优品S)",
        "M7战斗步枪-棱镜攻势S2(优品A)"
      ])
    );

    expect(result).toMatchObject({
      status: "premium",
      quality: undefined
    });
  });

  it("does not invent a premium grade when none is adjacent", () => {
    expect(
      parseM7(toEvidenceRecords(["M7棱镜攻势 优品"]))
    ).toMatchObject({
      status: "premium",
      quality: undefined
    });
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
    expect(parseM7(toEvidenceRecords([text])).status).toBe("unknown");
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
    ["XM7战斗步枪-棱镜攻势S2(极品A)", "unknown"],
    ["非M7战斗步枪-棱镜攻势S2(极品A)", "unknown"]
  ] as const)("does not positively match a prefixed target: %s", (text, status) => {
    expect(parseM7(toEvidenceRecords([text])).status).toBe(status);
  });
});

describe("M7 rare-finish evidence", () => {
  it.each([
    ["市场价5万+三角券的珠光粉M7", ["pearl"]],
    ["极品炫彩镭射M7", ["iridescent"]],
    ["M7的局内表现效果很好炫彩渐变", ["iridescent"]],
    ["M7极品A 400发AWM子弹 7000点券 全炫彩", ["iridescent"]],
    ["M7战斗步枪-棱镜攻势S2极品A 全炫彩", ["iridescent"]],
    ["棱镜攻势M7—极品B糖果纸", ["candy"]],
    [
      "棱镜攻势M7—极品B糖果纸 电玩高手M250—极品A黑红闪烁 电玩高手MP7—极品A白彩RBG",
      ["candy"]
    ],
    ["m7极品sT0模板珠光粉", ["pearl"]],
    [
      "白灯糖果纸m7，珠光粉M7，全炫彩M7",
      ["pearl", "iridescent", "candy"]
    ]
  ] as const)("extracts rare M7 finishes from %s", (text, finishes) => {
    expect(
      parseM7RareFinishes(toEvidenceRecords([text])).finishes
    ).toEqual([...finishes]);
  });

  it.each([
    "XM7炫彩",
    "M7无炫彩",
    "M7不带珠光",
    "不是糖果纸M7",
    "极品M7说明文字炫彩MP7",
    "M7说明文字巨浪是蓝紫粉炫彩",
    "M7说明文字AUG珠光",
    "有三个赛季的炫彩3×3",
    "炫彩挂饰",
    `M7${"普通说明".repeat(10)}珠光`,
    "M7普通说明，珠光挂饰"
  ])("does not misassign %s", (text) => {
    expect(
      parseM7RareFinishes(toEvidenceRecords([text])).finishes
    ).toEqual([]);
  });

  it("deduplicates finishes in fixed order and keeps only supporting records", () => {
    const result = parseM7RareFinishes(
      toEvidenceRecords([
        "全炫彩M7",
        "普通账号说明",
        "M7糖果纸和珠光，M7珠光"
      ])
    );

    expect(result.finishes).toEqual(["pearl", "iridescent", "candy"]);
    expect(result.evidence.map(({ text }) => text)).toEqual([
      "全炫彩M7",
      "M7糖果纸和珠光，M7珠光"
    ]);
  });

  it("skips a keyword tied equally to M7 and another subject", () => {
    expect(
      parseM7RareFinishes(toEvidenceRecords(["M7x炫彩xMP7"])).finishes
    ).toEqual([]);
  });

  it.each([
    "M7普通说明/珠光挂饰",
    "M7普通说明；糖果纸收藏品",
    "M7普通说明\n炫彩3×3"
  ])("does not pair finishes across clause boundaries: %s", (text) => {
    expect(
      parseM7RareFinishes(toEvidenceRecords([text])).finishes
    ).toEqual([]);
  });

  it("isolates malformed records without discarding the caller-owned input", () => {
    const malformed = {
      get text() {
        throw new Error("malformed evidence");
      },
      truncated: false
    } as unknown as EvidenceRecord;
    const records = [malformed];

    expect(parseM7RareFinishes(records)).toEqual({
      finishes: [],
      evidence: []
    });
    expect(records).toEqual([malformed]);
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

describe("required red-skin evidence", () => {
  it("proves both required skins despite marketplace separators", () => {
    const result = parseRequiredRedSkins(toEvidenceRecords([
      "骇爪-维什戴尔 / 露娜-黑·天际线"
    ]));

    expect(result).toMatchObject({
      names: ["骇爪-维什戴尔", "露娜-黑天际线"],
      status: "complete"
    });
  });

  it("keeps one proven skin pending instead of admitting the account", () => {
    expect(parseRequiredRedSkins(toEvidenceRecords([
      "骇爪-维什戴尔"
    ])).status).toBe("partial");
  });

  it("rejects an explicitly absent required skin", () => {
    const result = parseRequiredRedSkins(toEvidenceRecords([
      "骇爪-维什戴尔，没有露娜-黑天际线"
    ]));

    expect(result.status).toBe("missing");
    expect(result.names).toEqual(["骇爪-维什戴尔"]);
  });

  it("does not confuse 骇爪-水墨云图 with 骇爪-维什戴尔", () => {
    expect(parseRequiredRedSkins(toEvidenceRecords([
      "骇爪-水墨云图 露娜-黑天际线"
    ]))).toMatchObject({
      names: ["露娜-黑天际线"],
      status: "partial"
    });
  });

  it("does not confuse same-named weapon skins with operator skins", () => {
    expect(parseRequiredRedSkins(toEvidenceRecords([
      "R93狙击步枪-维什戴尔 PSG-1射手步枪-黑-天际线"
    ]))).toMatchObject({
      names: [],
      status: "unknown"
    });
  });

  it("requires each skin to be paired with the correct operator", () => {
    expect(parseRequiredRedSkins(toEvidenceRecords([
      "R93狙击步枪-维什戴尔 露娜-黑·天际线"
    ]))).toMatchObject({
      names: ["露娜-黑天际线"],
      status: "partial"
    });
  });

  it("recognizes an explicitly missing skin between operator and skin names", () => {
    expect(parseRequiredRedSkins(toEvidenceRecords([
      "骇爪-维什戴尔，露娜没有黑天际线"
    ]))).toMatchObject({
      names: ["骇爪-维什戴尔"],
      status: "missing"
    });
  });

  it("does not admit conflicting positive and negative evidence", () => {
    expect(parseRequiredRedSkins(toEvidenceRecords([
      "骇爪-维什戴尔 露娜-黑天际线",
      "复核备注：不带骇爪-维什戴尔"
    ])).status).toBe("missing");
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
