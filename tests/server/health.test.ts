// @vitest-environment node

import request from "supertest";
import { createApp } from "../../src/server/app.js";

describe("health endpoint", () => {
  it("keeps dependency-free createApp health-only", async () => {
    const app = createApp();
    const response = await request(app).get("/api/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      service: "delta-account-scout"
    });
    await request(app)
      .post("/api/sources/jiaoyimao/browser-refresh")
      .send({})
      .expect(404);
  });
});
