// @vitest-environment node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  claimJiaoyimaoBrowserJob
} from "../../scripts/jiaoyimao-browser-bridge.mjs";

const jobId = "job-123";
const claimCode = "claim-secret";
const bridgeToken = "bridge-secret";
const filterUrl =
  "https://www.jiaoyimao.com/jg2007840/f8845003-c8845004/o110/";
const observedAt = "2026-07-30T10:00:00.000Z";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
}

function claimResponse() {
  return jsonResponse({
    id: jobId,
    state: "collecting_list",
    bridgeToken
  });
}

function mockFetch(...responses: Array<Response | Error>) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const response of responses) {
    if (response instanceof Error) {
      fetch.mockRejectedValueOnce(response);
    } else {
      fetch.mockResolvedValueOnce(response);
    }
  }
  return fetch;
}

function bodyOf(fetch: ReturnType<typeof mockFetch>, index: number) {
  const body = fetch.mock.calls[index]?.[1]?.body;
  if (typeof body !== "string") {
    throw new Error(`request ${index} did not have a JSON body`);
  }
  return JSON.parse(body) as Record<string, unknown>;
}

function filterProof() {
  return {
    currentUrl: filterUrl,
    gameLabel: "三角洲行动",
    platformLabel: "QQ",
    categoryLabel: "账号",
    m7FilterLabels: ["极品S", "极品A", "极品B", "极品C"],
    observedAt
  };
}

function listBatch() {
  return {
    sequence: 1,
    observedAt,
    items: [
      {
        sourceListingId: "1785384225212552",
        url:
          "https://www.jiaoyimao.com/jg2007840/" +
          "1785384225212552.html",
        title: "测试商品",
        rawText: "商品卡片可见文本",
        priceCny: 4300
      }
    ]
  };
}

function loadEvent() {
  return {
    sequence: 1,
    observedUniqueCount: 1,
    newItemCount: 1,
    visibleTotalCount: null,
    endMarkerVisible: false,
    loadingVisible: false,
    blockingState: "none",
    observedAt
  };
}

function detailBatch() {
  return {
    sequence: 1,
    items: [
      {
        sourceListingId: "1785384225212552",
        url:
          "https://www.jiaoyimao.com/jg2007840/" +
          "1785384225212552.html",
        observedAt,
        sections: {
          head: "商品标题",
          report: "举报信息",
          safety: "安全保障",
          description: "商品描述"
        }
      }
    ]
  };
}

async function claimWith(fetch: ReturnType<typeof mockFetch>) {
  return claimJiaoyimaoBrowserJob({
    jobId,
    claimCode,
    fetch
  });
}

