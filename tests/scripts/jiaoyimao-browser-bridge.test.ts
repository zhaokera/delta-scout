// @vitest-environment node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  claimJiaoyimaoBrowserJob
} from "../../scripts/jiaoyimao-browser-bridge.mjs";

const jobId = "job-123";
const claimCode = "claim-secret";
const bridgeToken = "bridge-secret";
const filterUrl =
  "https://www.jiaoyimao.com/jg2007840/f8845003-c8845004/o110/";
const qqFilterUrl =
  "https://www.jiaoyimao.com/jg2007840/f8845003-c8845004/" +
  "o1687157900084320/?searchCondition=%7B%7D&enforcePlat=2&newPage=true";
const observedAt = "2026-07-30T10:00:00.000Z";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
}

function crossRealmValue<T>(value: T): T {
  return runInNewContext(
    "JSON.parse(serialized)",
    { serialized: JSON.stringify(value) }
  ) as T;
}

function valueResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as Response;
}

function crossRealmJsonResponse(
  body: unknown,
  status = 200
): Response {
  return valueResponse(crossRealmValue(body), status);
}

function claimResponse() {
  return jsonResponse({
    id: jobId,
    state: "collecting_list",
    bridgeToken
  });
}

function acceptedListResponse() {
  return jsonResponse({
    acceptedCount: 1,
    uniqueItemCount: 1,
    nextSequence: 2
  });
}

function acceptedLoadResponse(sequence = 2) {
  return jsonResponse({
    acceptedCount: 1,
    loadActionCount: sequence - 1,
    nextSequence: sequence
  });
}

function acceptedDetailResponse() {
  return jsonResponse({
    acceptedCount: 1,
    detailCompletedCount: 1,
    detailRequiredCount: 1,
    nextSourceListingId: null,
    nextSequence: 2
  });
}

