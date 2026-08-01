// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  BROWSER_REFRESH_LIMITS,
  BROWSER_REFRESH_SOURCE,
  BrowserCooldownSchema,
  BrowserDetailBatchSchema,
  BrowserDetailInputSchema,
  BrowserFilterProofSchema,
  BrowserListBatchSchema,
  BrowserLoadEventSchema,
  BrowserPauseSchema,
  BrowserRefreshJobStateSchema
} from "../../src/server/browserRefresh/contracts.js";
import { APPROVED_JIAOYIMAO_REFERER } from "../../src/server/collector/mtop.js";

const now = "2026-07-30T12:42:09.000Z";
const filterUrl = APPROVED_JIAOYIMAO_REFERER;
const qqFilterUrl =
  "https://www.jiaoyimao.com/jg2007840/f8845003-c8845004/" +
  `o1687157900084320/${new URL(filterUrl).search}`;

function listItem(overrides: Record<string, unknown> = {}) {
  return {
    sourceListingId: "1785384225212552",
    url:
      "https://www.jiaoyimao.com/jg2007840/" +
      "1785384225212552.html?isGray=true",
    title: "QQ三角洲账号",
    rawText: "M7棱镜攻势 极品S",
    priceCny: 4300,
    ...overrides
  };
}

function detailItem(overrides: Record<string, unknown> = {}) {
  return {
    sourceListingId: "1785384225212552",
    url:
      "https://www.jiaoyimao.com/jg2007840/" +
      "1785384225212552.html",
    observedAt: now,
    sections: {
      head: "QQ双端帐号",
      report: "总资产91.9M",
      safety: "永久包赔",
      description: "M7棱镜攻势 极品S"
    },
    ...overrides
  };
}

function filterProof(overrides: Record<string, unknown> = {}) {
  return {
    currentUrl: filterUrl,
    gameLabel: "三角洲行动",
    platformLabel: "QQ",
    categoryLabel: "账号",
    activeFilterLabels: [
      "1900-4000",
      "骇爪-维什戴尔",
      "露娜-黑·天际线"
    ],
    observedAt: now,
    ...overrides
  };
}

function loadEvent(overrides: Record<string, unknown> = {}) {
  return {
    sequence: 1,
    observedUniqueCount: 10,
    newItemCount: 10,
    visibleTotalCount: 20,
    endMarkerVisible: false,
    loadingVisible: false,
    blockingState: "none",
    observedAt: now,
    ...overrides
  };
}

const forbiddenVisibleText = [
  "cookie=secret",
  "COOKIE : secret",
  "set-cookie: sid=secret",
  "AUTHORIZATION = Basic abc",
  "Bearer abc123",
  "_m_h5_tk=secret",
  "password: secret",
  "验证码答案=1234",
  "校验码 : 1234",
  "<ScRiPt>alert(1)</script>",
  "JaVaScRiPt:alert(1)",
  "<svg onload=alert(1)>visible</svg>",
  "<iframe src=https://evil.example>visible</iframe>",
  "<div>visible text</div>",
  '<img title="<" src=x onerror=alert(1)>'
] as const;

describe("browser refresh contract constants", () => {
  it("locks the source, job states, and bridge limits", () => {
    expect(BROWSER_REFRESH_SOURCE).toBe("jiaoyimao");
    expect(BrowserRefreshJobStateSchema.options).toEqual([
      "awaiting_codex",
      "collecting_list",
      "collecting_details",
      "awaiting_user_verification",
      "cooling_down",
      "validating",
      "committing",
      "success",
      "quarantined",
      "paused",
      "failed",
      "cancelled",
      "expired"
    ]);
    expect(BROWSER_REFRESH_LIMITS).toEqual({
      maxListItemsPerBatch: 25,
      maxDetailsPerBatch: 5,
      maxUniqueItems: 2000,
      maxLoadEvents: 100,
      maxTitleChars: 500,
      maxCardTextChars: 4000,
      maxSectionChars: 12000,
      maxCombinedDetailTextChars: 32000,
      maxFilterLabelChars: 100,
      maxClaimCodeChars: 64,
      maxPauseMessageChars: 500,
      maxBatchUtf8Bytes: 131072
    });
  });
});

