// @vitest-environment node
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type {
  Eligibility,
  Listing,
  Score,
  SourceId
} from "../../src/domain/listing.js";
import { createApp } from "../../src/server/app.js";
import { createDatabase } from "../../src/server/db.js";
import { ListingRepository } from "../../src/server/repository.js";
import { makeListing } from "../domain/listingFactory.js";

function setup() {
  const repository = new ListingRepository(createDatabase(":memory:"));
  const coordinator = { refreshAll: vi.fn(async () => undefined) };
  return {
    repository,
    coordinator,
    app: createApp({ repository, coordinator })
  };
}

function makeScore(total: number): Score {
  return {
    total,
    parts: { safety: 0, price: 0, assets: 0, confidence: 0 },
    reasons: []
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
    "status=eligible&status=eligible"
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
        candidateCount: 10
      }),
      expect.objectContaining({
        source: "panzhi",
        state: "partial",
        pagesScanned: 2,
        stopReason: "error",
        completion: "partial",
        eligibleCount: 3,
        candidateCount: 3
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
            total: 61,
            parts: { safety: 20, price: 15, assets: 12, confidence: 14 },
            reasons: ["较低"]
          }
        }),
        makeListing({
          key: "panzhi:high",
          sourceListingId: "high",
          score: {
            total: 88,
            parts: { safety: 35, price: 20, assets: 18, confidence: 15 },
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

  it("excludes a newly blocked source while refresh score cleanup is pending", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markBlocked!: () => void;
    const blocked = new Promise<void>((resolve) => {
      markBlocked = resolve;
    });
    const repository = new ListingRepository(createDatabase(":memory:"));
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
      })
    };
    const app = createApp({ repository, coordinator });

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
      "panzhi:1"
    ]);
    expect(
      allNeedsVerification.body.map(({ key }: Listing) => key)
    ).toEqual(["jiaoyimao:2"]);
    expect(allRejected.body.map(({ key }: Listing) => key)).toEqual([
      "jiaoyimao:3"
    ]);
    expect(refreshResponse.status).toBe(200);
  });

  it("returns 409 while a refresh is already running", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const repository = new ListingRepository(createDatabase(":memory:"));
    const coordinator = {
      refreshAll: vi.fn(() => {
        markStarted();
        return waiting;
      })
    };
    const app = createApp({ repository, coordinator });

    const first = request(app).post("/api/refresh").then((response) => response);
    await started;
    expect(coordinator.refreshAll).toHaveBeenCalledTimes(1);
    const second = await request(app).post("/api/refresh");
    expect(second.status).toBe(409);
    expect(second.body).toEqual({
      error: "refresh_in_progress",
      message: "刷新任务正在进行"
    });

    release();
    const completed = await first;
    expect(completed.status).toBe(200);
    expect(completed.body.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          completion: "idle",
          eligibleCount: 0,
          candidateCount: 0
        })
      ])
    );
  });

  it("returns an actionable error when refresh fails", async () => {
    const repository = new ListingRepository(createDatabase(":memory:"));
    const coordinator = {
      refreshAll: vi.fn(async () => {
        throw new Error("database unavailable");
      })
    };
    const app = createApp({ repository, coordinator });

    const response = await request(app).post("/api/refresh");
    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: "refresh_failed",
      message: "刷新失败，请查看来源状态后重试"
    });
    expect(JSON.stringify(response.body)).not.toContain(
      "database unavailable"
    );
  });
});
