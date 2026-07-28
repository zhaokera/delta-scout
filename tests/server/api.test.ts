// @vitest-environment node
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
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

describe("listing API", () => {
  it("returns all three source states", async () => {
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
      state: "blocked",
      error: "captcha_required"
    });
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

  it("rejects invalid status filters without exposing a stack", async () => {
    const { app } = setup();
    const response = await request(app).get(
      "/api/listings?status=surprise"
    );

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: "invalid_status",
      message: "status 参数无效"
    });
    expect(JSON.stringify(response.body)).not.toContain("stack");
  });

  it("returns 409 while a refresh is already running", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const repository = new ListingRepository(createDatabase(":memory:"));
    const coordinator = { refreshAll: vi.fn(() => waiting) };
    const app = createApp({ repository, coordinator });

    const first = request(app).post("/api/refresh").then((response) => response);
    await vi.waitFor(() => {
      expect(coordinator.refreshAll).toHaveBeenCalledTimes(1);
    });
    const second = await request(app).post("/api/refresh");
    expect(second.status).toBe(409);
    expect(second.body).toEqual({
      error: "refresh_in_progress",
      message: "刷新任务正在进行"
    });

    release();
    expect((await first).status).toBe(200);
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