function completedResponse() {
  return jsonResponse({
    state: "success",
    scanRunId: 1,
    publishedRunId: 1
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
    m7FilterLabels: ["极品S", "极品A", "极品B", "极品C", "优品S"],
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
  it("accepts cross-realm claim, work, and ordinary JSON while keeping credentials private", async () => {
    const fetch = mockFetch(
      crossRealmJsonResponse({
        id: jobId,
        state: "collecting_list",
        bridgeToken
      }),
      crossRealmJsonResponse({
        kind: "list",
        nextActionAt: null,
        cooldownUntil: null,
        actionPermit: "cross-realm-permit",
        nextListBatchSequence: 1,
        nextLoadSequence: 1
      }),
      crossRealmJsonResponse({
        acceptedCount: 1,
        uniqueItemCount: 1,
        nextSequence: 2
      })
    );

    const client = await claimWith(fetch);
    const work = await client.getWork();
    const accepted = await client.submitListBatch(listBatch());

    expect(work).toEqual({
      kind: "list",
      nextActionAt: null,
      cooldownUntil: null,
      actionPermitAvailable: true,
      nextListBatchSequence: 1,
      nextLoadSequence: 1
    });
    expect(accepted).toEqual({
      acceptedCount: 1,
      uniqueItemCount: 1,
      nextSequence: 2
    });
    expect(work).not.toHaveProperty("actionPermit");
    expect(JSON.stringify(work)).not.toContain("cross-realm-permit");
    expect(JSON.stringify(client)).not.toContain(bridgeToken);
    expect(Object.values(client)).not.toContain(bridgeToken);
  });

  it("accepts cross-realm claim options and validated outgoing input", async () => {
    const fetch = mockFetch(
      crossRealmJsonResponse({
        id: jobId,
        state: "collecting_list",
        bridgeToken
      }),
      acceptedListResponse()
    );
    const options = runInNewContext(
      "({ jobId, claimCode, fetch })",
      { jobId, claimCode, fetch }
    ) as Parameters<typeof claimJiaoyimaoBrowserJob>[0];
    const crossRealmBatch = crossRealmValue(listBatch());

    const client = await claimJiaoyimaoBrowserJob(options);
    const accepted = await client.submitListBatch(crossRealmBatch);

    expect(accepted).toEqual({
      acceptedCount: 1,
      uniqueItemCount: 1,
      nextSequence: 2
    });
    expect(bodyOf(fetch, 1)).toEqual(listBatch());
  });

  it("accepts a null-prototype JSON object without exposing its bridge token", async () => {
    const payload = Object.assign(Object.create(null), {
      id: jobId,
      state: "collecting_list",
      bridgeToken
    });
    const fetch = mockFetch(valueResponse(payload));

    const client = await claimWith(fetch);

    expect(JSON.stringify(client)).toBe("{}");
    expect(JSON.stringify(client)).not.toContain(bridgeToken);
    expect(Object.values(client)).not.toContain(bridgeToken);
  });

  it.each([
    {
      name: "array",
      payload: [{
        id: jobId,
        state: "collecting_list",
        bridgeToken
      }]
    },
    {
      name: "Date",
      payload: new Date("2026-07-30T10:00:00.000Z")
    },
    {
      name: "class instance",
      payload: runInNewContext(
        "Object.assign(new (class ClaimPayload {})(), value)",
        {
          value: {
            id: jobId,
            state: "collecting_list",
            bridgeToken
          }
        }
      ) as unknown
    },
    {
      name: "custom prototype",
      payload: Object.assign(Object.create({ inherited: true }), {
        id: jobId,
        state: "collecting_list",
        bridgeToken
      })
    },
    {
      name: "throwing Proxy",
      payload: new Proxy(
        {
          id: jobId,
          state: "collecting_list",
          bridgeToken
        },
        {
          getPrototypeOf() {
            throw new Error("proxy-trap-secret");
          }
        }
      )
    }
  ])("rejects a $name server payload without leaking credentials", async ({
    payload
  }) => {
    const fetch = mockFetch(valueResponse(payload));

    let failure: unknown;
    try {
      await claimWith(fetch);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: "invalid_server_response" });
    expect(JSON.stringify(failure)).not.toContain(bridgeToken);
    expect(JSON.stringify(failure)).not.toContain("proxy-trap-secret");
  });

  it.each([
    {
      name: "recursive sensitive field",
      payload: {
        id: jobId,
        state: "collecting_list",
        bridgeToken,
        nested: {
          credential: "cross-realm-response-secret"
        }
      }
    },
    {
      name: "malformed claim identity",
      payload: {
        id: "wrong-job",
        state: "collecting_list",
        bridgeToken
      }
    }
  ])("rejects a cross-realm $name response fail-closed", async ({
    payload
  }) => {
    const fetch = mockFetch(crossRealmJsonResponse(payload));

    let failure: unknown;
    try {
      await claimWith(fetch);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: "invalid_server_response" });
    expect(JSON.stringify(failure)).not.toContain(bridgeToken);
    expect(JSON.stringify(failure)).not.toContain(
      "cross-realm-response-secret"
    );
  });

  it("rejects exceptional cross-realm outgoing options before fetch", async () => {
    const fetch = mockFetch(claimResponse());
    const options = runInNewContext(
      `new Proxy(
        { jobId, claimCode, fetch },
        {
          getPrototypeOf() {
            throw new Error("outgoing-proxy-secret");
          }
        }
      )`,
      { jobId, claimCode, fetch }
    ) as Parameters<typeof claimJiaoyimaoBrowserJob>[0];

    let failure: unknown;
    try {
      await claimJiaoyimaoBrowserJob(options);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: "invalid_bridge_payload" });
    expect(JSON.stringify(failure)).not.toContain("outgoing-proxy-secret");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "extra schema field",
      batch: {
        ...listBatch(),
        debug: "not-allowed"
      }
    },
    {
      name: "recursive sensitive field",
      batch: {
        ...listBatch(),
        items: [{
          ...listBatch().items[0],
          nested: {
            authorization: "cross-realm-outgoing-secret"
          }
        }]
      }
    }
  ])("rejects a cross-realm outgoing $name before fetch", async ({
    batch
  }) => {
    const fetch = mockFetch(claimResponse());
    const client = await claimWith(fetch);

    let failure: unknown;
    try {
      await client.submitListBatch(crossRealmValue(batch));
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: "invalid_bridge_payload" });
    expect(JSON.stringify(failure)).not.toContain(
      "cross-realm-outgoing-secret"
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the claimed token only in a closure and uses the default localhost API", async () => {
    const fetch = mockFetch(
      claimResponse(),
      jsonResponse({
        kind: "list",
        nextActionAt: "2026-07-30T10:00:02.000Z",
        cooldownUntil: null,
        actionPermit: "permit-1",
        nextListBatchSequence: 1,
        nextLoadSequence: 1,
        debugInfo: "server-internal"
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
      actionPermitAvailable: true
    });
    expect(work).not.toHaveProperty("actionPermit");
    expect(work).not.toHaveProperty("debugInfo");
    expect(JSON.stringify(work)).not.toContain("permit-1");
    expect(JSON.stringify(client)).toBe("{}");
    expect(JSON.stringify(client)).not.toContain(bridgeToken);
    expect(Object.values(client)).not.toContain(bridgeToken);
  });

  it.each([
    "http://127.0.0.1",
    "http://127.0.0.1:4310",
    "http://localhost",
    "http://localhost:9999",
    "http://[::1]",
    "http://[::1]:4310"
  ])("allows loopback bridge origin %s", async (baseUrl) => {
    const fetch = mockFetch(claimResponse());

    await claimJiaoyimaoBrowserJob({
      jobId,
      claimCode,
      baseUrl,
      fetch
    });

    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      `${baseUrl}/api/browser-refresh/${jobId}/claim`
    );
  });

  it.each([
    "https://127.0.0.1:4310",
    "http://example.com:4310",
    "http://0.0.0.0:4310",
    "http://user:pass@127.0.0.1:4310",
    "http://127.0.0.1:4310/api",
    "http://127.0.0.1:4310/?query=1",
    "http://127.0.0.1:4310/#fragment"
  ])("rejects non-loopback bridge URL %s before claim", async (baseUrl) => {
    const fetch = mockFetch(claimResponse());

    await expect(
      claimJiaoyimaoBrowserJob({
        jobId,
        claimCode,
        baseUrl,
        fetch
      })
    ).rejects.toMatchObject({ code: "invalid_bridge_payload" });

    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends the exact route schemas and Bearer header for every bridge method", async () => {
    const fetch = mockFetch(
      claimResponse(),
      jsonResponse({ state: "collecting_list" }),
      acceptedListResponse(),
      jsonResponse({
        kind: "list",
        nextActionAt: null,
        cooldownUntil: null,
        actionPermit: "list-permit",
        nextListBatchSequence: 2,
        nextLoadSequence: 1
      }),
      acceptedLoadResponse(),
      jsonResponse({
        kind: "detail",
        nextActionAt: null,
        cooldownUntil: null,
        actionPermit: "detail-permit",
        sourceListingId: "1785384225212552",
        url:
          "https://www.jiaoyimao.com/jg2007840/" +
          "1785384225212552.html",
        nextDetailSequence: 1
      }),
      acceptedDetailResponse(),
      jsonResponse({ state: "paused" }),
      jsonResponse({ state: "collecting_details" }),
      jsonResponse({
        state: "cooling_down",
        cooldownUntil: "2026-07-30T10:00:30.000Z"
      }),
      completedResponse()
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

  it("uses a permit only for its matching outcome and clears it after success", async () => {
    const fetch = mockFetch(
      claimResponse(),
      jsonResponse({
        kind: "detail",
        nextActionAt: null,
        cooldownUntil: null,
        actionPermit: "detail-only",
        sourceListingId: "1785384225212552",
        url:
          "https://www.jiaoyimao.com/jg2007840/" +
          "1785384225212552.html",
        nextDetailSequence: 1
      }),
      acceptedLoadResponse(),
      jsonResponse(
        {
          error: "action_too_early",
          message: "尚未到下一次浏览器操作时间"
        },
        409
      ),
      acceptedDetailResponse(),
      acceptedLoadResponse(3)
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
    expect(bodyOf(fetch, 4)).toHaveProperty(
      "actionPermit",
      "detail-only"
    );
    expect(bodyOf(fetch, 5)).not.toHaveProperty("actionPermit");
  });

  it("preserves a matching permit across ambiguous and nonterminal failures", async () => {
    const fetch = mockFetch(
      claimResponse(),
      jsonResponse({
        kind: "list",
        nextActionAt: null,
        cooldownUntil: null,
        actionPermit: "retryable-list-permit",
        nextListBatchSequence: 1,
        nextLoadSequence: 1
      }),
      new Error("connection reset"),
      jsonResponse(
        {
          error: "action_too_early",
          message: "尚未到下一次浏览器操作时间"
        },
        409
      ),
      jsonResponse(
        {
          error: "staging_invalid",
          message: "浏览器采集数据无效"
        },
        409
      ),
      acceptedLoadResponse(5),
      acceptedLoadResponse(6)
    );
    const client = await claimWith(fetch);

    await client.getWork();
    await expect(
      client.submitLoadEvent(loadEvent())
    ).rejects.toMatchObject({ code: "browser_bridge_network_error" });
    await expect(
      client.submitLoadEvent({ ...loadEvent(), sequence: 2 })
    ).rejects.toMatchObject({ code: "action_too_early" });
    await expect(
      client.submitLoadEvent({ ...loadEvent(), sequence: 3 })
    ).rejects.toMatchObject({ code: "staging_invalid" });
    await client.submitLoadEvent({ ...loadEvent(), sequence: 4 });
    await client.submitLoadEvent({ ...loadEvent(), sequence: 5 });

    for (const index of [2, 3, 4, 5]) {
      expect(bodyOf(fetch, index)).toHaveProperty(
        "actionPermit",
        "retryable-list-permit"
      );
    }
    expect(bodyOf(fetch, 6)).not.toHaveProperty("actionPermit");
  });

  it("clears a matching permit when the server explicitly rejects it", async () => {
    const fetch = mockFetch(
      claimResponse(),
      jsonResponse({
        kind: "list",
        nextActionAt: null,
        cooldownUntil: null,
        actionPermit: "invalid-list-permit",
        nextListBatchSequence: 1,
        nextLoadSequence: 1
      }),
      jsonResponse(
        {
          error: "action_permit_invalid",
          message: "浏览器操作许可无效"
        },
        409
      ),
      acceptedLoadResponse(3)
    );
    const client = await claimWith(fetch);

    await client.getWork();
    await expect(
      client.submitLoadEvent(loadEvent())
    ).rejects.toMatchObject({ code: "action_permit_invalid" });
    await client.submitLoadEvent({ ...loadEvent(), sequence: 2 });

    expect(bodyOf(fetch, 2)).toHaveProperty(
      "actionPermit",
      "invalid-list-permit"
    );
    expect(bodyOf(fetch, 3)).not.toHaveProperty("actionPermit");
  });

  it("rejects a malformed 2xx outcome and still consumes its permit", async () => {
    const fetch = mockFetch(
      claimResponse(),
      jsonResponse({
        kind: "list",
        nextActionAt: null,
        cooldownUntil: null,
        actionPermit: "confirmed-list-permit",
        nextListBatchSequence: 1,
        nextLoadSequence: 1
      }),
      jsonResponse({ acceptedCount: 1 }),
      acceptedLoadResponse(3)
    );
    const client = await claimWith(fetch);

    await client.getWork();
    await expect(
      client.submitLoadEvent(loadEvent())
    ).rejects.toMatchObject({ code: "invalid_server_response" });
    await client.submitLoadEvent({ ...loadEvent(), sequence: 2 });

    expect(bodyOf(fetch, 2)).toHaveProperty(
      "actionPermit",
      "confirmed-list-permit"
    );
    expect(bodyOf(fetch, 3)).not.toHaveProperty("actionPermit");
  });

  it("rejects a 2xx outcome containing an unexpected action permit without exposing it", async () => {
    const fetch = mockFetch(
      claimResponse(),
      jsonResponse({
        kind: "list",
        nextActionAt: null,
        cooldownUntil: null,
        actionPermit: "request-action-permit",
        nextListBatchSequence: 1,
        nextLoadSequence: 1
      }),
      jsonResponse({
        acceptedCount: 1,
        loadActionCount: 1,
        nextSequence: 2,
        actionPermit: "unexpected-response-permit"
      }),
      acceptedLoadResponse(3)
    );
    const client = await claimWith(fetch);

    await client.getWork();
    let failure: unknown;
    try {
      await client.submitLoadEvent(loadEvent());
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "invalid_server_response"
    });
    expect(JSON.stringify(failure)).not.toContain(
      "unexpected-response-permit"
    );

    await client.submitLoadEvent({ ...loadEvent(), sequence: 2 });
    expect(bodyOf(fetch, 2)).toHaveProperty(
      "actionPermit",
      "request-action-permit"
    );
    expect(bodyOf(fetch, 3)).not.toHaveProperty("actionPermit");
  });

  it("rebuilds non-work success responses from their public whitelist", async () => {
    const fetch = mockFetch(
      claimResponse(),
      jsonResponse({
        acceptedCount: 1,
        uniqueItemCount: 1,
        nextSequence: 2,
        debugInfo: "server-internal"
      })
    );
    const client = await claimWith(fetch);

    await expect(
      client.submitListBatch(listBatch())
    ).resolves.toEqual({
      acceptedCount: 1,
      uniqueItemCount: 1,
      nextSequence: 2
    });
  });

  it("redacts pending permits echoed by HTTP and network errors while preserving retry state", async () => {
    const pendingPermit = "pending-permit-must-not-leak";
    const fetch = mockFetch(
      claimResponse(),
      jsonResponse({
        kind: "list",
        nextActionAt: null,
        cooldownUntil: null,
        actionPermit: pendingPermit,
        nextListBatchSequence: 1,
        nextLoadSequence: 1
      }),
      jsonResponse(
        {
          error: "staging_invalid",
          message: `invalid outcome for ${pendingPermit}`
        },
        409
      ),
      new Error(`socket reset for ${pendingPermit}`),
      acceptedLoadResponse(4)
    );
    const client = await claimWith(fetch);

    await client.getWork();
    for (const [sequence, code] of [
      [1, "staging_invalid"],
      [2, "browser_bridge_network_error"]
    ] as const) {
      let failure: unknown;
      try {
        await client.submitLoadEvent({
          ...loadEvent(),
          sequence
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code });
      expect(JSON.stringify(failure)).not.toContain(pendingPermit);
      expect((failure as Error).message).toBe("浏览器桥接请求失败");
    }

    await client.submitLoadEvent({ ...loadEvent(), sequence: 3 });
    for (const index of [2, 3, 4]) {
      expect(bodyOf(fetch, index)).toHaveProperty(
        "actionPermit",
        pendingPermit
      );
    }
  });

  it("redacts a pending permit before a terminal error clears it", async () => {
    const pendingPermit = "terminal-pending-permit";
    const fetch = mockFetch(
      claimResponse(),
      jsonResponse({
        kind: "list",
        nextActionAt: null,
        cooldownUntil: null,
        actionPermit: pendingPermit,
        nextListBatchSequence: 1,
        nextLoadSequence: 1
      }),
      jsonResponse(
        {
          error: "bridge_unauthorized",
          message: `expired ${pendingPermit}`
        },
        401
      )
    );
    const client = await claimWith(fetch);

    await client.getWork();
    let failure: unknown;
    try {
      await client.submitLoadEvent(loadEvent());
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: "bridge_unauthorized",
      message: "浏览器桥接请求失败"
    });
    expect(JSON.stringify(failure)).not.toContain(pendingPermit);
    await expect(client.getWork()).rejects.toMatchObject({
      code: "bridge_client_closed"
    });
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
    await expect(
      client.submitFilterProof({
        ...filterProof(),
        nested: {
          claimCode: "claim",
          bridgeToken: "bridge",
          credential: "credential",
          secret: "secret"
        }
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
      acceptedListResponse()
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

  it("accepts the live QQ category URL but rejects unknown category paths", async () => {
    const fetch = mockFetch(
      claimResponse(),
      jsonResponse({ state: "collecting_list" })
    );
    const client = await claimWith(fetch);

    await client.submitFilterProof({
      ...filterProof(),
      currentUrl: qqFilterUrl
    });

    expect(bodyOf(fetch, 1).currentUrl).toBe(qqFilterUrl);
    await expect(
      client.submitFilterProof({
        ...filterProof(),
        currentUrl:
          "https://www.jiaoyimao.com/" +
          "jg2007840/f8845003-c8845004/o999/"
      })
    ).rejects.toMatchObject({ code: "invalid_bridge_payload" });
    expect(fetch).toHaveBeenCalledTimes(2);
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
      jsonResponse({
        kind: "list",
        nextActionAt: null,
        cooldownUntil: null,
        nextListBatchSequence: 2,
        nextLoadSequence: 1
      })
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

  it("rejects sensitive fields in successful server responses", async () => {
    const fetch = mockFetch(
      claimResponse(),
      jsonResponse({
        kind: "list",
        nextActionAt: null,
        cooldownUntil: null,
        nextListBatchSequence: 1,
        nextLoadSequence: 1,
        credential: "response-credential"
      })
    );
    const client = await claimWith(fetch);

    let failure: unknown;
    try {
      await client.getWork();
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: "invalid_server_response"
    });
    expect(JSON.stringify(failure)).not.toContain(
      "response-credential"
    );
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
        method === "complete"
          ? completedResponse()
          : jsonResponse({ state: "cancelled" })
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
    "preserves the token after nonterminal failed %s",
    async (method) => {
      const fetch = mockFetch(
        claimResponse(),
        jsonResponse(
          {
            error: "invalid_transition",
            message: "当前任务状态不允许此操作"
          },
          409
        ),
        jsonResponse({
          kind: "list",
          nextActionAt: null,
          cooldownUntil: null,
          nextListBatchSequence: 1,
          nextLoadSequence: 1
        })
      );
      const client = await claimWith(fetch);

      await expect(client[method]()).rejects.toMatchObject({
        code: "invalid_transition"
      });
      await expect(client.getWork()).resolves.toMatchObject({
        kind: "list"
      });
      expect(fetch).toHaveBeenCalledTimes(3);
    }
  );

  it.each(["complete", "cancel"] as const)(
    "preserves the token after network failure during %s",
    async (method) => {
      const fetch = mockFetch(
        claimResponse(),
        new Error("connection reset"),
        jsonResponse({
          kind: "list",
          nextActionAt: null,
          cooldownUntil: null,
          nextListBatchSequence: 1,
          nextLoadSequence: 1
        })
      );
      const client = await claimWith(fetch);

      await expect(client[method]()).rejects.toMatchObject({
        code: "browser_bridge_network_error"
      });
      await expect(client.getWork()).resolves.toMatchObject({
        kind: "list"
      });
      expect(fetch).toHaveBeenCalledTimes(3);
    }
  );

  it.each(["complete", "cancel"] as const)(
    "clears the token after explicit terminal response during %s",
    async (method) => {
      const fetch = mockFetch(
        claimResponse(),
        jsonResponse(
          {
            error: "invalid_transition",
            message: "任务已经终止",
            state: "failed"
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
    expect(wait).toHaveBeenCalledWith(30_000, undefined);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not wait when the authoritative deadline has elapsed", async () => {
    const fetch = mockFetch(claimResponse());
    const client = await claimWith(fetch);
    const wait = vi.fn(async (_milliseconds: number) => {});

    const waited = await client.waitUntilAllowed(
      {
        nextActionAt: "2026-07-30T09:59:59.000Z",
        cooldownUntil: null
      },
      () => Date.parse("2026-07-30T10:00:00.000Z"),
      wait
    );

    expect(waited).toBe(0);
    expect(wait).not.toHaveBeenCalled();
  });

  it("cancels the default timer through AbortSignal with a stable error", async () => {
    const fetch = mockFetch(claimResponse());
    const client = await claimWith(fetch);
    const controller = new AbortController();

    const waiting = client.waitUntilAllowed(
      {
        nextActionAt: "2026-07-30T10:15:00.000Z",
        cooldownUntil: null
      },
      () => Date.parse("2026-07-30T10:00:00.000Z"),
      undefined,
      controller.signal
    );
    controller.abort();

    await expect(waiting).rejects.toMatchObject({
      code: "browser_wait_aborted",
      message: "浏览器等待已取消"
    });
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
    expect(runbook).toMatch(/仅.*新增商品.*submitListBatch/s);
    expect(runbook).toMatch(/每轮.*submitLoadEvent/s);
    expect(runbook).toMatch(/自然末页.*不.*空.*submitListBatch/s);
    expect(runbook).toMatch(/不得.*记录.*action permit/i);
    expect(runbook).toMatch(
      /永不.*cookies.*localStorage.*密码.*CAPTCHA 答案.*网络认证请求头/s
    );
  });
});
