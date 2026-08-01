// @vitest-environment node
import { request as nodeRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync, gunzipSync } from "node:zlib";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type {
  Eligibility,
  Listing,
  SourceId
} from "../../src/domain/listing.js";
import type { ReviewedListing } from "../../src/domain/manualReview.js";
import { createApp } from "../../src/server/app.js";
import {
  BROWSER_REFRESH_LIMITS,
  type BrowserFilterProof,
  type BrowserListBatch
} from "../../src/server/browserRefresh/contracts.js";
import {
  BrowserRefreshRepository
} from "../../src/server/browserRefresh/repository.js";
import {
  JiaoyimaoBrowserTaskService
} from "../../src/server/browserRefresh/service.js";
import { createDatabase } from "../../src/server/db.js";
import {
  RefreshAdmissionController
} from "../../src/server/refreshAdmission.js";
import { RefreshTracker } from "../../src/server/refreshTracker.js";
import { ListingRepository } from "../../src/server/repository.js";
import { makeListing, makeScore } from "../domain/listingFactory.js";

function setup() {
  const database = createDatabase(":memory:");
  const repository = new ListingRepository(database);
  const coordinator = {
    refreshAll: vi.fn(async () => "success" as const)
  };
  const tracker = new RefreshTracker(repository.getRefreshSnapshot());
  const browserRepository = new BrowserRefreshRepository(database);
  const admission = new RefreshAdmissionController({
    browserRepository,
    tracker
  });
  const browserService = new JiaoyimaoBrowserTaskService(
    browserRepository,
    {
      publisher: repository,
      releaseAdmission: (jobId) => admission.releaseBrowser(jobId)
    }
  );
  return {
    database,
    repository,
    coordinator,
    tracker,
    app: createApp({
      repository,
      coordinator,
      tracker,
      admission,
      browserRepository,
      browserService
    })
  };
}

function browserAppExtras(
  database: ReturnType<typeof createDatabase>,
  repository: ListingRepository,
  admission: RefreshAdmissionController
) {
  const browserRepository = new BrowserRefreshRepository(database);
  return {
    browserRepository,
    browserService: new JiaoyimaoBrowserTaskService(
      browserRepository,
      {
        publisher: repository,
        releaseAdmission: (jobId) => admission.releaseBrowser(jobId)
      }
    )
  };
}

function successUpdateForApi(source: SourceId) {
  return {
    source,
    state: "success" as const,
    attemptedAt: new Date("2026-07-29T10:00:00.000Z"),
    itemCount: 0,
    metadata: {
      pagesScanned: 1,
      stopReason: "end_of_pages",
      error: null
    }
  };
}

function listingFor(
  source: SourceId,
  index: number,
  overrides: Partial<Listing> = {}
): Listing {
  return makeListing({
    key: `${source}:${index}`,
    source,
    sourceListingId: String(index),
    url: `https://example.test/${source}/${index}`,
    score: makeScore(100 - index),
    ...overrides
  });
}

function seedCandidateUniverse(repository: ListingRepository): void {
  const sources: SourceId[] = ["jiaoyimao", "panzhi", "pxb7"];
  for (const source of sources) {
    repository.replaceSourceSnapshot(
      source,
      [
        ...Array.from({ length: 12 }, (_, index) =>
          listingFor(source, index)
        ),
        listingFor(source, 50, {
          key: `${source}:unscored`,
          sourceListingId: "unscored",
          score: null
        }),
        listingFor(source, 51, {
          key: `${source}:review`,
          sourceListingId: "review",
          eligibility: "needs_verification",
          score: null
        }),
        listingFor(source, 52, {
          key: `${source}:rejected`,
          sourceListingId: "rejected",
          eligibility: "rejected",
          score: null
        })
      ],
      "success"
    );
  }
}

const browserBaseTime = new Date("2026-07-30T10:00:00.000Z");
const browserFilterUrl =
  "https://www.jiaoyimao.com/jg2007840/f8845003-c8845004/o110/";

function browserProof(
  overrides: Partial<BrowserFilterProof> = {}
): BrowserFilterProof {
  return {
    currentUrl: browserFilterUrl,
    gameLabel: "三角洲行动",
    platformLabel: "QQ",
    categoryLabel: "账号",
    activeFilterLabels: [],
    observedAt: browserBaseTime.toISOString(),
    ...overrides
  };
}

function browserBatch(
  items: Array<[string, number | null]>,
  sequence = 1
): BrowserListBatch {
  return {
    sequence,
    observedAt: browserBaseTime.toISOString(),
    items: items.map(([sourceListingId, priceCny]) => ({
      sourceListingId,
      url:
        `https://www.jiaoyimao.com/jg2007840/${sourceListingId}.html`,
      title: `商品 ${sourceListingId}`,
      rawText: "M7棱镜攻势 极品S",
      priceCny
    }))
  };
}

function sizedUnicodeBrowserBatch(
  targetBytes: number,
  sequence: number
): BrowserListBatch {
  const batch = browserBatch(
    Array.from({ length: 25 }, (_, index) => [
      String(sequence * 100 + index + 1),
      7_000
    ]),
    sequence
  );
  for (const item of batch.items) item.rawText = "";
  const baseBytes = Buffer.byteLength(JSON.stringify(batch), "utf8");
  let remaining = targetBytes - baseBytes;
  if (remaining < 0) {
    throw new Error("Target payload is smaller than its JSON envelope");
  }
  for (const item of batch.items) {
    const characters = Math.min(
      BROWSER_REFRESH_LIMITS.maxCardTextChars,
      Math.floor(remaining / 3)
    );
    item.rawText = "界".repeat(characters);
    remaining -= characters * 3;
  }
  const remainderItem = batch.items.find(
    ({ rawText }) =>
      rawText.length + remaining <=
      BROWSER_REFRESH_LIMITS.maxCardTextChars
  );
  if (!remainderItem) {
    throw new Error("No list item can hold the payload byte remainder");
  }
  remainderItem.rawText += "x".repeat(remaining);
  expect(Buffer.byteLength(JSON.stringify(batch), "utf8")).toBe(
    targetBytes
  );
  return batch;
}

function browserApiSetup() {
  const database = createDatabase(":memory:");
  const repository = new ListingRepository(database);
  const browserRepository = new BrowserRefreshRepository(database);
  const coordinator = {
    refreshAll: vi.fn(async () => "success" as const)
  };
  const tracker = new RefreshTracker(repository.getRefreshSnapshot());
  let now = browserBaseTime.getTime();
  const admission = new RefreshAdmissionController({
    browserRepository,
    tracker,
    now: () => new Date(now)
  });
  const browserService = new JiaoyimaoBrowserTaskService(
    browserRepository,
    {
      now: () => new Date(now),
      random: () => 0,
      publisher: repository,
      releaseAdmission: (jobId) => admission.releaseBrowser(jobId)
    }
  );
  const app = createApp({
    repository,
    coordinator,
    tracker,
    admission,
    browserRepository,
    browserService,
    now: () => new Date(now)
  });
  return {
    app,
    database,
    repository,
    browserRepository,
    browserService,
    coordinator,
    tracker,
    admission,
    advance(milliseconds: number) {
      now += milliseconds;
    }
  };
}

async function createAndClaimBrowserJob(
  f: ReturnType<typeof browserApiSetup>
) {
  const created = await request(f.app)
    .post("/api/sources/jiaoyimao/browser-refresh")
    .send({});
  expect(created.status).toBe(202);
  const claimed = await request(f.app)
    .post(`/api/browser-refresh/${created.body.jobId}/claim`)
    .send({ claimCode: created.body.claimCode });
  expect(claimed.status).toBe(200);
  return {
    id: created.body.jobId as string,
    claimCode: created.body.claimCode as string,
    token: claimed.body.bridgeToken as string
  };
}

function bearer(token: string): string {
  return `Bearer ${token}`;
}

function gzipWithOversizedMetadata(): Buffer {
  const compressed = gzipSync(Buffer.from("{}"));
  const header = Buffer.from(compressed.subarray(0, 10));
  header[3] |= 0x10;
  const wireBody = Buffer.concat([
    header,
    Buffer.alloc(140 * 1_024, 0x61),
    Buffer.from([0]),
    compressed.subarray(10)
  ]);
  expect(wireBody.length).toBeGreaterThan(
    BROWSER_REFRESH_LIMITS.maxBatchUtf8Bytes
  );
  expect(gunzipSync(wireBody).toString("utf8")).toBe("{}");
  return wireBody;
}

async function postChunkedBrowserBody(
  app: ReturnType<typeof createApp>,
  body: Buffer
): Promise<{
  status: number;
  type: string;
  body: unknown;
}> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  try {
    return await new Promise((resolve, reject) => {
      const operation = nodeRequest({
        hostname: "127.0.0.1",
        port: address.port,
        path: "/api/sources/jiaoyimao/browser-refresh",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Encoding": "gzip",
          "Transfer-Encoding": "chunked"
        }
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({
              status: response.statusCode ?? 0,
              type: String(response.headers["content-type"] ?? ""),
              body: JSON.parse(text)
            });
          } catch (error) {
            reject(error);
          }
        });
      });
      operation.once("error", reject);
      for (
        let offset = 0;
        offset < body.length;
        offset += 8 * 1_024
      ) {
        operation.write(body.subarray(offset, offset + 8 * 1_024));
      }
      operation.end();
    });
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