describe("Jiaoyimao URL and scalar validation", () => {
  it("accepts canonical list and detail observations", () => {
    expect(BrowserFilterProofSchema.parse(filterProof())).toEqual(
      filterProof()
    );
    expect(BrowserFilterProofSchema.parse(
      filterProof({ currentUrl: qqFilterUrl })
    ).currentUrl).toBe(qqFilterUrl);
    expect(BrowserListBatchSchema.parse({
      sequence: 1,
      observedAt: now,
      items: [listItem()]
    })).toMatchObject({ sequence: 1 });
    expect(BrowserDetailInputSchema.parse(detailItem())).toEqual(
      detailItem()
    );
  });

  it.each([
    ["external filter origin", { currentUrl: filterUrl.replace(
      "https://www.jiaoyimao.com",
      "https://evil.example"
    ) }],
    ["wrong game catalog path", {
      currentUrl: "https://www.jiaoyimao.com/jg9999999/list/"
    }],
    ["unapproved category path", {
      currentUrl:
        "https://www.jiaoyimao.com/" +
        "jg2007840/f8845003-c8845004/o999/"
    }],
    ["filter URL credentials", {
      currentUrl:
        "https://user:pass@www.jiaoyimao.com/" +
        "jg2007840/f8845003-c8845004/o110/"
    }]
  ])("rejects %s", (_label, override) => {
    expect(() =>
      BrowserFilterProofSchema.parse(filterProof(override))
    ).toThrow();
  });

  it.each([
    ["surrounding whitespace", ` ${filterUrl}`],
    ["leading control whitespace", `\t${filterUrl}`],
    [
      "an explicit default port",
      filterUrl.replace(
        "https://www.jiaoyimao.com",
        "https://www.jiaoyimao.com:443"
      )
    ],
    [
      "a dot segment",
      filterUrl.replace("/o110/", "/ignored/../o110/")
    ],
    ["an empty query delimiter", `${filterUrl.split("?")[0]}?`],
    ["an empty hash delimiter", `${filterUrl}#`]
  ])("rejects a non-canonical filter URL with %s", (_label, currentUrl) => {
    expect(() =>
      BrowserFilterProofSchema.parse(filterProof({ currentUrl }))
    ).toThrow();
  });

  it.each([
    ["external detail origin", {
      url: "https://evil.example/jg2007840/1785384225212552.html"
    }],
    ["wrong detail path", {
      url: "https://www.jiaoyimao.com/jg9999999/1785384225212552.html"
    }],
    ["non-digit ID", { sourceListingId: "178abc" }],
    ["path and ID mismatch", {
      url: "https://www.jiaoyimao.com/jg2007840/999.html"
    }],
    ["detail URL credentials", {
      url:
        "https://user:pass@www.jiaoyimao.com/" +
        "jg2007840/1785384225212552.html"
    }],
    ["invalid timestamp", { observedAt: "July 30" }]
  ])("rejects a detail with %s", (_label, override) => {
    expect(() =>
      BrowserDetailInputSchema.parse(detailItem(override))
    ).toThrow();
  });

  it.each([
    [
      "surrounding whitespace",
      ` ${detailItem().url}`
    ],
    [
      "leading control whitespace",
      `\n${detailItem().url}`
    ],
    [
      "an explicit default port",
      detailItem().url.replace(
        "https://www.jiaoyimao.com",
        "https://www.jiaoyimao.com:443"
      )
    ],
    [
      "a dot segment",
      detailItem().url.replace(
        "/1785384225212552.html",
        "/ignored/../1785384225212552.html"
      )
    ],
    [
      "textual path and ID disagreement",
      detailItem().url.replace(
        "/1785384225212552.html",
        "/999.html/../1785384225212552.html"
      )
    ],
    ["an empty query delimiter", `${detailItem().url}?`],
    ["an empty hash delimiter", `${detailItem().url}#`]
  ])("rejects a non-canonical detail URL with %s", (_label, url) => {
    expect(() =>
      BrowserDetailInputSchema.parse(detailItem({ url }))
    ).toThrow();
  });

  it.each([
    [
      "surrounding whitespace",
      ` ${listItem().url}`
    ],
    [
      "leading control whitespace",
      `\t${listItem().url}`
    ],
    [
      "an explicit default port",
      listItem().url.replace(
        "https://www.jiaoyimao.com",
        "https://www.jiaoyimao.com:443"
      )
    ],
    [
      "a dot segment",
      listItem().url.replace(
        "/1785384225212552.html",
        "/ignored/../1785384225212552.html"
      )
    ],
    [
      "textual path and ID disagreement",
      listItem().url.replace(
        "/1785384225212552.html",
        "/999.html/../1785384225212552.html"
      )
    ],
    [
      "an empty query delimiter",
      `${listItem().url.split("?")[0]}?`
    ],
    ["an empty hash delimiter", `${listItem().url}#`]
  ])("rejects a non-canonical list URL with %s", (_label, url) => {
    expect(() =>
      BrowserListBatchSchema.parse({
        sequence: 1,
        observedAt: now,
        items: [listItem({ url })]
      })
    ).toThrow();
  });

  it("preserves canonical query strings on approved URLs", () => {
    const detailUrl =
      `${detailItem().url}?isGray=true&from=list`;
    expect(BrowserFilterProofSchema.parse(filterProof()).currentUrl)
      .toBe(filterUrl);
    expect(
      BrowserDetailInputSchema.parse(detailItem({ url: detailUrl })).url
    ).toBe(detailUrl);
    expect(
      BrowserListBatchSchema.parse({
        sequence: 1,
        observedAt: now,
        items: [listItem({ url: detailUrl })]
      }).items[0].url
    ).toBe(detailUrl);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    "rejects invalid price %s",
    (priceCny) => {
      expect(() =>
        BrowserListBatchSchema.parse({
          sequence: 1,
          observedAt: now,
          items: [listItem({ priceCny })]
        })
      ).toThrow();
    }
  );

  it("allows an unknown price without allowing an invalid numeric price", () => {
    expect(BrowserListBatchSchema.safeParse({
      sequence: 1,
      observedAt: now,
      items: [listItem({ priceCny: null })]
    }).success).toBe(true);
  });
});

describe("strict bridge object shapes", () => {
  it.each([
    ["filter proof", BrowserFilterProofSchema, filterProof({ cookie: "x" })],
    ["list batch", BrowserListBatchSchema, {
      sequence: 1,
      observedAt: now,
      items: [listItem()],
      authorization: "x"
    }],
    ["list item", BrowserListBatchSchema, {
      sequence: 1,
      observedAt: now,
      items: [listItem({ cookie: "x" })]
    }],
    ["load event", BrowserLoadEventSchema, loadEvent({ password: "x" })],
    ["detail batch", BrowserDetailBatchSchema, {
      sequence: 1,
      items: [detailItem()],
      html: "<body>x</body>"
    }],
    ["detail item", BrowserDetailInputSchema, detailItem({ service: "official" })],
    ["detail sections", BrowserDetailInputSchema, detailItem({
      sections: {
        head: "x",
        report: "y",
        safety: "",
        description: "",
        cookie: "secret"
      }
    })],
    ["pause", BrowserPauseSchema, {
      reason: "captcha_required",
      cookie: "x"
    }],
    ["cooldown", BrowserCooldownSchema, {
      reason: "rate_limited",
      authorization: "x"
    }]
  ])("rejects extra keys in %s", (_label, schema, value) => {
    expect(() => schema.parse(value)).toThrow();
  });
});

describe("safe visible text", () => {
  it.each(forbiddenVisibleText)(
    "rejects forbidden text in every title and rawText field: %s",
    (text) => {
      for (const field of ["title", "rawText"] as const) {
        expect(() =>
          BrowserListBatchSchema.parse({
            sequence: 1,
            observedAt: now,
            items: [listItem({ [field]: `普通文本 ${text}` })]
          })
        ).toThrow();
      }
    }
  );

  it.each(forbiddenVisibleText)(
    "rejects forbidden text in every detail section: %s",
    (text) => {
      for (const field of [
        "head",
        "report",
        "safety",
        "description"
      ] as const) {
        const item = detailItem();
        expect(() =>
          BrowserDetailInputSchema.parse({
            ...item,
            sections: {
              ...item.sections,
              [field]: `普通文本 ${text}`
            }
          })
        ).toThrow();
      }
    }
  );

  it.each(forbiddenVisibleText)(
    "rejects forbidden text in every visible proof label and pause message: %s",
    (text) => {
      for (const field of [
        "gameLabel",
        "platformLabel",
        "categoryLabel"
      ] as const) {
        expect(() =>
          BrowserFilterProofSchema.parse(
            filterProof({ [field]: `普通文本 ${text}` })
          )
        ).toThrow();
      }
      expect(() =>
        BrowserPauseSchema.parse({
          reason: "captcha_required",
          message: `普通文本 ${text}`
        })
      ).toThrow();
    }
  );

  it("allows an ordinary visible CAPTCHA prompt in all visible text kinds", () => {
    const prompt = "请完成验证码";
    expect(BrowserListBatchSchema.safeParse({
      sequence: 1,
      observedAt: now,
      items: [listItem({ title: prompt, rawText: prompt })]
    }).success).toBe(true);
    expect(BrowserDetailInputSchema.safeParse(detailItem({
      sections: {
        head: prompt,
        report: prompt,
        safety: prompt,
        description: prompt
      }
    })).success).toBe(true);
    expect(BrowserFilterProofSchema.safeParse(filterProof({
      gameLabel: prompt,
      platformLabel: prompt,
      categoryLabel: prompt,
      activeFilterLabels: [
        "1900-4000",
        "骇爪-维什戴尔",
        "露娜-黑·天际线"
      ]
    })).success).toBe(true);
    expect(BrowserPauseSchema.safeParse({
      reason: "captcha_required",
      message: prompt
    }).success).toBe(true);
  });

  it("rejects full HTML in visible detail sections", () => {
    expect(() =>
      BrowserDetailInputSchema.parse(detailItem({
        sections: {
          head: "<html><body>visible</body></html>",
          report: "report",
          safety: "",
          description: ""
        }
      }))
    ).toThrow();
  });

  it("allows comparison symbols when they do not form markup", () => {
    const comparison = "价格 < 6000 且数量 > 0";
    expect(BrowserListBatchSchema.safeParse({
      sequence: 1,
      observedAt: now,
      items: [listItem({ title: comparison, rawText: comparison })]
    }).success).toBe(true);
    expect(BrowserDetailInputSchema.safeParse(detailItem({
      sections: {
        head: comparison,
        report: comparison,
        safety: comparison,
        description: comparison
      }
    })).success).toBe(true);
    expect(BrowserFilterProofSchema.safeParse(filterProof({
      gameLabel: comparison,
      platformLabel: comparison,
      categoryLabel: comparison,
      activeFilterLabels: [
        "1900-4000",
        "骇爪-维什戴尔",
        "露娜-黑·天际线"
      ]
    })).success).toBe(true);
    expect(BrowserPauseSchema.safeParse({
      reason: "captcha_required",
      message: comparison
    }).success).toBe(true);
  });

  it("rejects an undeclared active item filter", () => {
    expect(BrowserFilterProofSchema.safeParse(filterProof({
      activeFilterLabels: ["M7 棱镜攻势 极品S"]
    })).success).toBe(false);
  });
});

describe("batch limits and load events", () => {
  it.each([0, 26])("rejects a list batch with %i items", (count) => {
    expect(() =>
      BrowserListBatchSchema.parse({
        sequence: 1,
        observedAt: now,
        items: Array.from({ length: count }, () => listItem())
      })
    ).toThrow();
  });

  it.each([0, 6])("rejects a detail batch with %i items", (count) => {
    expect(() =>
      BrowserDetailBatchSchema.parse({
        sequence: 1,
        items: Array.from({ length: count }, () => detailItem())
      })
    ).toThrow();
  });

  it.each([
    [BrowserListBatchSchema, {
      sequence: 0,
      observedAt: now,
      items: [listItem()]
    }],
    [BrowserDetailBatchSchema, {
      sequence: 0,
      items: [detailItem()]
    }],
    [BrowserLoadEventSchema, loadEvent({ sequence: 0 })]
  ])("requires positive sequence numbers", (schema, value) => {
    expect(() => schema.parse(value)).toThrow();
  });

  it("accepts the full load-event vocabulary and optional action permit", () => {
    for (const blockingState of [
      "none",
      "login",
      "captcha",
      "rate_limited",
      "error"
    ]) {
      expect(BrowserLoadEventSchema.safeParse(loadEvent({
        blockingState,
        visibleTotalCount: null,
        actionPermit: "permit"
      })).success).toBe(true);
    }
  });

  it.each([
    { observedUniqueCount: 2001 },
    { newItemCount: 2001 },
    { visibleTotalCount: 2001 },
    { actionPermit: "x".repeat(129) }
  ])("rejects an out-of-range load event", (override) => {
    expect(() =>
      BrowserLoadEventSchema.parse(loadEvent(override))
    ).toThrow();
  });
});

function largestChineseListBatch() {
  const empty = {
    sequence: 1,
    observedAt: now,
    items: Array.from({ length: 25 }, (_, index) =>
      listItem({
        sourceListingId: String(1000 + index),
        url:
          `https://www.jiaoyimao.com/jg2007840/${1000 + index}.html`,
        title: "商品",
        rawText: ""
      })
    )
  };
  const baseBytes = Buffer.byteLength(JSON.stringify(empty), "utf8");
  let remainingChars = Math.floor(
    (BROWSER_REFRESH_LIMITS.maxBatchUtf8Bytes - baseBytes) / 3
  );
  const items = empty.items.map((item) => {
    const count = Math.min(
      BROWSER_REFRESH_LIMITS.maxCardTextChars,
      remainingChars
    );
    remainingChars -= count;
    return { ...item, rawText: "猫".repeat(count) };
  });
  return { ...empty, items };
}

function largestChineseDetailBatch() {
  const empty = {
    sequence: 1,
    items: Array.from({ length: 5 }, (_, index) =>
      detailItem({
        sourceListingId: String(2000 + index),
        url:
          `https://www.jiaoyimao.com/jg2007840/${2000 + index}.html`,
        sections: { head: "", report: "", safety: "", description: "" }
      })
    )
  };
  const baseBytes = Buffer.byteLength(JSON.stringify(empty), "utf8");
  let remainingChars = Math.floor(
    (BROWSER_REFRESH_LIMITS.maxBatchUtf8Bytes - baseBytes) / 3
  );
  const items = empty.items.map((item) => {
    let itemChars = Math.min(
      BROWSER_REFRESH_LIMITS.maxCombinedDetailTextChars,
      remainingChars
    );
    remainingChars -= itemChars;
    const sections = {
      head: "",
      report: "",
      safety: "",
      description: ""
    };
    for (const key of Object.keys(sections) as Array<keyof typeof sections>) {
      const count = Math.min(
        BROWSER_REFRESH_LIMITS.maxSectionChars,
        itemChars
      );
      sections[key] = "猫".repeat(count);
      itemChars -= count;
    }
    return { ...item, sections };
  });
  return { ...empty, items };
}

describe("aggregate UTF-8 byte limits", () => {
  it("accepts a multibyte list batch just below 128 KiB and rejects the next Chinese character", () => {
    const boundary = largestChineseListBatch();
    expect(Buffer.byteLength(JSON.stringify(boundary), "utf8"))
      .toBeLessThanOrEqual(BROWSER_REFRESH_LIMITS.maxBatchUtf8Bytes);
    expect(BrowserListBatchSchema.safeParse(boundary).success).toBe(true);

    const oversized = structuredClone(boundary);
    oversized.items[10].rawText += "猫";
    expect(Buffer.byteLength(JSON.stringify(oversized), "utf8"))
      .toBeGreaterThan(BROWSER_REFRESH_LIMITS.maxBatchUtf8Bytes);
    expect(BrowserListBatchSchema.safeParse(oversized).success).toBe(false);
  });

  it("accepts a multibyte detail batch just below 128 KiB and rejects the next Chinese character", () => {
    const boundary = largestChineseDetailBatch();
    expect(Buffer.byteLength(JSON.stringify(boundary), "utf8"))
      .toBeLessThanOrEqual(BROWSER_REFRESH_LIMITS.maxBatchUtf8Bytes);
    expect(BrowserDetailBatchSchema.safeParse(boundary).success).toBe(true);

    const oversized = structuredClone(boundary);
    oversized.items[1].sections.description += "猫";
    expect(Buffer.byteLength(JSON.stringify(oversized), "utf8"))
      .toBeGreaterThan(BROWSER_REFRESH_LIMITS.maxBatchUtf8Bytes);
    expect(BrowserDetailBatchSchema.safeParse(oversized).success).toBe(false);
  });
});