describe("Jiaoyimao Codex browser bridge", () => {
  it("keeps the claimed token only in a closure and uses the default localhost API", async () => {
    const fetch = mockFetch(
      claimResponse(),
      jsonResponse({
        kind: "list",
        nextActionAt: "2026-07-30T10:00:02.000Z",
        cooldownUntil: null,
        actionPermit: "permit-1",
        nextListBatchSequence: 1,
        nextLoadSequence: 1
      })
    );

    const client = await claimWith(fetch);
    const work = await client.getWork();

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:4310/api/browser-refresh/job-123/claim",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ claimCode })
      })
    );
    expect(fetch.mock.calls[0]?.[1]?.headers).not.toHaveProperty(
      "authorization"
    );
    expect(fetch.mock.calls[1]?.[1]?.headers).toMatchObject({
      authorization: `Bearer ${bridgeToken}`
    });
    expect(work).toMatchObject({
      nextActionAt: "2026-07-30T10:00:02.000Z",
      cooldownUntil: null,
      actionPermit: "permit-1"
    });
    expect(JSON.stringify(client)).toBe("{}");
    expect(JSON.stringify(client)).not.toContain(bridgeToken);
    expect(Object.values(client)).not.toContain(bridgeToken);
  });

  it("sends the exact route schemas and Bearer header for every bridge method", async () => {
    const fetch = mockFetch(
      claimResponse(),
      jsonResponse({ state: "collecting_list" }),
      jsonResponse({ acceptedCount: 1 }),
      jsonResponse({
        kind: "list",
        nextActionAt: null,
        cooldownUntil: null,
        actionPermit: "list-permit"
      }),
      jsonResponse({ acceptedCount: 1 }),
      jsonResponse({
        kind: "detail",
        nextActionAt: null,
        cooldownUntil: null,
        actionPermit: "detail-permit"
      }),
      jsonResponse({ acceptedCount: 1 }),
      jsonResponse({ state: "paused" }),
      jsonResponse({ state: "collecting_details" }),
      jsonResponse({
        state: "cooling_down",
        cooldownUntil: "2026-07-30T10:00:30.000Z"
      }),
      jsonResponse({ state: "success" })
    );
    const client = await claimWith(fetch);

    await client.submitFilterProof(filterProof());
    await client.submitListBatch(listBatch());
    await client.getWork();
    await client.submitLoadEvent(loadEvent());
    await client.getWork();
    await client.submitDetails(detailBatch());
    await client.pause({
      reason: "captcha_required",
      message: "等待用户完成验证"
    });
    await client.resume();
    await client.startCooldown();
    await client.complete();

    const expectedPaths = [
      "filter-proof",
      "list-batches",
      "work",
      "load-events",
      "work",
      "details",
      "pause",
      "resume",
      "cooldown",
      "complete"
    ];
    expect(
      fetch.mock.calls.slice(1).map(([url]) =>
        String(url).split("/").at(-1)
      )
    ).toEqual(expectedPaths);
    for (const [, init] of fetch.mock.calls.slice(1)) {
      expect(init?.headers).toMatchObject({
        authorization: `Bearer ${bridgeToken}`
      });
    }
    expect(bodyOf(fetch, 1)).toEqual(filterProof());
    expect(bodyOf(fetch, 2)).toEqual(listBatch());
    expect(bodyOf(fetch, 4)).toEqual({
      ...loadEvent(),
      actionPermit: "list-permit"
    });
    expect(bodyOf(fetch, 6)).toEqual({
      ...detailBatch(),
      actionPermit: "detail-permit"
    });
    expect(bodyOf(fetch, 7)).toEqual({
      reason: "captcha_required",
      message: "等待用户完成验证"
    });
    expect(bodyOf(fetch, 8)).toEqual({});
    expect(bodyOf(fetch, 9)).toEqual({ reason: "rate_limited" });
    expect(bodyOf(fetch, 10)).toEqual({});
  });

  it("uses a permit only for its matching outcome and clears it after a failed attempt", async () => {
    const fetch = mockFetch(
      claimResponse(),
      jsonResponse({
        kind: "detail",
        nextActionAt: null,
        cooldownUntil: null,
        actionPermit: "detail-only"
      }),
      jsonResponse({ acceptedCount: 1 }),
      jsonResponse(
        {
          error: "action_too_early",
          message: "尚未到下一次浏览器操作时间"
        },
        409
      ),
      jsonResponse({ acceptedCount: 1 }),
      jsonResponse({ acceptedCount: 1 })
    );
    const client = await claimWith(fetch);

    await client.getWork();
    await client.submitLoadEvent(loadEvent());
    await expect(client.submitDetails(detailBatch())).rejects.toMatchObject({
      code: "action_too_early"
    });
    await client.submitDetails({
      ...detailBatch(),
      sequence: 2
    });
    await client.submitLoadEvent({
      ...loadEvent(),
      sequence: 2
    });

    expect(bodyOf(fetch, 2)).not.toHaveProperty("actionPermit");
    expect(bodyOf(fetch, 3)).toHaveProperty(
      "actionPermit",
      "detail-only"
    );
    expect(bodyOf(fetch, 4)).not.toHaveProperty("actionPermit");
    expect(bodyOf(fetch, 5)).not.toHaveProperty("actionPermit");
  });

  it("rejects unknown or sensitive fields before serializing or fetching", async () => {
    const fetch = mockFetch(claimResponse());
    const client = await claimWith(fetch);

    await expect(
      client.submitFilterProof({
        ...filterProof(),
        cookie: "session=secret"
      })
    ).rejects.toMatchObject({ code: "invalid_bridge_payload" });
    await expect(
      client.submitListBatch({
        ...listBatch(),
        items: [
          {
            ...listBatch().items[0],
            localStorage: { token: "secret" }
          }
        ]
      })
    ).rejects.toMatchObject({ code: "invalid_bridge_payload" });
    await expect(
      client.resume({
        password: "secret",
        captchaAnswer: "1234",
        authorization: "Bearer network-secret"
      })
    ).rejects.toMatchObject({ code: "invalid_bridge_payload" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(fetch.mock.calls)).not.toContain(
      "session=secret"
    );
    expect(JSON.stringify(fetch.mock.calls)).not.toContain(
      "network-secret"
    );
  });

  it("accepts Z and legal offset timestamps in outgoing schemas", async () => {
    const fetch = mockFetch(
      claimResponse(),
      jsonResponse({ state: "collecting_list" }),
      jsonResponse({ acceptedCount: 1 })
    );
    const client = await claimWith(fetch);

    await client.submitFilterProof({
      ...filterProof(),
      observedAt: "2026-07-30T10:00:00Z"
    });
    await client.submitListBatch({
      ...listBatch(),
      observedAt: "2026-07-30T18:00:00+08:00"
    });

    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([
    "2026-07-30T10:00:00",
    "2026-02-30T10:00:00Z",
    "2026-07-30 10:00:00Z",
    "2026-07-30T10:00:00+25:00"
  ])("rejects non-server ISO timestamp %s before fetch", async (timestamp) => {
    const fetch = mockFetch(claimResponse());
    const client = await claimWith(fetch);

    await expect(
      client.submitFilterProof({
        ...filterProof(),
        observedAt: timestamp
      })
    ).rejects.toMatchObject({ code: "invalid_bridge_payload" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("applies offset timestamp validation to every outgoing timestamp field", async () => {
    const fetch = mockFetch(claimResponse());
    const client = await claimWith(fetch);
    const withoutOffset = "2026-07-30T10:00:00";

    await expect(
      client.submitListBatch({
        ...listBatch(),
        observedAt: withoutOffset
      })
    ).rejects.toMatchObject({ code: "invalid_bridge_payload" });
    await expect(
      client.submitLoadEvent({
        ...loadEvent(),
        observedAt: withoutOffset
      })
    ).rejects.toMatchObject({ code: "invalid_bridge_payload" });
    await expect(
      client.submitDetails({
        ...detailBatch(),
        items: detailBatch().items.map((item) => ({
          ...item,
          observedAt: withoutOffset
        }))
      })
    ).rejects.toMatchObject({ code: "invalid_bridge_payload" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects comments, DOCTYPE, and CDATA from every visible-text family before fetch", async () => {
    const fetch = mockFetch(claimResponse());
    const client = await claimWith(fetch);
    const markup = [
      "<!--hidden-->",
      "<!DOCTYPE html>",
      "<![CDATA[secret]]>"
    ];
    const invalidProofs = [
      { ...filterProof(), gameLabel: markup[0] },
      { ...filterProof(), platformLabel: markup[1] },
      { ...filterProof(), categoryLabel: markup[2] },
      {
        ...filterProof(),
        m7FilterLabels: [
          markup[0],
          ...filterProof().m7FilterLabels.slice(1)
        ]
      }
    ];
    for (const proof of invalidProofs) {
      await expect(
        client.submitFilterProof(proof)
      ).rejects.toMatchObject({ code: "invalid_bridge_payload" });
    }

    for (const item of [
      { ...listBatch().items[0], title: markup[0] },
      { ...listBatch().items[0], rawText: markup[1] }
    ]) {
      await expect(
        client.submitListBatch({
          ...listBatch(),
          items: [item]
        })
      ).rejects.toMatchObject({ code: "invalid_bridge_payload" });
    }

    const sectionNames = [
      "head",
      "report",
      "safety",
      "description"
    ] as const;
    for (const [index, sectionName] of sectionNames.entries()) {
      const item = detailBatch().items[0];
      await expect(
        client.submitDetails({
          ...detailBatch(),
          items: [
            {
              ...item,
              sections: {
                ...item.sections,
                [sectionName]: markup[index % markup.length]
              }
            }
          ]
        })
      ).rejects.toMatchObject({ code: "invalid_bridge_payload" });
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("exposes only stable HTTP error fields and never retries by itself", async () => {
    const fetch = mockFetch(
      claimResponse(),
      jsonResponse(
        {
          error: "staging_invalid",
          message: "浏览器采集数据无效",
          bridgeToken: "response-credential",
          body: { password: "response-password" }
        },
        409
      ),
      jsonResponse({ kind: "list" })
    );
    const client = await claimWith(fetch);

    let failure: unknown;
    try {
      await client.submitListBatch(listBatch());
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: "staging_invalid",
      message: "浏览器采集数据无效"
    });
    expect(JSON.stringify(failure)).not.toContain("response-credential");
    expect(JSON.stringify(failure)).not.toContain("response-password");
    expect(fetch).toHaveBeenCalledTimes(2);
    await client.getWork();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("clears the token after a terminal error", async () => {
    const fetch = mockFetch(
      claimResponse(),
      jsonResponse(
        {
          error: "bridge_unauthorized",
          message: `expired ${bridgeToken}`,
          bridgeToken
        },
        401
      )
    );
    const client = await claimWith(fetch);

    let terminal: unknown;
    try {
      await client.getWork();
    } catch (error) {
      terminal = error;
    }
    expect(terminal).toMatchObject({
      code: "bridge_unauthorized"
    });
    expect(JSON.stringify(terminal)).not.toContain(bridgeToken);
    await expect(client.getWork()).rejects.toMatchObject({
      code: "bridge_client_closed"
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(["complete", "cancel"] as const)(
    "clears the token after successful %s",
    async (method) => {
      const fetch = mockFetch(
        claimResponse(),
        jsonResponse({
          state: method === "complete" ? "success" : "cancelled"
        })
      );
      const client = await claimWith(fetch);

      await client[method]();

      await expect(client.getWork()).rejects.toMatchObject({
        code: "bridge_client_closed"
      });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(String(fetch.mock.calls[1]?.[0])).toContain(
        method === "complete"
          ? `/api/browser-refresh/${jobId}/complete`
          : `/api/sources/jiaoyimao/browser-refresh/${jobId}/cancel`
      );
    }
  );

  it.each(["complete", "cancel"] as const)(
    "clears the token after failed %s",
    async (method) => {
      const fetch = mockFetch(
        claimResponse(),
        jsonResponse(
          {
            error: "invalid_transition",
            message: "当前任务状态不允许此操作"
          },
          409
        )
      );
      const client = await claimWith(fetch);

      await expect(client[method]()).rejects.toMatchObject({
        code: "invalid_transition"
      });
      await expect(client.getWork()).rejects.toMatchObject({
        code: "bridge_client_closed"
      });
      expect(fetch).toHaveBeenCalledTimes(2);
    }
  );

  it("waits once for the latest server timestamp and performs no request or retry", async () => {
    const fetch = mockFetch(claimResponse());
    const client = await claimWith(fetch);
    const wait = vi.fn(async (_milliseconds: number) => {});

    const waited = await client.waitUntilAllowed(
      {
        nextActionAt: "2026-07-30T10:00:02.500Z",
        cooldownUntil: "2026-07-30T10:00:30.000Z"
      },
      () => Date.parse("2026-07-30T10:00:00.000Z"),
      wait
    );

    expect(waited).toBe(30_000);
    expect(wait).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledWith(30_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("Jiaoyimao browser refresh runbook", () => {
  it("documents exactly ten ordered safe steps and authoritative delays", async () => {
    const path = resolve(
      process.cwd(),
      "docs/jiaoyimao-browser-refresh-runbook.md"
    );
    const runbook = await readFile(path, "utf8");
    const steps = [...runbook.matchAll(/^(\d+)\. /gm)].map(
      (match) => Number(match[1])
    );

    expect(steps).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(runbook).toContain("浏览器控制运行时");
    expect(runbook).toContain("jiaoyimao-browser-bridge.mjs");
    expect(runbook).toContain("复用");
    expect(runbook).toContain("精确筛选");
    expect(runbook).toMatch(/登录.*CAPTCHA|CAPTCHA.*登录/);
    expect(runbook).toContain("getWork");
    expect(runbook).toContain("nextActionAt");
    expect(runbook).toContain("cooldownUntil");
    expect(runbook).toContain("1,200–2,500 ms");
    expect(runbook).toContain("2,000–3,500 ms");
    expect(runbook).toMatch(/30 秒.*2 分钟.*5 分钟.*15 分钟/s);
    expect(runbook).toContain("硬编码循环");
    expect(runbook).toMatch(
      /永不.*cookies.*localStorage.*密码.*CAPTCHA 答案.*网络认证请求头/s
    );
  });
});