describe("listing API", () => {
  it("returns balanced eligible candidates for every pool-compatible default", async () => {
    const { app, repository } = setup();
    seedCandidateUniverse(repository);

    const paths = [
      "/api/listings",
      "/api/listings?status=eligible",
      "/api/listings?view=pool",
      "/api/listings?view=pool&status=eligible"
    ];
    const responses = await Promise.all(paths.map((path) => request(app).get(path)));

    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(30);
      expect(response.body.every(
        ({ eligibility, score }: Listing) =>
          eligibility === "eligible" && score !== null
      )).toBe(true);
      for (const source of ["jiaoyimao", "panzhi", "pxb7"] as const) {
        expect(
          response.body.filter((listing: Listing) => listing.source === source)
        ).toHaveLength(10);
      }
    }
    expect(responses.map(({ body }) => body)).toEqual(
      Array.from({ length: responses.length }, () => responses[0].body)
    );
  });

  it.each([
    "/api/listings?mode=global",
    "/api/listings?status=eligible&mode=global",
    "/api/listings?view=pool&status=eligible&mode=global"
  ])("returns the real global top thirty for %s", async (path) => {
    const { app, repository } = setup();
    repository.replaceSourceSnapshot(
      "jiaoyimao",
      Array.from({ length: 35 }, (_, index) =>
        listingFor("jiaoyimao", index, {
          score: makeScore(100 - index)
        })
      ),
      "success"
    );
    repository.replaceSourceSnapshot(
      "panzhi",
      Array.from({ length: 3 }, (_, index) =>
        listingFor("panzhi", index, {
          score: makeScore(20 - index)
        })
      ),
      "success"
    );

    const response = await request(app).get(path);

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(30);
    expect(
      response.body.every(({ source }: Listing) => source === "jiaoyimao")
    ).toBe(true);
  });

  it.each([
    {
      query: "view=all",
      status: "eligible",
      expectedCount: 39
    },
    {
      query: "view=all&status=eligible",
      status: "eligible",
      expectedCount: 39
    },
    {
      query: "status=needs_verification",
      status: "needs_verification",
      expectedCount: 3
    },
    {
      query: "view=all&status=needs_verification",
      status: "needs_verification",
      expectedCount: 3
    },
    {
      query: "status=rejected",
      status: "rejected",
      expectedCount: 3
    },
    {
      query: "view=all&status=rejected",
      status: "rejected",
      expectedCount: 3
    }
  ] satisfies {
    query: string;
    status: Eligibility;
    expectedCount: number;
  }[])(
    "returns the complete $status view for $query",
    async ({ query, status, expectedCount }) => {
      const { app, repository } = setup();
      seedCandidateUniverse(repository);

      const response = await request(app).get(`/api/listings?${query}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(expectedCount);
      expect(
        response.body.every(
          ({ eligibility }: Listing) => eligibility === status
        )
      ).toBe(true);
      if (status === "eligible") {
        expect(
          response.body.filter(({ score }: Listing) => score === null)
        ).toHaveLength(3);
      }
    }
  );

  it.each([
    "view=surprise",
    "status=surprise",
    "view=pool&status=needs_verification",
    "view=pool&status=rejected",
    "view=all&view=pool",
    "status=eligible&status=rejected",
    "view=pool&view=pool",
    "status=eligible&status=eligible",
    "mode=surprise",
    "view=all&mode=balanced",
    "view=all&mode=global",
    "status=rejected&mode=balanced",
    "status=rejected&mode=global",
    "mode=balanced&mode=global"
  ])("rejects invalid listing view parameters for %s", async (query) => {
    const { app } = setup();

    const response = await request(app).get(`/api/listings?${query}`);

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: "invalid_listing_view",
      message: "候选视图参数无效"
    });
    expect(JSON.stringify(response.body)).not.toContain("stack");
  });

  it("returns stable JSON for malformed percent encoding", async () => {
    const { app } = setup();

    const response = await request(app).get(
      "/api/listings?status=%E0%A4%A"
    );

    expect(response.status).toBe(400);
    expect(response.type).toMatch(/json/);
    expect(response.body).toEqual({
      error: "invalid_listing_view",
      message: "候选视图参数无效"
    });
    expect(JSON.stringify(response.body)).not.toContain("stack");
  });

  it("ignores non-exact bracketed query keys without prototype pollution", async () => {
    const { app, repository } = setup();
    seedCandidateUniverse(repository);
    const queries = [
      "view%5B%5D=pool",
      "view%5B%5D=all",
      "__proto__%5Bview%5D=all",
      "constructor%5Bprototype%5D%5Bstatus%5D=rejected"
    ];

    const responses = await Promise.all(
      queries.map((query) => request(app).get(`/api/listings?${query}`))
    );

    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(30);
    }
    expect(Object.prototype).not.toHaveProperty("view");
    expect(Object.prototype).not.toHaveProperty("status");
  });

  it("returns deterministic complete views without applying the source cap", async () => {
    const { app, repository } = setup();
    repository.replaceSourceSnapshot(
      "panzhi",
      [
        listingFor("panzhi", 1, {
          score: makeScore(80),
          confidence: 90,
          priceCny: 1_000,
          capturedAt: "2026-07-28T08:00:00+08:00",
          url: "https://example.test/z"
        }),
        listingFor("panzhi", 2, {
          score: makeScore(80),
          confidence: 90,
          priceCny: 1_000,
          capturedAt: "2026-07-28T08:00:00+08:00",
          url: "https://example.test/a"
        }),
        listingFor("panzhi", 3, {
          score: makeScore(80),
          confidence: 90,
          priceCny: 1_000,
          capturedAt: "2026-07-28T09:00:00+08:00"
        }),
        ...Array.from({ length: 10 }, (_, index) =>
          listingFor("panzhi", index + 10, {
            score: makeScore(70 - index)
          })
        )
      ],
      "success"
    );

    const response = await request(app).get(
      "/api/listings?view=all&status=eligible"
    );

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(13);
    expect(
      response.body.slice(0, 3).map(({ key }: Listing) => key)
    ).toEqual(["panzhi:3", "panzhi:2", "panzhi:1"]);
  });

  it("derives source completeness and counts from the current candidate pool", async () => {
    const { app, repository } = setup();
    repository.replaceSourceSnapshot(
      "jiaoyimao",
      [
        ...Array.from({ length: 12 }, (_, index) =>
          listingFor("jiaoyimao", index)
        ),
        listingFor("jiaoyimao", 20, {
          key: "jiaoyimao:unscored",
          sourceListingId: "unscored",
          score: null
        })
      ],
      "success",
      new Date("2026-07-28T10:00:00.000Z"),
      { pagesScanned: 6, stopReason: "end_of_pages" }
    );
    repository.replaceSourceSnapshot(
      "panzhi",
      [
        ...Array.from({ length: 3 }, (_, index) =>
          listingFor("panzhi", index, {
            score: makeScore(90 - index)
          })
        ),
        listingFor("panzhi", 20, {
          key: "panzhi:unscored",
          sourceListingId: "unscored",
          score: null
        })
      ],
      "partial",
      new Date("2026-07-28T10:00:00.000Z"),
      {
        pagesScanned: 2,
        stopReason: "error",
        error: "request_timeout"
      }
    );
    repository.replaceSourceSnapshot(
      "pxb7",
      [
        listingFor("pxb7", 0, {
          score: null,
          capturedAt: "2026-07-27T10:00:00.000Z"
        })
      ],
      "success",
      new Date("2026-07-27T10:00:00.000Z")
    );
    repository.markSourceFailure(
      "pxb7",
      "catalog_unavailable",
      new Date("2026-07-28T10:00:00.000Z"),
      "failed"
    );

    const [sourcesResponse, poolResponse, eligibleResponse] =
      await Promise.all([
        request(app).get("/api/sources"),
        request(app).get("/api/listings"),
        request(app).get("/api/listings?view=all&status=eligible")
      ]);

    expect(sourcesResponse.status).toBe(200);
    expect(sourcesResponse.body).toEqual([
      expect.objectContaining({
        source: "jiaoyimao",
        state: "success",
        pagesScanned: 6,
        stopReason: "end_of_pages",
        completion: "complete",
        eligibleCount: 12,
        candidateCount: 10,
        balancedCandidateCount: 10,
        globalCandidateCount: 12
      }),
      expect.objectContaining({
        source: "panzhi",
        state: "partial",
        pagesScanned: 2,
        stopReason: "error",
        completion: "partial",
        eligibleCount: 3,
        candidateCount: 3,
        balancedCandidateCount: 3,
        globalCandidateCount: 3
      }),
      expect.objectContaining({
        source: "pxb7",
        state: "failed",
        itemCount: 1,
        pagesScanned: 0,
        stopReason: "error",
        stale: true,
        completion: "failed",
        eligibleCount: 0,
        candidateCount: 0
      })
    ]);
    expect(poolResponse.body).toHaveLength(13);
    expect(
      sourcesResponse.body.reduce(
        (total: number, status: { candidateCount: number }) =>
          total + status.candidateCount,
        0
      )
    ).toBe(poolResponse.body.length);
    expect(
      sourcesResponse.body.reduce(
        (total: number, status: { eligibleCount: number }) =>
          total + status.eligibleCount,
        0
      )
    ).toBe(
      eligibleResponse.body.filter(({ score }: Listing) => score !== null)
        .length
    );
  });

  it("derives source contributions from the requested pool mode", async () => {
    const { app, repository } = setup();
    repository.replaceSourceSnapshot(
      "jiaoyimao",
      Array.from({ length: 35 }, (_, index) =>
        listingFor("jiaoyimao", index, {
          score: makeScore(100 - index)
        })
      ),
      "success"
    );
    repository.replaceSourceSnapshot(
      "panzhi",
      Array.from({ length: 3 }, (_, index) =>
        listingFor("panzhi", index, {
          score: makeScore(20 - index)
        })
      ),
      "success"
    );

    const [balanced, global] = await Promise.all([
      request(app).get("/api/sources?mode=balanced"),
      request(app).get("/api/sources?mode=global")
    ]);

    expect(balanced.status).toBe(200);
    expect(global.status).toBe(200);
    expect(
      balanced.body.find(
        ({ source }: { source: SourceId }) => source === "jiaoyimao"
      )
    ).toMatchObject({
      candidateCount: 10,
      balancedCandidateCount: 10,
      globalCandidateCount: 30
    });
    expect(
      global.body.find(
        ({ source }: { source: SourceId }) => source === "jiaoyimao"
      )
    ).toMatchObject({
      candidateCount: 30,
      balancedCandidateCount: 10,
      globalCandidateCount: 30
    });
  });

  it("removes a manually excluded account from every candidate view and refills the pools", async () => {
    const { app, repository } = setup();
    seedCandidateUniverse(repository);
    const key = "jiaoyimao:0";

    const excluded = await request(app)
      .put(
        `/api/listings/${encodeURIComponent(key)}/manual-exclusion`
      )
      .send({
        reason: "price_overvalued",
        note: "  同价位有更安全的号  "
      });

    expect(excluded.status).toBe(200);
    expect(excluded.body).toMatchObject({
      key,
      manualReview: {
        excluded: true,
        reason: "price_overvalued",
        note: "同价位有更安全的号"
      }
    });

    const [
      balanced,
      global,
      eligible,
      rejected,
      sources,
      detail
    ] = await Promise.all([
      request(app).get("/api/listings?mode=balanced"),
      request(app).get("/api/listings?mode=global"),
      request(app).get("/api/listings?view=all&status=eligible"),
      request(app).get("/api/listings?view=all&status=rejected"),
      request(app).get("/api/sources"),
      request(app).get(`/api/listings/${encodeURIComponent(key)}`)
    ]);

    expect(balanced.body).toHaveLength(30);
    expect(global.body).toHaveLength(30);
    expect(
      balanced.body.map(({ key: listingKey }: ReviewedListing) => listingKey)
    ).not.toContain(key);
    expect(
      global.body.map(({ key: listingKey }: ReviewedListing) => listingKey)
    ).not.toContain(key);
    expect(
      balanced.body
        .filter(({ source }: ReviewedListing) => source === "jiaoyimao")
        .map(({ key: listingKey }: ReviewedListing) => listingKey)
    ).toContain("jiaoyimao:10");
    expect(eligible.body).toHaveLength(38);
    expect(
      eligible.body.map(({ key: listingKey }: ReviewedListing) => listingKey)
    ).not.toContain(key);
    expect(
      rejected.body.filter(
        ({ key: listingKey }: ReviewedListing) => listingKey === key
      )
    ).toHaveLength(1);
    expect(
      rejected.body.find(
        ({ key: listingKey }: ReviewedListing) => listingKey === key
      )
    ).toMatchObject({
      eligibility: "eligible",
      manualReview: {
        reason: "price_overvalued",
        note: "同价位有更安全的号"
      }
    });
    expect(detail.body).toMatchObject({
      key,
      manualReview: {
        reason: "price_overvalued"
      }
    });

    const jiaoyimao = sources.body.find(
      ({ source }: { source: SourceId }) => source === "jiaoyimao"
    );
    expect(jiaoyimao).toMatchObject({
      eligibleCount: 11,
      candidateCount: 10,
      balancedCandidateCount: 10
    });
    expect(
      sources.body.reduce(
        (total: number, source: { candidateCount: number }) =>
          total + source.candidateCount,
        0
      )
    ).toBe(balanced.body.length);
    expect(
      sources.body.reduce(
        (total: number, source: { eligibleCount: number }) =>
          total + source.eligibleCount,
        0
      )
    ).toBe(
      eligible.body.filter(({ score }: ReviewedListing) => score !== null)
        .length
    );

    const restored = await request(app).delete(
      `/api/listings/${encodeURIComponent(key)}/manual-exclusion`
    );
    expect(restored.status).toBe(200);
    expect(restored.body).toMatchObject({
      key,
      manualReview: null
    });

    const [restoredBalanced, restoredEligible, restoredRejected] =
      await Promise.all([
        request(app).get("/api/listings?mode=balanced"),
        request(app).get("/api/listings?view=all&status=eligible"),
        request(app).get("/api/listings?view=all&status=rejected")
      ]);
    expect(
      restoredBalanced.body.map(
        ({ key: listingKey }: ReviewedListing) => listingKey
      )
    ).toContain(key);
    expect(
      restoredEligible.body.map(
        ({ key: listingKey }: ReviewedListing) => listingKey
      )
    ).toContain(key);
    expect(
      restoredRejected.body.map(
        ({ key: listingKey }: ReviewedListing) => listingKey
      )
    ).not.toContain(key);
  });

  it("keeps a manual exclusion after its source snapshot is replaced", async () => {
    const { app, repository } = setup();
    const listing = listingFor("panzhi", 1);
    repository.replaceSourceSnapshot("panzhi", [listing], "success");
    await request(app)
      .put(
        `/api/listings/${encodeURIComponent(
          listing.key
        )}/manual-exclusion`
      )
      .send({ reason: "m7_low_value" })
      .expect(200);

    repository.replaceSourceSnapshot(
      "panzhi",
      [
        {
          ...listing,
          title: "刷新后仍是同一个账号",
          capturedAt: "2026-07-31T11:00:00.000Z"
        }
      ],
      "success"
    );

    const [pool, rejected] = await Promise.all([
      request(app).get("/api/listings"),
      request(app).get("/api/listings?view=all&status=rejected")
    ]);
    expect(pool.body).toEqual([]);
    expect(rejected.body).toEqual([
      expect.objectContaining({
        key: listing.key,
        title: "刷新后仍是同一个账号",
        manualReview: expect.objectContaining({
          reason: "m7_low_value"
        })
      })
    ]);
  });

  it("validates manual exclusion requests and keeps restore idempotent", async () => {
    const { app, repository } = setup();
    const eligible = listingFor("panzhi", 1);
    const rejected = listingFor("panzhi", 2, {
      eligibility: "rejected",
      score: null
    });
    repository.replaceSourceSnapshot(
      "panzhi",
      [eligible, rejected],
      "success"
    );
    const eligiblePath =
      `/api/listings/${encodeURIComponent(
        eligible.key
      )}/manual-exclusion`;

    for (const body of [
      { reason: "other", note: "" },
      { reason: "assets_low", note: "x".repeat(501) },
      { reason: "price_overvalued", hidden: true }
    ]) {
      const response = await request(app).put(eligiblePath).send(body);
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: "invalid_manual_review",
        message: "人工淘汰信息无效"
      });
    }

    const missing = await request(app)
      .put("/api/listings/panzhi%3Amissing/manual-exclusion")
      .send({ reason: "price_overvalued" });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({
      error: "listing_not_found",
      message: "候选不存在或已下架"
    });

    const ineligible = await request(app)
      .put(
        `/api/listings/${encodeURIComponent(
          rejected.key
        )}/manual-exclusion`
      )
      .send({ reason: "price_overvalued" });
    expect(ineligible.status).toBe(409);
    expect(ineligible.body).toEqual({
      error: "listing_not_eligible",
      message: "该账号不满足 QQ 官服与预算条件，不能人工淘汰"
    });

    const firstRestore = await request(app).delete(eligiblePath);
    const repeatedRestore = await request(app).delete(eligiblePath);
    for (const response of [firstRestore, repeatedRestore]) {
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        key: eligible.key,
        manualReview: null
      });
    }
    expect(
      await request(app).delete(
        "/api/listings/panzhi%3Amissing/manual-exclusion"
      )
    ).toMatchObject({
      status: 404,
      body: {
        error: "listing_not_found",
        message: "候选不存在或已下架"
      }
    });
  });

  it("returns a safe stable error when manual review persistence fails", async () => {
    const { app, database, repository } = setup();
    const listing = listingFor("panzhi", 1);
    repository.replaceSourceSnapshot("panzhi", [listing], "success");
    database.exec(`
      CREATE TRIGGER force_manual_review_failure
      BEFORE INSERT ON manual_listing_reviews
      BEGIN
        SELECT RAISE(ABORT, 'secret database failure');
      END;
    `);

    const response = await request(app)
      .put(
        `/api/listings/${encodeURIComponent(
          listing.key
        )}/manual-exclusion`
      )
      .send({ reason: "price_overvalued" });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: "manual_review_failed",
      message: "人工淘汰操作失败，请稍后重试"
    });
    expect(JSON.stringify(response.body)).not.toContain("secret");
  });

  it("rejects an invalid source pool mode", async () => {
    const { app } = setup();

    const response = await request(app).get("/api/sources?mode=surprise");

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: "invalid_pool_mode",
      message: "候选池模式无效"
    });
  });

  it("maps blocked and idle source states to API completion values", async () => {
    const { app, repository } = setup();
    repository.markSourceFailure(
      "jiaoyimao",
      "captcha_required",
      new Date("2026-07-28T10:00:00.000Z"),
      "blocked"
    );

    const response = await request(app).get("/api/sources");

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(3);
    expect(response.body[0]).toMatchObject({
      source: "jiaoyimao",
      error: "captcha_required"
    });
    expect(
      response.body.map(
        ({ source, state, completion }: {
          source: SourceId;
          state: string;
          completion: string;
        }) => ({ source, state, completion })
      )
    ).toEqual([
      {
        source: "jiaoyimao",
        state: "blocked",
        completion: "blocked"
      },
      {
        source: "panzhi",
        state: "idle",
        completion: "idle"
      },
      {
        source: "pxb7",
        state: "idle",
        completion: "idle"
      }
    ]);
  });

  it("filters eligible listings and sorts them by score", async () => {
    const { app, repository } = setup();
    repository.replaceSourceSnapshot(
      "panzhi",
      [
        makeListing({
          key: "panzhi:low",
          sourceListingId: "low",
          score: {
            ...makeScore(61, {
              m7: 10,
              redSkins: 0,
              julang: 0,
              price: 15,
              assets: 8,
              secondRealName: 20,
              recovery: 0,
              verification: 0
            }),
            reasons: ["较低"]
          }
        }),
        makeListing({
          key: "panzhi:high",
          sourceListingId: "high",
          score: {
            ...makeScore(88, {
              m7: 15,
              redSkins: 12,
              julang: 15,
              price: 18,
              assets: 8,
              secondRealName: 40,
              recovery: 35,
              verification: 15
            }),
            reasons: ["较高"]
          }
        }),
        makeListing({
          key: "panzhi:review",
          sourceListingId: "review",
          eligibility: "needs_verification"
        })
      ],
      "success"
    );

    const response = await request(app).get(
      "/api/listings?status=eligible"
    );

    expect(response.status).toBe(200);
    expect(response.body.map(({ key }: { key: string }) => key)).toEqual([
      "panzhi:high",
      "panzhi:low"
    ]);
  });

  it("returns listing evidence by encoded key", async () => {
    const { app, repository } = setup();
    const listing = makeListing();
    repository.replaceSourceSnapshot("panzhi", [listing], "success");

    const response = await request(app).get(
      `/api/listings/${encodeURIComponent(listing.key)}`
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      key: listing.key,
      m7Evidence: listing.m7Evidence,
      score: null
    });
  });

  it("keeps list responses lightweight and reserves evidence for detail", async () => {
    const { app, repository } = setup();
    const listing = makeListing({
      originalDescription: "完整详情原文".repeat(1_000)
    });
    repository.replaceSourceSnapshot("panzhi", [listing], "success");

    const list = await request(app).get(
      "/api/listings?view=all&status=eligible"
    );
    const detail = await request(app).get(
      `/api/listings/${encodeURIComponent(listing.key)}`
    );

    expect(list.status).toBe(200);
    expect(list.body[0]).toMatchObject({
      key: listing.key,
      detailLevel: "summary",
      evidenceCount: listing.evidence.length
    });
    expect(list.body[0]).not.toHaveProperty("originalDescription");
    expect(list.body[0]).not.toHaveProperty("evidence");
    if (list.body[0].score !== null) {
      expect(list.body[0].score).not.toHaveProperty("reasons");
    }
    expect(detail.status).toBe(200);
    expect(detail.body.originalDescription).toBe(
      listing.originalDescription
    );
    expect(JSON.stringify(list.body).length).toBeLessThan(
      JSON.stringify(detail.body).length / 4
    );
  });

  it("returns trusted listing history and keeps removed listings queryable", async () => {
    const { app, repository } = setup();
    const listing = makeListing();
    const firstAt = new Date("2026-07-29T10:00:00.000Z");
    repository.commitScanRefresh(
      repository.startScan(firstAt),
      [listing],
      [
        {
          ...successUpdateForApi("panzhi"),
          itemCount: 1,
          attemptedAt: firstAt
        }
      ],
      firstAt
    );

    const active = await request(app).get(
      `/api/listings/${encodeURIComponent(listing.key)}/history?limit=20`
    );
    expect(active.status).toBe(200);
    expect(active.body).toMatchObject({
      key: listing.key,
      availability: "active",
      observations: [
        expect.objectContaining({
          availability: "active",
          priceCny: 1888
        })
      ]
    });

    const removedAt = new Date("2026-07-29T11:00:00.000Z");
    repository.commitScanRefresh(
      repository.startScan(removedAt),
      [],
      [
        {
          ...successUpdateForApi("panzhi"),
          attemptedAt: removedAt
        }
      ],
      removedAt
    );
    const removed = await request(app).get(
      `/api/listings/${encodeURIComponent(listing.key)}/history`
    );
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({
      availability: "removed",
      observations: [
        expect.objectContaining({ availability: "removed" }),
        expect.objectContaining({ availability: "active" })
      ]
    });
  });

  it("validates listing history limits and unknown keys", async () => {
    const { app } = setup();

    const invalid = await request(app).get(
      "/api/listings/panzhi%3Amissing/history?limit=0"
    );
    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({
      error: "invalid_history_limit",
      message: "账号历史数量参数无效"
    });

    const missing = await request(app).get(
      "/api/listings/panzhi%3Amissing/history"
    );
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({
      error: "listing_history_not_found",
      message: "账号不存在或尚无可信历史"
    });
  });

  it("keeps failed-source snapshots in the complete eligible view but not the pool", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markBlocked!: () => void;
    const blocked = new Promise<void>((resolve) => {
      markBlocked = resolve;
    });
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);
    repository.replaceSourceSnapshot(
      "jiaoyimao",
      [
        listingFor("jiaoyimao", 1, { score: makeScore(95) }),
        listingFor("jiaoyimao", 2, {
          eligibility: "needs_verification",
          score: null
        }),
        listingFor("jiaoyimao", 3, {
          eligibility: "rejected",
          score: null
        })
      ],
      "success"
    );
    repository.replaceSourceSnapshot(
      "panzhi",
      [listingFor("panzhi", 1, { score: makeScore(90) })],
      "success"
    );
    repository.replaceSourceSnapshot(
      "pxb7",
      [listingFor("pxb7", 1, { score: makeScore(85) })],
      "success"
    );
    const coordinator = {
      refreshAll: vi.fn(async () => {
        repository.markSourceFailure(
          "jiaoyimao",
          "captcha_required",
          new Date("2026-07-28T12:00:00.000Z"),
          "blocked"
        );
        repository.markSourceFailure(
          "pxb7",
          "catalog_unavailable",
          new Date("2026-07-28T12:00:00.000Z"),
          "failed"
        );
        markBlocked();
        await waiting;
        return "partial" as const;
      })
    };
    const tracker = new RefreshTracker(repository.getRefreshSnapshot());
    const admission = new RefreshAdmissionController({
      browserRepository: new BrowserRefreshRepository(database),
      tracker
    });
    const app = createApp({
      repository,
      coordinator,
      tracker,
      admission,
      ...browserAppExtras(database, repository, admission)
    });

    const refresh = request(app).post("/api/refresh");
    const pendingRefresh = refresh.then((response) => response);
    await blocked;
    const [
      sources,
      pool,
      allEligible,
      allNeedsVerification,
      allRejected
    ] = await Promise.all([
      request(app).get("/api/sources"),
      request(app).get("/api/listings"),
      request(app).get("/api/listings?view=all&status=eligible"),
      request(app).get("/api/listings?view=all&status=needs_verification"),
      request(app).get("/api/listings?view=all&status=rejected")
    ]);
    release();
    const refreshResponse = await pendingRefresh;

    expect(sources.body).toEqual([
      expect.objectContaining({
        source: "jiaoyimao",
        state: "blocked",
        eligibleCount: 0,
        candidateCount: 0
      }),
      expect.objectContaining({
        source: "panzhi",
        state: "success",
        eligibleCount: 1,
        candidateCount: 1
      }),
      expect.objectContaining({
        source: "pxb7",
        state: "failed",
        eligibleCount: 0,
        candidateCount: 0
      })
    ]);
    expect(pool.body.map(({ key }: Listing) => key)).toEqual(["panzhi:1"]);
    expect(allEligible.body.map(({ key }: Listing) => key)).toEqual([
      "jiaoyimao:1",
      "panzhi:1",
      "pxb7:1"
    ]);
    expect(
      allNeedsVerification.body.map(({ key }: Listing) => key)
    ).toEqual(["jiaoyimao:2"]);
    expect(allRejected.body.map(({ key }: Listing) => key)).toEqual([
      "jiaoyimao:3"
    ]);
    expect(refreshResponse.status).toBe(202);
  });

  it("returns 409 while a refresh is already running", async () => {
    let release!: (state: "partial") => void;
    const waiting = new Promise<"partial">((resolve) => {
      release = resolve;
    });
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);
    const coordinator = {
      refreshAll: vi.fn((
        _runId: number,
        onProgress?: (event: {
          type: "list_page";
          phase: "list";
          source: "panzhi";
          page: number;
          summaries: number;
          details: number;
          message: string;
        }) => void
      ) => {
        onProgress?.({
          type: "list_page",
          phase: "list",
          source: "panzhi",
          page: 2,
          summaries: 18,
          details: 4,
          message: "已解析第 2 页"
        });
        return waiting;
      })
    };
    const tracker = new RefreshTracker(repository.getRefreshSnapshot());
    const admission = new RefreshAdmissionController({
      browserRepository: new BrowserRefreshRepository(database),
      tracker
    });
    const app = createApp({
      repository,
      coordinator,
      tracker,
      admission,
      ...browserAppExtras(database, repository, admission)
    });

    const first = await request(app).post("/api/refresh");
    expect(first.status).toBe(202);
    expect(first.body).toEqual({
      runId: expect.any(Number),
      state: "running"
    });
    expect(coordinator.refreshAll).toHaveBeenCalledTimes(1);
    const second = await request(app).post("/api/refresh");
    expect(second.status).toBe(409);
    expect(second.body).toEqual({
      error: "refresh_conflict",
      message: "另一个刷新任务正在进行",
      activeKind: "all_sources"
    });

    const running = await request(app).get("/api/refresh-status");
    expect(running.body).toMatchObject({
      runId: first.body.runId,
      state: "running",
      source: "panzhi",
      phase: "list",
      page: 2,
      summaries: 18,
      details: 4
    });

    release("partial");
    await vi.waitFor(() => {
      expect(tracker.snapshot().state).toBe("partial");
    });
    expect((await request(app).get("/api/refresh-status")).body).toMatchObject({
      state: "partial",
      source: null,
      phase: null
    });
  });

  it("returns a redacted browser conflict without creating a scan run", async () => {
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);
    const browserRepository = new BrowserRefreshRepository(database);
    const browser = browserRepository.createJob(
      new Date("2026-07-30T10:00:00.000Z")
    );
    const tracker = new RefreshTracker(repository.getRefreshSnapshot());
    const admission = new RefreshAdmissionController({
      browserRepository,
      tracker,
      now: () => new Date("2026-07-30T10:00:00.000Z")
    });
    const coordinator = {
      refreshAll: vi.fn(async () => "success" as const)
    };
    const app = createApp({
      repository,
      coordinator,
      tracker,
      admission,
      ...browserAppExtras(database, repository, admission)
    });

    const response = await request(app).post("/api/refresh");

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: "refresh_conflict",
      message: "另一个刷新任务正在进行",
      activeKind: "browser",
      jobId: expect.any(String)
    });
    expect(response.body.jobId).not.toBe(browser.id);
    expect(JSON.stringify(response.body)).not.toContain(
      browser.claimCode
    );
    expect(coordinator.refreshAll).not.toHaveBeenCalled();
    expect(repository.getScanHistory(10)).toEqual([]);
  });

  it("releases all-source admission after both success and failure", async () => {
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);
    const browserRepository = new BrowserRefreshRepository(database);
    const tracker = new RefreshTracker(repository.getRefreshSnapshot());
    const admission = new RefreshAdmissionController({
      browserRepository,
      tracker
    });
    const coordinator = {
      refreshAll: vi.fn()
        .mockResolvedValueOnce("success" as const)
        .mockRejectedValueOnce(new Error("collector failed"))
        .mockResolvedValueOnce("success" as const)
    };
    const app = createApp({
      repository,
      coordinator,
      tracker,
      admission,
      ...browserAppExtras(database, repository, admission)
    });

    const first = await request(app).post("/api/refresh");
    expect(first.status).toBe(202);
    await vi.waitFor(() => {
      expect(tracker.snapshot().state).toBe("success");
    });

    const second = await request(app).post("/api/refresh");
    expect(second.status).toBe(202);
    await vi.waitFor(() => {
      expect(tracker.snapshot().state).toBe("failed");
    });

    const third = await request(app).post("/api/refresh");
    expect(third.status).toBe(202);
    await vi.waitFor(() => {
      expect(tracker.snapshot().state).toBe("success");
    });
    expect(coordinator.refreshAll).toHaveBeenCalledTimes(3);
  });

  it("finishes and releases a failed refresh even when scan persistence cleanup throws", async () => {
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);
    const browserRepository = new BrowserRefreshRepository(database);
    const tracker = new RefreshTracker(repository.getRefreshSnapshot());
    const admission = new RefreshAdmissionController({
      browserRepository,
      tracker
    });
    const coordinator = {
      refreshAll: vi.fn()
        .mockRejectedValueOnce(new Error("collector failed"))
        .mockResolvedValueOnce("success" as const)
    };
    vi.spyOn(repository, "failScan").mockImplementationOnce(() => {
      throw new Error("scan cleanup failed");
    });
    const app = createApp({
      repository,
      coordinator,
      tracker,
      admission,
      ...browserAppExtras(database, repository, admission)
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const first = await request(app).post("/api/refresh");
      expect(first.status).toBe(202);
      await vi.waitFor(() => {
        expect(tracker.snapshot()).toMatchObject({
          runId: first.body.runId,
          state: "failed",
          error: "刷新失败"
        });
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(unhandled).toEqual([]);

      const second = await request(app).post("/api/refresh");
      expect(second.status).toBe(202);
      await vi.waitFor(() => {
        expect(tracker.snapshot()).toMatchObject({
          runId: second.body.runId,
          state: "success"
        });
      });
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("records a background refresh rejection without exposing internals", async () => {
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);
    const coordinator = {
      refreshAll: vi.fn(async () => {
        throw new Error("database unavailable");
      })
    };
    const tracker = new RefreshTracker(repository.getRefreshSnapshot());
    const admission = new RefreshAdmissionController({
      browserRepository: new BrowserRefreshRepository(database),
      tracker
    });
    const app = createApp({
      repository,
      coordinator,
      tracker,
      admission,
      ...browserAppExtras(database, repository, admission)
    });

    const response = await request(app).post("/api/refresh");
    expect(response.status).toBe(202);
    await vi.waitFor(() => {
      expect(tracker.snapshot().state).toBe("failed");
    });
    const status = await request(app).get("/api/refresh-status");
    expect(status.body).toMatchObject({
      runId: response.body.runId,
      state: "failed",
      error: "刷新失败"
    });
    expect(JSON.stringify(status.body)).not.toContain("database unavailable");
    expect(repository.getScanHistory(1)[0]).toMatchObject({
      id: response.body.runId,
      state: "failed",
      error: "刷新失败"
    });
  });

  it("returns bounded scan history and rejects invalid limits", async () => {
    const { app, repository } = setup();
    const runId = repository.startScan(
      new Date("2026-07-29T10:00:00.000Z")
    );
    repository.commitScanRefresh(
      runId,
      [],
      [
        successUpdateForApi("jiaoyimao"),
        successUpdateForApi("panzhi"),
        successUpdateForApi("pxb7")
      ],
      new Date("2026-07-29T10:01:00.000Z")
    );

    const response = await request(app).get("/api/scan-history?limit=1");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      runs: [
        expect.objectContaining({
          id: runId,
          state: "success",
          scope: "all_sources",
          requestedSource: null,
          sources: expect.arrayContaining([
            expect.objectContaining({
              source: "panzhi",
              observedItemCount: 0
            })
          ])
        })
      ]
    });
    for (const limit of ["0", "51", "abc", "1&limit=2"]) {
      const invalid = await request(app).get(
        `/api/scan-history?limit=${limit}`
      );
      expect(invalid.status).toBe(400);
      expect(invalid.body.error).toBe("invalid_history_limit");
    }
  });

  it("exposes single-source Jiaoyimao browser scan scope in history", async () => {
    const database = createDatabase(":memory:");
    const repository = new ListingRepository(database);
    const browserRepository = new BrowserRefreshRepository(database);
    const tracker = new RefreshTracker(repository.getRefreshSnapshot());
    const admission = new RefreshAdmissionController({
      browserRepository,
      tracker
    });
    const browserService = new JiaoyimaoBrowserTaskService(
      browserRepository,
      {
        publisher: repository,
        releaseAdmission: (jobId) => admission.releaseBrowser(jobId)
      }
    );
    const app = createApp({
      repository,
      coordinator: {
        refreshAll: vi.fn(async () => "success" as const)
      },
      tracker,
      admission,
      browserRepository,
      browserService
    });
    const created = browserRepository.createJob(
      new Date("2026-07-30T10:00:00.000Z")
    );
    browserRepository.transition(
      created.id,
      ["awaiting_codex"],
      "committing",
      { stage: "committing" },
      new Date("2026-07-30T10:00:00.000Z")
    );
    const committed = repository.commitBrowserSourceRefresh({
      jobId: created.id,
      source: "jiaoyimao",
      listings: [makeListing({
        source: "jiaoyimao",
        key: "jiaoyimao:api-browser",
        sourceListingId: "api-browser",
        url:
          "https://www.jiaoyimao.com/jg2007840/101.html"
      })],
      attemptedAt: new Date("2026-07-30T10:01:00.000Z"),
      pagesScanned: 2,
      stopReason: "end_of_pages"
    });

    const response = await request(app).get("/api/scan-history?limit=1");

    expect(response.status).toBe(200);
    expect(response.body.runs).toEqual([
      expect.objectContaining({
        id: committed.scanRunId,
        scope: "single_source",
        requestedSource: "jiaoyimao",
        sources: [
          expect.objectContaining({ source: "jiaoyimao" })
        ]
      })
    ]);
  });
});

describe("browser refresh API", () => {
  it("creates, redacts, and one-time claims a browser refresh job", async () => {
    const f = browserApiSetup();

    const created = await request(f.app)
      .post("/api/sources/jiaoyimao/browser-refresh")
      .send({});

    expect(created.status).toBe(202);
    expect(created.body).toEqual({
      jobId: expect.any(String),
      state: "awaiting_codex",
      claimCode: expect.any(String),
      expiresAt: expect.any(String)
    });
    expect(created.body.jobId).not.toBe(created.body.claimCode);
    const current = await request(f.app)
      .get("/api/sources/jiaoyimao/browser-refresh/current");
    expect(current.status).toBe(200);
    expect(current.body).toMatchObject({
      id: created.body.jobId,
      state: "awaiting_codex",
      scanRunId: null,
      publishedRunId: null
    });
    expect(JSON.stringify(current.body)).not.toMatch(
      /claimCode|bridgeToken|credential|_hash|Hash/
    );
    expect(JSON.stringify(current.body)).not.toContain(
      created.body.claimCode
    );

    const wrong = await request(f.app)
      .post(`/api/browser-refresh/${created.body.jobId}/claim`)
      .send({ claimCode: "wrong-claim-code" });
    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual({
      error: "bridge_unauthorized",
      message: expect.any(String)
    });

    const claimed = await request(f.app)
      .post(`/api/browser-refresh/${created.body.jobId}/claim`)
      .send({ claimCode: created.body.claimCode });
    expect(claimed.status).toBe(200);
    expect(claimed.body).toMatchObject({
      id: created.body.jobId,
      state: "collecting_list",
      bridgeToken: expect.any(String)
    });
    expect(claimed.body.bridgeToken).not.toBe(created.body.claimCode);

    const replay = await request(f.app)
      .post(`/api/browser-refresh/${created.body.jobId}/claim`)
      .send({ claimCode: created.body.claimCode });
    expect(replay.status).toBe(401);
    expect(replay.body).toEqual({
      error: "bridge_unauthorized",
      message: "浏览器桥接凭据无效或已过期"
    });
    expect(JSON.stringify(replay.body)).not.toContain(
      created.body.claimCode
    );
    expect(JSON.stringify(replay.body)).not.toContain(
      claimed.body.bridgeToken
    );
  });

  it("makes unknown, wrong, expired, and consumed claims indistinguishable", async () => {
    const unauthorized = {
      error: "bridge_unauthorized",
      message: "浏览器桥接凭据无效或已过期"
    };

    const unknown = browserApiSetup();
    const unknownResponse = await request(unknown.app)
      .post("/api/browser-refresh/unknown-job/claim")
      .send({ claimCode: "x" });

    const wrong = browserApiSetup();
    const wrongCreated = await request(wrong.app)
      .post("/api/sources/jiaoyimao/browser-refresh")
      .send({});
    const wrongResponse = await request(wrong.app)
      .post(`/api/browser-refresh/${wrongCreated.body.jobId}/claim`)
      .send({ claimCode: "x" });

    const expired = browserApiSetup();
    const expiredCreated = await request(expired.app)
      .post("/api/sources/jiaoyimao/browser-refresh")
      .send({});
    expired.database.prepare(`
      UPDATE browser_refresh_jobs SET expires_at = ?
      WHERE id = ?
    `).run(
      new Date(browserBaseTime.getTime() - 1).toISOString(),
      expiredCreated.body.jobId
    );
    const expiredResponse = await request(expired.app)
      .post(`/api/browser-refresh/${expiredCreated.body.jobId}/claim`)
      .send({ claimCode: expiredCreated.body.claimCode });

    const consumed = browserApiSetup();
    const consumedCreated = await request(consumed.app)
      .post("/api/sources/jiaoyimao/browser-refresh")
      .send({});
    await request(consumed.app)
      .post(`/api/browser-refresh/${consumedCreated.body.jobId}/claim`)
      .send({ claimCode: consumedCreated.body.claimCode })
      .expect(200);
    const consumedResponse = await request(consumed.app)
      .post(`/api/browser-refresh/${consumedCreated.body.jobId}/claim`)
      .send({ claimCode: consumedCreated.body.claimCode });

    for (const response of [
      unknownResponse,
      wrongResponse,
      expiredResponse,
      consumedResponse
    ]) {
      expect(response.status).toBe(401);
      expect(response.body).toEqual(unauthorized);
    }
  });

  it("makes unknown, wrong, expired, terminal, and malformed Bearer tokens indistinguishable", async () => {
    const unauthorized = {
      error: "bridge_unauthorized",
      message: "浏览器桥接凭据无效或已过期"
    };

    const unknown = browserApiSetup();
    const unknownResponse = await request(unknown.app)
      .get("/api/browser-refresh/unknown-job/work")
      .set("Authorization", "Bearer x");

    const wrong = browserApiSetup();
    const wrongJob = await createAndClaimBrowserJob(wrong);
    const wrongResponse = await request(wrong.app)
      .get(`/api/browser-refresh/${wrongJob.id}/work`)
      .set("Authorization", "Basic malformed");

    const expired = browserApiSetup();
    const expiredJob = await createAndClaimBrowserJob(expired);
    expired.database.prepare(`
      UPDATE browser_refresh_jobs SET expires_at = ?
      WHERE id = ?
    `).run(
      new Date(browserBaseTime.getTime() - 1).toISOString(),
      expiredJob.id
    );
    const expiredResponse = await request(expired.app)
      .get(`/api/browser-refresh/${expiredJob.id}/work`)
      .set("Authorization", bearer(expiredJob.token));

    const terminal = browserApiSetup();
    const terminalJob = await createAndClaimBrowserJob(terminal);
    await request(terminal.app)
      .post(
        `/api/sources/jiaoyimao/browser-refresh/${
          terminalJob.id
        }/cancel`
      )
      .send({})
      .expect(200);
    const terminalResponse = await request(terminal.app)
      .get(`/api/browser-refresh/${terminalJob.id}/work`)
      .set("Authorization", bearer(terminalJob.token));

    const missing = browserApiSetup();
    const missingJob = await createAndClaimBrowserJob(missing);
    const missingResponse = await request(missing.app)
      .get(`/api/browser-refresh/${missingJob.id}/work`);

    for (const response of [
      unknownResponse,
      wrongResponse,
      expiredResponse,
      terminalResponse,
      missingResponse
    ]) {
      expect(response.status).toBe(401);
      expect(response.body).toEqual(unauthorized);
    }
  });

  it("requires a valid unexpired Bearer credential on every bridge route", async () => {
    const f = browserApiSetup();
    const job = await createAndClaimBrowserJob(f);

    const missing = await request(f.app)
      .get(`/api/browser-refresh/${job.id}/work`);
    expect(missing.status).toBe(401);
    const wrong = await request(f.app)
      .get(`/api/browser-refresh/${job.id}/work`)
      .set("Authorization", bearer("wrong-token"));
    expect(wrong.status).toBe(401);

    f.database.prepare(`
      UPDATE browser_refresh_jobs SET expires_at = ?
      WHERE id = ?
    `).run(
      new Date(browserBaseTime.getTime() - 1).toISOString(),
      job.id
    );
    const expired = await request(f.app)
      .get(`/api/browser-refresh/${job.id}/work`)
      .set("Authorization", bearer(job.token));
    expect(expired.status).toBe(401);
    expect(expired.body.error).toBe("bridge_unauthorized");
    expect(JSON.stringify(expired.body)).not.toContain(job.token);
  });

  it.each([
    ["get", "work"],
    ["post", "filter-proof"],
    ["post", "list-batches"],
    ["post", "load-events"],
    ["post", "details"],
    ["post", "pause"],
    ["post", "resume"],
    ["post", "cooldown"],
    ["post", "complete"]
  ] as const)(
    "rejects missing Bearer credentials for %s %s",
    async (method, suffix) => {
      const f = browserApiSetup();
      const job = await createAndClaimBrowserJob(f);
      const response = method === "get"
        ? await request(f.app)
            .get(`/api/browser-refresh/${job.id}/${suffix}`)
        : await request(f.app)
            .post(`/api/browser-refresh/${job.id}/${suffix}`)
            .send({});

      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        error: "bridge_unauthorized",
        message: expect.any(String)
      });
      expect(JSON.stringify(response.body)).not.toContain(job.token);
    }
  );

  it("exposes all collection commands with strict bodies and state mapping", async () => {
    const f = browserApiSetup();
    const job = await createAndClaimBrowserJob(f);
    const auth = { Authorization: bearer(job.token) };

    const work = await request(f.app)
      .get(`/api/browser-refresh/${job.id}/work`)
      .set(auth);
    expect(work.status).toBe(200);
    expect(work.body).toMatchObject({
      id: job.id,
      kind: "list",
      nextListBatchSequence: 1,
      nextLoadSequence: 1
    });

    const invalidProof = await request(f.app)
      .post(`/api/browser-refresh/${job.id}/filter-proof`)
      .set(auth)
      .send(browserProof({
        currentUrl: "https://evil.example/jg2007840/"
      }));
    expect(invalidProof.status).toBe(400);
    expect(invalidProof.body.error).toBe("invalid_browser_payload");

    await request(f.app)
      .post(`/api/browser-refresh/${job.id}/filter-proof`)
      .set(auth)
      .send(browserProof())
      .expect(200);

    const list = await request(f.app)
      .post(`/api/browser-refresh/${job.id}/list-batches`)
      .set(auth)
      .send(browserBatch([["101", 5_000]]));
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({
      acceptedCount: 1,
      uniqueItemCount: 1,
      nextSequence: 2
    });

    const load = await request(f.app)
      .post(`/api/browser-refresh/${job.id}/load-events`)
      .set(auth)
      .send({
        sequence: 1,
        observedUniqueCount: 1,
        newItemCount: 1,
        visibleTotalCount: 1,
        endMarkerVisible: true,
        loadingVisible: false,
        blockingState: "none",
        observedAt: browserBaseTime.toISOString()
      });
    expect(load.status).toBe(200);
    expect(load.body.nextSequence).toBe(2);

    f.advance(2_000);
    const details = await request(f.app)
      .post(`/api/browser-refresh/${job.id}/details`)
      .set(auth)
      .send({
        sequence: 1,
        items: [{
          sourceListingId: "101",
          url:
            "https://www.jiaoyimao.com/jg2007840/101.html",
          observedAt: browserBaseTime.toISOString(),
          sections: {
            head: "三角洲行动 QQ账号 ¥5000",
            report: "验号报告 M7棱镜攻势 极品S",
            safety: "可二次实名 找回包赔",
            description: "M7珠光"
          }
        }]
      });
    expect(details.status).toBe(200);
    expect(details.body).toMatchObject({
      acceptedCount: 1,
      detailCompletedCount: 1,
      detailRequiredCount: 1
    });

    const invalidSequence = await request(f.app)
      .post(`/api/browser-refresh/${job.id}/list-batches`)
      .set(auth)
      .send(browserBatch([["102", 7_000]], 3));
    expect(invalidSequence.status).toBe(409);
  });

  it("supports pause, resume, cooldown, keep-waiting, and cancel", async () => {
    const f = browserApiSetup();
    const job = await createAndClaimBrowserJob(f);
    const auth = { Authorization: bearer(job.token) };

    const paused = await request(f.app)
      .post(`/api/browser-refresh/${job.id}/pause`)
      .set(auth)
      .send({
        reason: "captcha_required",
        message: "等待用户完成验证码"
      });
    expect(paused.status).toBe(200);
    expect(paused.body).toMatchObject({
      state: "awaiting_user_verification",
      reason: "captcha_required"
    });

    const resumed = await request(f.app)
      .post(`/api/browser-refresh/${job.id}/resume`)
      .set(auth)
      .send({});
    expect(resumed.status).toBe(200);

    const cooldown = await request(f.app)
      .post(`/api/browser-refresh/${job.id}/cooldown`)
      .set(auth)
      .send({ reason: "rate_limited" });
    expect(cooldown.status).toBe(200);
    expect(cooldown.body).toMatchObject({
      state: "cooling_down",
      cooldownAttempt: 1
    });

    const tooSoon = await request(f.app)
      .get(`/api/browser-refresh/${job.id}/work`)
      .set(auth);
    expect(tooSoon.status).toBe(409);
    expect(tooSoon.body).toMatchObject({
      error: "cooldown_active",
      retryAt: expect.any(String)
    });

    await request(f.app)
      .post(
        `/api/sources/jiaoyimao/browser-refresh/${job.id}/keep-waiting`
      )
      .send({})
      .expect(200);
    const cancelled = await request(f.app)
      .post(`/api/sources/jiaoyimao/browser-refresh/${job.id}/cancel`)
      .send({});
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.state).toBe("cancelled");

    const afterCancel = await request(f.app)
      .post(`/api/browser-refresh/${job.id}/resume`)
      .set(auth)
      .send({});
    expect(afterCancel.status).toBe(401);
  });

  it("enforces the 128 KiB limit by UTF-8 bytes at the exact boundary", async () => {
    const f = browserApiSetup();
    const job = await createAndClaimBrowserJob(f);
    const auth = { Authorization: bearer(job.token) };
    await request(f.app)
      .post(`/api/browser-refresh/${job.id}/filter-proof`)
      .set(auth)
      .send(browserProof())
      .expect(200);

    const accepted = sizedUnicodeBrowserBatch(
      BROWSER_REFRESH_LIMITS.maxBatchUtf8Bytes - 1,
      1
    );
    const under = await request(f.app)
      .post(`/api/browser-refresh/${job.id}/list-batches`)
      .set(auth)
      .send(accepted);
    expect(under.status).toBe(200);
    expect(under.body.acceptedCount).toBe(25);

    const rejected = sizedUnicodeBrowserBatch(
      BROWSER_REFRESH_LIMITS.maxBatchUtf8Bytes + 1,
      2
    );
    const over = await request(f.app)
      .post(`/api/browser-refresh/${job.id}/list-batches`)
      .set(auth)
      .send(rejected);
    expect(over.status).toBe(413);
    expect(over.body).toEqual({
      error: "browser_payload_too_large",
      message: expect.any(String)
    });
    expect(JSON.stringify(over.body)).not.toContain("界");
  });

  it.each([
    { route: "create", path: "/api/sources/jiaoyimao/browser-refresh" },
    { route: "cancel", path: "cancel" },
    { route: "keep-waiting", path: "keep-waiting" },
    { route: "claim", path: "claim" },
    { route: "filter-proof", path: "filter-proof" },
    { route: "list-batches", path: "list-batches" },
    { route: "load-events", path: "load-events" },
    { route: "details", path: "details" },
    { route: "pause", path: "pause" },
    { route: "resume", path: "resume" },
    { route: "cooldown", path: "cooldown" },
    { route: "complete", path: "complete" }
  ])(
    "requires application/json for the $route browser refresh body",
    async ({ route, path }) => {
      const f = browserApiSetup();
      const created = route === "create"
        ? null
        : await request(f.app)
            .post("/api/sources/jiaoyimao/browser-refresh")
            .send({});
      if (created) expect(created.status).toBe(202);
      let token: string | null = null;
      if (route !== "create" && route !== "claim") {
        const claimed = await request(f.app)
          .post(`/api/browser-refresh/${created!.body.jobId}/claim`)
          .send({ claimCode: created!.body.claimCode });
        expect(claimed.status).toBe(200);
        token = claimed.body.bridgeToken;
      }
      const url = route === "create"
        ? path
        : route === "cancel" || route === "keep-waiting"
          ? `/api/sources/jiaoyimao/browser-refresh/${
              created!.body.jobId
            }/${path}`
          : `/api/browser-refresh/${created!.body.jobId}/${path}`;
      let operation = request(f.app)
        .post(url)
        .set("Content-Type", "text/plain");
      if (token !== null) {
        operation = operation.set("Authorization", bearer(token));
      }
      const response = await operation.send("not-json");

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: "invalid_browser_payload",
        message: expect.any(String)
      });
      if (created) {
        expect(f.browserRepository.getJobRecord(
          created.body.jobId,
          browserBaseTime
        )?.state).not.toBe("cancelled");
      } else {
        expect(
          f.browserRepository.getCurrentJob(browserBaseTime)
        ).toBeNull();
      }
    }
  );

  it.each([
    { route: "create", path: "/api/sources/jiaoyimao/browser-refresh" },
    { route: "cancel", path: "cancel" }
  ])(
    "applies the browser byte limit to oversized text/plain $route",
    async ({ route, path }) => {
      const f = browserApiSetup();
      const created = route === "create"
        ? null
        : await request(f.app)
            .post("/api/sources/jiaoyimao/browser-refresh")
            .send({});
      const url = route === "create"
        ? path
        : `/api/sources/jiaoyimao/browser-refresh/${
            created!.body.jobId
          }/${path}`;
      const response = await request(f.app)
        .post(url)
        .set("Content-Type", "text/plain")
        .send("界".repeat(70_000));

      expect(response.status).toBe(413);
      expect(response.body).toEqual({
        error: "browser_payload_too_large",
        message: expect.stringContaining("128 KiB")
      });
      if (created) {
        expect(f.browserRepository.getJobRecord(
          created.body.jobId,
          browserBaseTime
        )?.state).toBe("awaiting_codex");
      } else {
        expect(
          f.browserRepository.getCurrentJob(browserBaseTime)
        ).toBeNull();
      }
    }
  );

  it("accepts standard application/json charset and rejects an empty JSON body", async () => {
    const charset = browserApiSetup();
    const accepted = await request(charset.app)
      .post("/api/sources/jiaoyimao/browser-refresh")
      .set("Content-Type", "application/json; charset=utf-8")
      .send("{}");
    expect(accepted.status).toBe(202);

    const empty = browserApiSetup();
    const rejected = await request(empty.app)
      .post("/api/sources/jiaoyimao/browser-refresh")
      .set("Content-Type", "application/json; charset=utf-8")
      .send();
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toBe("invalid_browser_payload");
    expect(empty.browserRepository.getCurrentJob(browserBaseTime)).toBeNull();
  });

  it.each([
    "application/json",
    "APPLICATION/JSON; CHARSET=UTF-8",
    "application/json ; charset = \"utf-8\""
  ])("accepts the canonical JSON content type %s", async (contentType) => {
    const f = browserApiSetup();
    const response = await request(f.app)
      .post("/api/sources/jiaoyimao/browser-refresh")
      .set("Content-Type", contentType)
      .send("{}");

    expect(response.status).toBe(202);
  });

  it.each([
    "application/json; charset=utf-8=evil",
    "application/json; charset=\"utf-8",
    "application/json; charset=utf-8\"",
    "application/json; charset=utf-8; charset=utf-8",
    "application/json; charset=utf-8; charset=utf-16",
    "application/json; charset=utf-16",
    "application/json; charset",
    "application/json; charset==utf-8"
  ])("rejects malformed or unsupported JSON content type %s", async (contentType) => {
    const f = browserApiSetup();
    const response = await request(f.app)
      .post("/api/sources/jiaoyimao/browser-refresh")
      .set("Content-Type", contentType)
      .send("{}");

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("invalid_browser_payload");
    expect(f.browserRepository.getCurrentJob(browserBaseTime)).toBeNull();
  });

  it.each([
    "/API/BROWSER-REFRESH/not-a-job/complete?ignored=/api/refresh",
    "/API/SOURCES/JIAOYIMAO/BROWSER-REFRESH?ignored=/api/refresh"
  ])(
    "classifies mixed-case oversized browser path %s with its 128 KiB limit",
    async (path) => {
      const f = browserApiSetup();
      const response = await request(f.app)
        .post(path)
        .set("Content-Type", "text/plain")
        .send("界".repeat(70_000));

      expect(response.status).toBe(413);
      expect(response.body).toEqual({
        error: "browser_payload_too_large",
        message: expect.stringContaining("128 KiB")
      });
    }
  );

  it.each([
    {
      encoding: "compress",
      body: Buffer.from("{}"),
      expectedStatus: 415
    },
    {
      encoding: "gzip",
      body: Buffer.from("not-a-gzip-stream"),
      expectedStatus: 415
    },
    {
      encoding: "deflate",
      body: Buffer.from("not-a-deflate-stream"),
      expectedStatus: 415
    }
  ])(
    "safely maps browser raw-parser $encoding errors",
    async ({ encoding, body, expectedStatus }) => {
      const f = browserApiSetup();
      const response = await request(f.app)
        .post("/api/sources/jiaoyimao/browser-refresh")
        .set("Content-Type", "application/json")
        .set("Content-Encoding", encoding)
        .send(body);

      expect(response.status).toBe(expectedStatus);
      expect(response.type).toMatch(/json/);
      expect(response.body).toEqual({
        error: "invalid_browser_payload",
        message: expect.stringMatching(/[\u3400-\u9fff]/)
      });
      expect(JSON.stringify(response.body)).not.toMatch(
        /node_modules|zlib|incorrect header|unsupported content|src\/server|app\.ts|stack/i
      );
      expect(f.browserRepository.getCurrentJob(browserBaseTime)).toBeNull();
    }
  );

  it("rejects oversized gzip wire bytes before their tiny JSON expands", async () => {
    const f = browserApiSetup();
    const response = await request(f.app)
      .post("/api/sources/jiaoyimao/browser-refresh")
      .set("Content-Type", "application/json")
      .set("Content-Encoding", "gzip")
      .send(gzipWithOversizedMetadata());

    expect(response.status).toBe(413);
    expect(response.body).toEqual({
      error: "browser_payload_too_large",
      message: expect.stringContaining("128 KiB")
    });
    expect(f.browserRepository.getCurrentJob(browserBaseTime)).toBeNull();
  });

  it("counts oversized chunked gzip wire bytes without Content-Length", async () => {
    const f = browserApiSetup();
    const response = await postChunkedBrowserBody(
      f.app,
      gzipWithOversizedMetadata()
    );

    expect(response.status).toBe(413);
    expect(response.type).toMatch(/json/);
    expect(response.body).toEqual({
      error: "browser_payload_too_large",
      message: expect.stringContaining("128 KiB")
    });
    expect(f.browserRepository.getCurrentJob(browserBaseTime)).toBeNull();
  });

  it("safely rejects a compressed body within the wire-byte limit", async () => {
    const f = browserApiSetup();
    const compressed = gzipSync(Buffer.from("{}"));
    expect(compressed.length).toBeLessThanOrEqual(
      BROWSER_REFRESH_LIMITS.maxBatchUtf8Bytes
    );
    const response = await request(f.app)
      .post("/api/sources/jiaoyimao/browser-refresh")
      .set("Content-Type", "application/json")
      .set("Content-Encoding", "gzip")
      .send(compressed);

    expect(response.status).toBe(415);
    expect(response.body).toEqual({
      error: "invalid_browser_payload",
      message: expect.stringMatching(/[\u3400-\u9fff]/)
    });
    expect(f.browserRepository.getCurrentJob(browserBaseTime)).toBeNull();
  });

  it("does not apply browser parser errors to ordinary routes", async () => {
    const { app } = setup();
    const response = await request(app)
      .post("/api/refresh")
      .set("Content-Type", "application/json")
      .set("Content-Encoding", "compress")
      .send(Buffer.from("{}"));

    expect(response.status).toBe(415);
    expect(response.body.error).not.toBe("invalid_browser_payload");
    expect(JSON.stringify(response.body)).not.toMatch(
      /browser|浏览器|128 KiB/
    );
  });

  it("keeps the existing larger JSON limit outside browser refresh routes", async () => {
    const { app } = setup();
    const response = await request(app)
      .post("/api/refresh")
      .send({ padding: "x".repeat(140 * 1_024) });

    expect(response.status).toBe(202);
  });

  it("keeps oversized ordinary JSON errors distinct from browser limits", async () => {
    const { app } = setup();
    const response = await request(app)
      .post("/api/refresh")
      .send({ padding: "x".repeat(300 * 1_024) });

    expect(response.status).toBe(413);
    expect(response.body.error).not.toBe("browser_payload_too_large");
    expect(JSON.stringify(response.body)).not.toMatch(
      /browser|浏览器|128 KiB/
    );
  });

  it("arbitrates browser and ordinary refreshes before creating either record", async () => {
    let releaseAll!: () => void;
    const allWaiting = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });
    const allFirst = browserApiSetup();
    allFirst.coordinator.refreshAll.mockImplementationOnce(async () => {
      await allWaiting;
      return "success";
    });
    const ordinary = await request(allFirst.app).post("/api/refresh");
    expect(ordinary.status).toBe(202);
    const browserConflict = await request(allFirst.app)
      .post("/api/sources/jiaoyimao/browser-refresh")
      .send({});
    expect(browserConflict.status).toBe(409);
    expect(browserConflict.body).toMatchObject({
      error: "refresh_conflict",
      activeKind: "all_sources"
    });
    expect(allFirst.browserRepository.getCurrentJob(browserBaseTime)).toBeNull();
    releaseAll();

    const browserFirst = browserApiSetup();
    const browser = await request(browserFirst.app)
      .post("/api/sources/jiaoyimao/browser-refresh")
      .send({});
    expect(browser.status).toBe(202);
    const ordinaryConflict = await request(browserFirst.app)
      .post("/api/refresh");
    expect(ordinaryConflict.status).toBe(409);
    expect(ordinaryConflict.body).toMatchObject({
      error: "refresh_conflict",
      activeKind: "browser"
    });
    expect(browserFirst.repository.getScanHistory(10)).toEqual([]);
  });

  it("cancels staging without changing formal listings", async () => {
    const f = browserApiSetup();
    const formal = listingFor("jiaoyimao", 90, {
      title: "正式候选"
    });
    f.repository.replaceSourceSnapshot(
      "jiaoyimao",
      [formal],
      "success",
      browserBaseTime
    );
    const job = await createAndClaimBrowserJob(f);
    await request(f.app)
      .post(`/api/browser-refresh/${job.id}/filter-proof`)
      .set("Authorization", bearer(job.token))
      .send(browserProof())
      .expect(200);
    await request(f.app)
      .post(`/api/browser-refresh/${job.id}/list-batches`)
      .set("Authorization", bearer(job.token))
      .send(browserBatch([["901", 5_000]]))
      .expect(200);

    const cancelled = await request(f.app)
      .post(`/api/sources/jiaoyimao/browser-refresh/${job.id}/cancel`)
      .send({});

    expect(cancelled.status).toBe(200);
    expect(f.repository.getListings()).toEqual([formal]);
    expect(f.admission.snapshot()).toEqual({ activeKind: "none" });
  });

  it.each([
    { baselineCount: 0, expectedState: "success" },
    { baselineCount: 100, expectedState: "quarantined" }
  ])(
    "completes as $expectedState with redacted scan linkage",
    async ({ baselineCount, expectedState }) => {
      const f = browserApiSetup();
      if (baselineCount > 0) {
        f.repository.replaceSourceSnapshot(
          "jiaoyimao",
          Array.from({ length: baselineCount }, (_, index) =>
            listingFor("jiaoyimao", index + 1, {
              score: makeScore(50)
            })
          ),
          "success",
          browserBaseTime,
          { pagesScanned: 5, stopReason: "end_of_pages" }
        );
      }
      const job = await createAndClaimBrowserJob(f);
      const auth = { Authorization: bearer(job.token) };
      await request(f.app)
        .post(`/api/browser-refresh/${job.id}/filter-proof`)
        .set(auth)
        .send(browserProof())
        .expect(200);
      await request(f.app)
        .post(`/api/browser-refresh/${job.id}/list-batches`)
        .set(auth)
        .send(browserBatch([["9901", 7_000]]))
        .expect(200);
      await request(f.app)
        .post(`/api/browser-refresh/${job.id}/load-events`)
        .set(auth)
        .send({
          sequence: 1,
          observedUniqueCount: 1,
          newItemCount: 1,
          visibleTotalCount: 1,
          endMarkerVisible: true,
          loadingVisible: false,
          blockingState: "none",
          observedAt: browserBaseTime.toISOString()
        })
        .expect(200);

      const completed = await request(f.app)
        .post(`/api/browser-refresh/${job.id}/complete`)
        .set(auth)
        .send({});

      expect(completed.status).toBe(200);
      expect(completed.body).toEqual({
        state: expectedState,
        scanRunId: expect.any(Number),
        publishedRunId:
          expectedState === "success" ? expect.any(Number) : null
      });
      const current = await request(f.app)
        .get("/api/sources/jiaoyimao/browser-refresh/current");
      expect(current.status).toBe(200);
      expect(current.body).toMatchObject({
        id: job.id,
        state: expectedState,
        scanRunId: completed.body.scanRunId,
        publishedRunId: completed.body.publishedRunId
      });
      expect(JSON.stringify(current.body)).not.toMatch(
        /claimCode|bridgeToken|credential|_hash|Hash/
      );
      expect(JSON.stringify(current.body)).not.toContain(job.claimCode);
      expect(JSON.stringify(current.body)).not.toContain(job.token);
      const refreshStatus = await request(f.app)
        .get("/api/refresh-status");
      expect(refreshStatus.status).toBe(200);
      expect(refreshStatus.body).toMatchObject({
        runId: completed.body.scanRunId,
        state: expectedState === "success" ? "success" : "partial",
        finishedAt: expect.any(String)
      });
      expect(f.admission.snapshot()).toEqual({ activeKind: "none" });
    }
  );
});
