// @vitest-environment node

import request from "supertest";
import { createApp } from "../../src/server/app.js";

describe("health endpoint", () => {
  it("returns local service health", async () => {
    const response = await request(createApp()).get("/api/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      service: "delta-account-scout"
    });
  });
});
