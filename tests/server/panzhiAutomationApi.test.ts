// @vitest-environment node

import { createHash } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";
import {
  BrowserRefreshRepository
} from "../../src/server/browserRefresh/repository.js";
import {
  JiaoyimaoBrowserTaskService
} from "../../src/server/browserRefresh/service.js";
import { createDatabase } from "../../src/server/db.js";
import {
  PanzhiAutomationRepository
} from "../../src/server/panzhiAutomation/repository.js";
import {
  PanzhiSnapshotPublisher
} from "../../src/server/panzhiAutomation/publisher.js";
import {
  PanzhiAutomationService
} from "../../src/server/panzhiAutomation/service.js";
import type {
  PanzhiBrowserSnapshot
} from "../../src/server/panzhiBrowserSnapshot.js";
import {
  RefreshAdmissionController
} from "../../src/server/refreshAdmission.js";
import {
  RefreshScheduleRepository
} from "../../src/server/refreshScheduler.js";
import { RefreshTracker } from "../../src/server/refreshTracker.js";
import { ListingRepository } from "../../src/server/repository.js";

const baseTime = new Date("2026-08-04T02:00:00.000Z");

function snapshotItem(sourceListingId: string, priceCny = 2_888) {
  return {
    sourceListingId,
    url: `https://www.pzds.com/goodsDetails/${sourceListingId}/6`,
    title: `${sourceListingId} M7 棱镜攻势账号`,
    rawText:
      "总资产365M 哈夫币478w M7棱镜攻势(极品B) " +
      "骇爪-维什戴尔 露娜-黑天际线 QQ可二次实名 找回包赔 " +
      `¥ ${priceCny}`,
    priceCny
  };
}

function snapshot(
  ids: string[] = ["AUTO-1"],
  overrides: Partial<PanzhiBrowserSnapshot> = {}
): PanzhiBrowserSnapshot {
  const items = ids.map((id) => snapshotItem(id));
  return {
    mode: "deep",
    filterProof: {
      currentUrl: "https://www.pzds.com/goodsList/391/6",
      gameLabel: "三角洲行动",
      minPriceInput: "1900",
      maxPriceInput: "4000",
      secondRealNameFilter: {
        label: "可二次实名",
        selected: true
      },
      operatorSkinFilter: {
        fieldId: "22858",
        fieldLabel: "特战干员外观",
        fieldType: "CHECKBOX",
        mappingField: "22858",
        searchType: "ALL",
        searchTypeLabel: "全部都要有",
        selectedOptions: [
          {
            optionId: "1038173",
            label: "骇爪-维什戴尔",
            metadataCode: "SA200018"
          },
          {
            optionId: "1035794",
            label: "露娜-黑天际线",
            metadataCode: "SA200003"
          }
        ]
      },
      observedAt: baseTime.toISOString()
    },
    loadActionCount: 4,
    observedUniqueCount: items.length,
    stopReason: "no_growth_twice",
    items,
    ...overrides
  };
}

function fixture() {
  let current = new Date(baseTime);
  let nowProvider = () => current;
  const database = createDatabase(":memory:");
  const listings = new ListingRepository(database);
  const automationRepository = new PanzhiAutomationRepository(database);
  const publisher = new PanzhiSnapshotPublisher(listings);
  const tracker = new RefreshTracker(listings.getRefreshSnapshot());
  const browserRepository = new BrowserRefreshRepository(database);
  const admission = new RefreshAdmissionController({
    browserRepository,
    tracker,
    now: () => current
  });
  const browserService = new JiaoyimaoBrowserTaskService(
    browserRepository,
    {
      publisher: listings,
      releaseAdmission: (jobId) => admission.releaseBrowser(jobId)
    }
  );
  const schedule = new RefreshScheduleRepository(database, current);
  const automation = new PanzhiAutomationService({
    repository: automationRepository,
    publisher,
    listings,
    schedule,
    admission,
    tracker,
    now: () => nowProvider(),
    random: () => 0.5
  });
  const coordinator = {
    refreshAll: async () => "success" as const
  };
  const app = createApp({
    repository: listings,
    coordinator,
    tracker,
    admission,
    browserRepository,
    browserService,
    panzhiAutomationService: automation,
    panzhiPublisher: publisher
  });
  return {
    app,
    database,
    listings,
    automationRepository,
    publisher,
    tracker,
    schedule,
    automation,
    admission,
    setNow: (next: Date) => {
      current = new Date(next);
      nowProvider = () => current;
    },
    setNowProvider: (next: () => Date) => {
      nowProvider = next;
    }
  };
}

function bearer(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

async function claimAndAdvanceToSubmitting(
  f: ReturnType<typeof fixture>,
  mode: "quick" | "deep" = "deep"
) {
  const enqueued = f.automation.enqueue(mode);
  const claimed = await request(f.app)
    .post("/api/sources/panzhi/automation/jobs/claim")
    .send({})
    .expect(202);
  const token = claimed.body.bearerToken as string;
  for (const state of [
    "applying_filters",
    "collecting",
    "submitting"
  ]) {
    await request(f.app)
      .post(`/api/sources/panzhi/automation/jobs/${enqueued.job.id}/state`)
      .set(bearer(token))
      .send({ state })
      .expect(200);
  }
  return { jobId: enqueued.job.id, token };
}

function count(
  database: ReturnType<typeof createDatabase>,
  table: string
): number {
  return (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number;
  }).count;
}

describe("Panzhi automation API", () => {
  it("returns an explicit unavailable response when the service is not wired", async () => {
    await request(createApp())
      .get("/api/sources/panzhi/automation/status")
      .expect(503, {
        error: "panzhi_automation_unavailable",
        message: "盼之自动化服务未配置"
      });
  });

  it("reports only public status and accepts only an empty extension heartbeat", async () => {
    const f = fixture();
    const enqueued = f.automation.enqueue("deep");

    const initial = await request(f.app)
      .get("/api/sources/panzhi/automation/status")
      .expect(200);
    expect(initial.body).toMatchObject({
      connected: false,
      currentJob: {
        id: enqueued.job.id,
        mode: "deep",
        state: "queued"
      }
    });
    expect(JSON.stringify(initial.body)).not.toMatch(
      /bearer|digest|result_json|normalizedRequestDigest/i
    );

    await request(f.app)
      .post("/api/sources/panzhi/automation/heartbeat")
      .send({ extra: true })
      .expect(400);
    const heartbeat = await request(f.app)
      .post("/api/sources/panzhi/automation/heartbeat")
      .send({})
      .expect(200);
    expect(heartbeat.body).toEqual({
      connected: true,
      lastHeartbeatAt: baseTime.toISOString()
    });
  });

  it("claims queued work, resumes with bearer plus job id, and never persists or accepts a plaintext token", async () => {
    const f = fixture();
    const queued = f.automation.enqueue("deep");
    const claimed = await request(f.app)
      .post("/api/sources/panzhi/automation/jobs/claim")
      .send({})
      .expect(202);

    expect(claimed.body).toMatchObject({
      job: {
        id: queued.job.id,
        mode: "deep",
        state: "opening_page",
        leaseExpiresAt: "2026-08-04T02:02:00.000Z"
      },
      bearerToken: expect.any(String)
    });
    expect(claimed.body.job).not.toHaveProperty("normalizedRequestDigest");
    const token = claimed.body.bearerToken as string;
    const stored = f.database.prepare(`
      SELECT lease_token_digest, result_json
      FROM panzhi_browser_jobs WHERE id = ?
    `).get(queued.job.id) as {
      lease_token_digest: string;
      result_json: string | null;
    };
    expect(stored.lease_token_digest).toBe(
      createHash("sha256").update(token).digest("hex")
    );
    expect(JSON.stringify(stored)).not.toContain(token);

    const queryToken = await request(f.app)
      .post(`/api/sources/panzhi/automation/jobs/claim?token=${token}`)
      .send({})
      .expect(400);
    expect(JSON.stringify(queryToken.body)).not.toContain(token);

    await request(f.app)
      .post("/api/sources/panzhi/automation/jobs/claim")
      .send({ jobId: queued.job.id, bearerToken: token })
      .expect(400);
    const resumed = await request(f.app)
      .post("/api/sources/panzhi/automation/jobs/claim")
      .set(bearer(token))
      .send({ jobId: queued.job.id })
      .expect(200);
    expect(resumed.body).toMatchObject({
      job: { id: queued.job.id, state: "opening_page" },
      bearerToken: token
    });
    expect(resumed.body.job).not.toHaveProperty("normalizedRequestDigest");
    await request(f.app)
      .post("/api/sources/panzhi/automation/jobs/claim")
      .send({})
      .expect(204);
  });

  it("provides only authenticated, bounded local delays for the owned job", async () => {
    const f = fixture();
    const queued = f.automation.enqueue("deep");
    const claimed = await request(f.app)
      .post("/api/sources/panzhi/automation/jobs/claim")
      .send({})
      .expect(202);
    const token = claimed.body.bearerToken as string;
    const path =
      `/api/sources/panzhi/automation/jobs/${queued.job.id}/delay`;

    await request(f.app)
      .post(path)
      .send({ milliseconds: 0 })
      .expect(401);
    await request(f.app)
      .post(path)
      .set(bearer(token))
      .send({ milliseconds: 10_001 })
      .expect(400);
    await request(f.app)
      .post(path)
      .set(bearer(token))
      .send({ milliseconds: 0 })
      .expect(200, { completed: true });
  });

  it("authenticates job routes before validating malformed bodies", async () => {
    const f = fixture();
    const queued = f.automation.enqueue("deep");
    const claimed = await request(f.app)
      .post("/api/sources/panzhi/automation/jobs/claim")
      .send({})
      .expect(202);
    const token = claimed.body.bearerToken as string;

    for (const authorization of [undefined, "Bearer wrong-token"]) {
      const setAuthorization = <T extends request.Test>(test: T): T =>
        authorization === undefined
          ? test
          : test.set("Authorization", authorization) as T;
      await setAuthorization(request(f.app)
        .post(`/api/sources/panzhi/automation/jobs/${queued.job.id}/heartbeat`))
        .send({ unexpected: true })
        .expect(401);
      await setAuthorization(request(f.app)
        .post(`/api/sources/panzhi/automation/jobs/${queued.job.id}/state`))
        .send({ state: "not-a-state", extra: true })
        .expect(401);
      await setAuthorization(request(f.app)
        .post(`/api/sources/panzhi/automation/jobs/${queued.job.id}/snapshot`))
        .send({ malformed: true })
        .expect(401);
      await setAuthorization(request(f.app)
        .post(`/api/sources/panzhi/automation/jobs/${queued.job.id}/cancel`))
        .send({ unexpected: true })
        .expect(401);
    }

    await request(f.app)
      .post("/api/sources/panzhi/automation/jobs/claim")
      .set(bearer("wrong-token"))
      .send({})
      .expect(401);
    await request(f.app)
      .post("/api/sources/panzhi/automation/jobs/claim")
      .set(bearer("wrong-token"))
      .send({ jobId: "not-a-uuid", extra: true })
      .expect(401);
    await request(f.app)
      .post("/api/sources/panzhi/automation/jobs/claim")
      .set(bearer("wrong-token"))
      .send({ jobId: queued.job.id, extra: true })
      .expect(401);
    await request(f.app)
      .post("/api/sources/panzhi/automation/jobs/claim")
      .set(bearer(token))
      .send({ jobId: queued.job.id, extra: true })
      .expect(400);
  });

  it("renews leases, emits one notification per verification block, clears its marker on recovery, and invalidates cancellation", async () => {
    const f = fixture();
    const queued = f.automation.enqueue("deep");
    const claimed = await request(f.app)
      .post("/api/sources/panzhi/automation/jobs/claim")
      .send({})
      .expect(202);
    const token = claimed.body.bearerToken as string;
    f.setNow(new Date("2026-08-04T02:01:00.000Z"));
    const renewed = await request(f.app)
      .post(`/api/sources/panzhi/automation/jobs/${queued.job.id}/heartbeat`)
      .set(bearer(token))
      .send({})
      .expect(200);
    expect(renewed.body.leaseExpiresAt).toBe(
      "2026-08-04T02:03:00.000Z"
    );
    expect(renewed.body.job).not.toHaveProperty("normalizedRequestDigest");

    const first = await request(f.app)
      .post(`/api/sources/panzhi/automation/jobs/${queued.job.id}/state`)
      .set(bearer(token))
      .send({ state: "awaiting_user_verification" })
      .expect(200);
    expect(first.body.shouldNotify).toBe(true);
    expect(first.body.job.verificationNotifiedAt).toBe(
      "2026-08-04T02:01:00.000Z"
    );
    const repeated = await request(f.app)
      .post(`/api/sources/panzhi/automation/jobs/${queued.job.id}/state`)
      .set(bearer(token))
      .send({ state: "awaiting_user_verification" })
      .expect(200);
    expect(repeated.body.shouldNotify).toBe(false);

    const recovered = await request(f.app)
      .post(`/api/sources/panzhi/automation/jobs/${queued.job.id}/state`)
      .set(bearer(token))
      .send({ state: "applying_filters" })
      .expect(200);
    expect(recovered.body.job).toMatchObject({
      state: "applying_filters",
      verificationDeadlineAt: null,
      verificationNotifiedAt: null
    });

    await request(f.app)
      .post(`/api/sources/panzhi/automation/jobs/${queued.job.id}/cancel`)
      .set(bearer(token))
      .send({})
      .expect(200);
    await request(f.app)
      .post(`/api/sources/panzhi/automation/jobs/${queued.job.id}/heartbeat`)
      .set(bearer(token))
      .send({})
      .expect(401);
  });

  it("allows a safely recollecting submitting job to pause for verification and restart filters", async () => {
    const f = fixture();
    const queued = f.automation.enqueue("quick");
    const claimed = await request(f.app)
      .post("/api/sources/panzhi/automation/jobs/claim")
      .send({})
      .expect(202);
    const token = claimed.body.bearerToken as string;
    for (const state of ["applying_filters", "collecting", "submitting"]) {
      await request(f.app)
        .post(`/api/sources/panzhi/automation/jobs/${queued.job.id}/state`)
        .set(bearer(token))
        .send({ state })
        .expect(200);
    }

    const blocked = await request(f.app)
      .post(`/api/sources/panzhi/automation/jobs/${queued.job.id}/state`)
      .set(bearer(token))
      .send({ state: "awaiting_user_verification" })
      .expect(200);
    expect(blocked.body).toMatchObject({
      shouldNotify: true,
      job: {
        state: "awaiting_user_verification",
        verificationNotifiedAt: baseTime.toISOString()
      }
    });

    const resumed = await request(f.app)
      .post(`/api/sources/panzhi/automation/jobs/${queued.job.id}/state`)
      .set(bearer(token))
      .send({ state: "applying_filters" })
      .expect(200);
    expect(resumed.body.job).toMatchObject({
      state: "applying_filters",
      verificationDeadlineAt: null,
      verificationNotifiedAt: null
    });
  });

  it("uses one operation timestamp when a heartbeat crosses the verification deadline", async () => {
    const f = fixture();
    const queued = f.automation.enqueue("deep");
    const claimed = await request(f.app)
      .post("/api/sources/panzhi/automation/jobs/claim")
      .send({})
      .expect(202);
    const token = claimed.body.bearerToken as string;
    await request(f.app)
      .post(`/api/sources/panzhi/automation/jobs/${queued.job.id}/state`)
      .set(bearer(token))
      .send({ state: "awaiting_user_verification" })
      .expect(200);
    f.database.prepare(`
      UPDATE panzhi_browser_jobs
      SET verification_deadline_at = ?, lease_expires_at = ?
      WHERE id = ?
    `).run(
      "2026-08-05T02:00:00.000Z",
      "2026-08-05T02:05:00.000Z",
      queued.job.id
    );
    let clockReads = 0;
    f.setNowProvider(() => new Date(
      clockReads++ < 1
        ? "2026-08-05T01:59:59.999Z"
        : "2026-08-05T02:00:00.001Z"
    ));

    await request(f.app)
      .post(`/api/sources/panzhi/automation/jobs/${queued.job.id}/heartbeat`)
      .set(bearer(token))
      .send({})
      .expect(200);
    expect(clockReads).toBe(1);
    expect(f.automationRepository.getJob(queued.job.id)).toMatchObject({
      state: "awaiting_user_verification",
      error: null
    });

    f.setNow(new Date("2026-08-05T02:00:00.001Z"));
    await request(f.app)
      .get("/api/sources/panzhi/automation/status")
      .expect(200);
    expect(f.automationRepository.getJob(queued.job.id)).toMatchObject({
      state: "failed",
      error: "captcha_required"
    });
    expect(f.schedule.list().find(({ source }) => source === "panzhi"))
      .toMatchObject({
        lastState: "failed",
        lastError: "captcha_required"
      });
  });

  it("recovers an expired lease in status and keeps one notification across reclaim until filters recover", async () => {
    const f = fixture();
    const queued = f.automation.enqueue("deep");
    const claimed = await request(f.app)
      .post("/api/sources/panzhi/automation/jobs/claim")
      .send({})
      .expect(202);
    const firstToken = claimed.body.bearerToken as string;
    const firstBlock = await request(f.app)
      .post(`/api/sources/panzhi/automation/jobs/${queued.job.id}/state`)
      .set(bearer(firstToken))
      .send({ state: "awaiting_user_verification" })
      .expect(200);
    expect(firstBlock.body.shouldNotify).toBe(true);

    f.setNow(new Date("2026-08-04T02:03:00.000Z"));
    const status = await request(f.app)
      .get("/api/sources/panzhi/automation/status")
      .expect(200);
    expect(status.body.currentJob).toMatchObject({
      id: queued.job.id,
      state: "queued"
    });
    expect(f.schedule.list().find(({ source }) => source === "panzhi"))
      .toMatchObject({
        lastState: "failed",
        lastError: "automation_lease_expired"
      });

    const reclaimed = await request(f.app)
      .post("/api/sources/panzhi/automation/jobs/claim")
      .send({})
      .expect(202);
    const secondToken = reclaimed.body.bearerToken as string;
    const continuous = await request(f.app)
      .post(`/api/sources/panzhi/automation/jobs/${queued.job.id}/state`)
      .set(bearer(secondToken))
      .send({ state: "awaiting_user_verification" })
      .expect(200);
    expect(continuous.body.shouldNotify).toBe(false);

    const recovered = await request(f.app)
      .post(`/api/sources/panzhi/automation/jobs/${queued.job.id}/state`)
      .set(bearer(secondToken))
      .send({ state: "applying_filters" })
      .expect(200);
    expect(recovered.body.job).not.toHaveProperty("normalizedRequestDigest");
    expect(recovered.body.job).toMatchObject({
      verificationDeadlineAt: null,
      verificationNotifiedAt: null
    });
    const nextBlock = await request(f.app)
      .post(`/api/sources/panzhi/automation/jobs/${queued.job.id}/state`)
      .set(bearer(secondToken))
      .send({ state: "awaiting_user_verification" })
      .expect(200);
    expect(nextBlock.body.shouldNotify).toBe(true);
  });

  it("finalizes the schedule for extension failure and cancellation without advancing cadence", async () => {
    const failed = fixture();
    const failedJob = failed.automation.enqueue("deep").job;
    const failedClaim = await request(failed.app)
      .post("/api/sources/panzhi/automation/jobs/claim")
      .send({})
      .expect(202);
    const failedBefore = failed.schedule.list().find(
      ({ source }) => source === "panzhi"
    )!;
    const failure = await request(failed.app)
      .post(`/api/sources/panzhi/automation/jobs/${failedJob.id}/state`)
      .set(bearer(failedClaim.body.bearerToken))
      .send({ state: "failed", error: "extension_failed" })
      .expect(200);
    expect(failure.body.job).not.toHaveProperty("normalizedRequestDigest");
    const failedAfter = failed.schedule.list().find(
      ({ source }) => source === "panzhi"
    )!;
    expect(failedAfter).toMatchObject({
      lastState: "failed",
      lastError: "extension_failed"
    });
    expect(failedAfter.nextQuickAt).toBe(failedBefore.nextQuickAt);
    expect(failedAfter.nextDeepAt).toBe(failedBefore.nextDeepAt);

    const cancelled = fixture();
    const cancelledJob = cancelled.automation.enqueue("deep").job;
    const cancelledClaim = await request(cancelled.app)
      .post("/api/sources/panzhi/automation/jobs/claim")
      .send({})
      .expect(202);
    const cancellation = await request(cancelled.app)
      .post(`/api/sources/panzhi/automation/jobs/${cancelledJob.id}/cancel`)
      .set(bearer(cancelledClaim.body.bearerToken))
      .send({})
      .expect(200);
    expect(cancellation.body.job).not.toHaveProperty(
      "normalizedRequestDigest"
    );
    expect(cancelled.schedule.list().find(
      ({ source }) => source === "panzhi"
    )).toMatchObject({
      lastState: "failed",
      lastError: "automation_cancelled"
    });
  });

  it("fails an overdue verification atomically and reports the completed expiry as not found", async () => {
    const f = fixture();
    const queued = f.automation.enqueue("deep");
    const claimed = await request(f.app)
      .post("/api/sources/panzhi/automation/jobs/claim")
      .send({})
      .expect(202);
    const token = claimed.body.bearerToken as string;
    await request(f.app)
      .post(`/api/sources/panzhi/automation/jobs/${queued.job.id}/state`)
      .set(bearer(token))
      .send({ state: "awaiting_user_verification" })
      .expect(200);
    f.database.prepare(`
      UPDATE panzhi_browser_jobs
      SET lease_expires_at = ?
      WHERE id = ?
    `).run("2026-08-05T02:02:00.000Z", queued.job.id);
    f.setNow(new Date("2026-08-05T02:00:00.001Z"));

    const status = await request(f.app)
      .get("/api/sources/panzhi/automation/status")
      .expect(200);
    expect(status.body.currentJob).toMatchObject({
      state: "failed",
      error: "captcha_required"
    });
    expect(f.schedule.list().find(({ source }) => source === "panzhi"))
      .toMatchObject({
        lastState: "failed",
        lastError: "captcha_required"
      });
    await request(f.app)
      .post(`/api/sources/panzhi/automation/jobs/${queued.job.id}/heartbeat`)
      .set(bearer(token))
      .send({})
      .expect(401);
  });

  it("finalizes an overdue verification when claim is the first maintenance request", async () => {
    const f = fixture();
    const queued = f.automation.enqueue("deep");
    const claimed = await request(f.app)
      .post("/api/sources/panzhi/automation/jobs/claim")
      .send({})
      .expect(202);
    await request(f.app)
      .post(`/api/sources/panzhi/automation/jobs/${queued.job.id}/state`)
      .set(bearer(claimed.body.bearerToken))
      .send({ state: "awaiting_user_verification" })
      .expect(200);
    f.database.prepare(`
      UPDATE panzhi_browser_jobs
      SET lease_expires_at = ?
      WHERE id = ?
    `).run("2026-08-05T02:02:00.000Z", queued.job.id);
    f.setNow(new Date("2026-08-05T02:00:00.001Z"));

    await request(f.app)
      .post("/api/sources/panzhi/automation/jobs/claim")
      .send({})
      .expect(204);
    expect(f.automationRepository.getJob(queued.job.id)).toMatchObject({
      state: "failed",
      error: "captcha_required"
    });
    expect(f.schedule.list().find(({ source }) => source === "panzhi"))
      .toMatchObject({
        lastState: "failed",
        lastError: "captcha_required"
      });
  });

  it("maps malformed, unauthorized, missing, expired, illegal-transition, and body-mismatch errors without leaking credentials", async () => {
    const f = fixture();
    const queued = f.automation.enqueue("deep");
    const claimed = await request(f.app)
      .post("/api/sources/panzhi/automation/jobs/claim")
      .send({})
      .expect(202);
    const token = claimed.body.bearerToken as string;

    const malformed = await request(f.app)
      .post(`/api/sources/panzhi/automation/jobs/${queued.job.id}/heartbeat`)
      .set(bearer(token))
      .send({ unexpected: true })
      .expect(400);
    const wrong = await request(f.app)
      .post(`/api/sources/panzhi/automation/jobs/${queued.job.id}/heartbeat`)
      .set(bearer("wrong-token"))
      .send({})
      .expect(401);
    const missing = await request(f.app)
      .post("/api/sources/panzhi/automation/jobs/00000000-0000-4000-8000-000000000000/heartbeat")
      .set(bearer(token))
      .send({})
      .expect(404);
    const illegal = await request(f.app)
      .post(`/api/sources/panzhi/automation/jobs/${queued.job.id}/state`)
      .set(bearer(token))
      .send({ state: "collecting" })
      .expect(409);
    const mismatch = await request(f.app)
      .post("/api/sources/panzhi/automation/jobs/claim")
      .set(bearer(token))
      .send({})
      .expect(401);

    f.setNow(new Date("2026-08-04T02:02:00.001Z"));
    const expired = await request(f.app)
      .post(`/api/sources/panzhi/automation/jobs/${queued.job.id}/heartbeat`)
      .set(bearer(token))
      .send({})
      .expect(404);
    for (const response of [malformed, wrong, missing, illegal, mismatch, expired]) {
      expect(JSON.stringify(response.body)).not.toContain(token);
      expect(JSON.stringify(response.body)).not.toMatch(/digest|result_json/i);
    }
  });

  it("authenticates every endpoint before expiring active verification", async () => {
    const f = fixture();
    const queued = f.automation.enqueue("deep");
    const claimed = await request(f.app)
      .post("/api/sources/panzhi/automation/jobs/claim")
      .send({})
      .expect(202);
    const token = claimed.body.bearerToken as string;
    await request(f.app)
      .post(`/api/sources/panzhi/automation/jobs/${queued.job.id}/state`)
      .set(bearer(token))
      .send({ state: "awaiting_user_verification" })
      .expect(200);
    f.database.prepare(`
      UPDATE panzhi_browser_jobs
      SET lease_expires_at = ?
      WHERE id = ?
    `).run("2026-08-05T02:02:00.000Z", queued.job.id);
    f.setNow(new Date("2026-08-05T02:00:00.001Z"));

    await request(f.app)
      .post("/api/sources/panzhi/automation/jobs/claim")
      .set(bearer("wrong-token"))
      .send({ jobId: queued.job.id })
      .expect(401);
    await request(f.app)
      .post(`/api/sources/panzhi/automation/jobs/${queued.job.id}/heartbeat`)
      .set(bearer("wrong-token"))
      .send({})
      .expect(401);
    await request(f.app)
      .post(`/api/sources/panzhi/automation/jobs/${queued.job.id}/state`)
      .set(bearer("wrong-token"))
      .send({ state: "applying_filters" })
      .expect(401);
    await request(f.app)
      .post(`/api/sources/panzhi/automation/jobs/${queued.job.id}/snapshot`)
      .set(bearer("wrong-token"))
      .send(snapshot(["EXPIRED-WRONG-TOKEN"]))
      .expect(401);
    await request(f.app)
      .post(`/api/sources/panzhi/automation/jobs/${queued.job.id}/cancel`)
      .set(bearer("wrong-token"))
      .send({})
      .expect(401);
    expect(f.automationRepository.getJob(queued.job.id)).toMatchObject({
      state: "awaiting_user_verification"
    });

    await request(f.app)
      .post(`/api/sources/panzhi/automation/jobs/${queued.job.id}/heartbeat`)
      .set(bearer(token))
      .send({})
      .expect(404);
    expect(f.automationRepository.getJob(queued.job.id)).toMatchObject({
      state: "failed",
      error: "captcha_required"
    });
    expect(f.schedule.list().find(({ source }) => source === "panzhi"))
      .toMatchObject({
        attentionRequired: false,
        backoffUntil: "2026-08-05T04:00:00.001Z",
        lastError: "captcha_required"
      });
  });

  it("uses completed tokens for success terminal checks and invalidates failed or cancelled tokens", async () => {
    const succeeded = fixture();
    const completed = await claimAndAdvanceToSubmitting(succeeded);
    const payload = snapshot(["TERMINAL-AUTH"]);
    await request(succeeded.app)
      .post(`/api/sources/panzhi/automation/jobs/${completed.jobId}/snapshot`)
      .set(bearer(completed.token))
      .send(payload)
      .expect(200);

    await request(succeeded.app)
      .post("/api/sources/panzhi/automation/jobs/claim")
      .set(bearer("wrong-token"))
      .send({ jobId: completed.jobId })
      .expect(401);
    await request(succeeded.app)
      .post(`/api/sources/panzhi/automation/jobs/${completed.jobId}/heartbeat`)
      .set(bearer("wrong-token"))
      .send({})
      .expect(401);
    await request(succeeded.app)
      .post(`/api/sources/panzhi/automation/jobs/${completed.jobId}/state`)
      .set(bearer("wrong-token"))
      .send({ state: "failed", error: "wrong_token" })
      .expect(401);
    await request(succeeded.app)
      .post(`/api/sources/panzhi/automation/jobs/${completed.jobId}/cancel`)
      .set(bearer("wrong-token"))
      .send({})
      .expect(401);
    await request(succeeded.app)
      .post(`/api/sources/panzhi/automation/jobs/${completed.jobId}/snapshot`)
      .set(bearer("wrong-token"))
      .send(payload)
      .expect(401);

    await request(succeeded.app)
      .post(`/api/sources/panzhi/automation/jobs/${completed.jobId}/heartbeat`)
      .set(bearer(completed.token))
      .send({})
      .expect(409);
    await request(succeeded.app)
      .post(`/api/sources/panzhi/automation/jobs/${completed.jobId}/state`)
      .set(bearer(completed.token))
      .send({ state: "failed", error: "already_done" })
      .expect(409);
    await request(succeeded.app)
      .post(`/api/sources/panzhi/automation/jobs/${completed.jobId}/cancel`)
      .set(bearer(completed.token))
      .send({})
      .expect(409);

    const failed = fixture();
    const failedJob = failed.automation.enqueue("deep").job;
    const failedClaim = await request(failed.app)
      .post("/api/sources/panzhi/automation/jobs/claim")
      .send({})
      .expect(202);
    await request(failed.app)
      .post(`/api/sources/panzhi/automation/jobs/${failedJob.id}/state`)
      .set(bearer(failedClaim.body.bearerToken))
      .send({ state: "failed", error: "extension_failed" })
      .expect(200);
    await request(failed.app)
      .post(`/api/sources/panzhi/automation/jobs/${failedJob.id}/heartbeat`)
      .set(bearer(failedClaim.body.bearerToken))
      .send({})
      .expect(401);

    const cancelled = fixture();
    const cancelledJob = cancelled.automation.enqueue("deep").job;
    const cancelledClaim = await request(cancelled.app)
      .post("/api/sources/panzhi/automation/jobs/claim")
      .send({})
      .expect(202);
    await request(cancelled.app)
      .post(`/api/sources/panzhi/automation/jobs/${cancelledJob.id}/cancel`)
      .set(bearer(cancelledClaim.body.bearerToken))
      .send({})
      .expect(200);
    await request(cancelled.app)
      .post(`/api/sources/panzhi/automation/jobs/${cancelledJob.id}/heartbeat`)
      .set(bearer(cancelledClaim.body.bearerToken))
      .send({})
      .expect(401);
  });

  it("uses fixed automation failure backoffs without requesting attention or advancing cadence", () => {
    const generic = fixture();
    const original = generic.schedule.list().find(
      ({ source }) => source === "panzhi"
    )!;
    for (const [index, minutes] of [5, 15, 60, 120].entries()) {
      const at = new Date(baseTime.getTime() + index * 1_000);
      generic.schedule.markAutomationFailedWithoutAdvancing(
        "panzhi",
        "deep",
        "failed",
        "extension_failed",
        at,
        () => 0
      );
      expect(generic.schedule.list().find(
        ({ source }) => source === "panzhi"
      )).toMatchObject({
        attentionRequired: false,
        backoffUntil: new Date(at.getTime() + minutes * 60_000).toISOString(),
        nextQuickAt: original.nextQuickAt,
        nextDeepAt: original.nextDeepAt
      });
    }

    const captcha = fixture();
    captcha.schedule.markAutomationFailedWithoutAdvancing(
      "panzhi",
      "deep",
      "failed",
      "captcha_required",
      baseTime,
      () => 0
    );
    expect(captcha.schedule.list().find(({ source }) => source === "panzhi"))
      .toMatchObject({
        attentionRequired: false,
        backoffUntil: "2026-08-04T04:00:00.000Z"
      });

    const rateLimited = fixture();
    for (const [index, minutes] of [30, 60, 120, 240, 360, 360].entries()) {
      const at = new Date(baseTime.getTime() + index * 1_000);
      rateLimited.schedule.markAutomationFailedWithoutAdvancing(
        "panzhi",
        "quick",
        "partial",
        "rate_limited",
        at,
        () => 1
      );
      expect(rateLimited.schedule.list().find(
        ({ source }) => source === "panzhi"
      )?.backoffUntil).toBe(
        new Date(at.getTime() + minutes * 60_000).toISOString()
      );
    }
  });

  it("does not let an older source success overwrite an automation failure", async () => {
    const f = fixture();
    f.publisher.publish(snapshot(["SYNC-BASELINE"]), baseTime);
    const queued = f.automation.enqueue("deep");
    const claimed = await request(f.app)
      .post("/api/sources/panzhi/automation/jobs/claim")
      .send({})
      .expect(202);
    f.setNow(new Date("2026-08-04T02:01:00.000Z"));
    await request(f.app)
      .post(`/api/sources/panzhi/automation/jobs/${queued.job.id}/state`)
      .set(bearer(claimed.body.bearerToken))
      .send({ state: "failed", error: "extension_failed" })
      .expect(200);
    const failedSchedule = f.schedule.list().find(
      ({ source }) => source === "panzhi"
    )!;

    f.schedule.synchronizeSourceStatuses(
      f.listings.getSourceStatuses(new Date("2026-08-04T02:01:00.000Z"))
    );
    expect(f.schedule.list().find(({ source }) => source === "panzhi"))
      .toMatchObject({
        lastState: "failed",
        lastError: "extension_failed",
        backoffUntil: failedSchedule.backoffUntil
      });

    const newerSuccessAt = new Date("2026-08-04T02:20:00.000Z");
    f.publisher.publish(snapshot(["SYNC-BASELINE", "SYNC-NEW"]), newerSuccessAt);
    f.schedule.synchronizeSourceStatuses(
      f.listings.getSourceStatuses(newerSuccessAt)
    );
    expect(f.schedule.list().find(({ source }) => source === "panzhi"))
      .toMatchObject({
        lastState: "success",
        lastFinishedAt: newerSuccessAt.toISOString(),
        lastError: null
      });
  });

  it("treats omitted snapshot mode as deep for publishing and exact replay", async () => {
    const f = fixture();
    const { jobId, token } = await claimAndAdvanceToSubmitting(f);
    const explicitDeep = snapshot(["DEFAULT-DEEP-REPLAY"]);
    const { mode: _mode, ...omittedMode } = explicitDeep;

    const first = await request(f.app)
      .post(`/api/sources/panzhi/automation/jobs/${jobId}/snapshot`)
      .set(bearer(token))
      .send(omittedMode)
      .expect(200);
    expect(first.body).toMatchObject({
      mode: "deep",
      published: true,
      deduplicated: false
    });

    const replay = await request(f.app)
      .post(`/api/sources/panzhi/automation/jobs/${jobId}/snapshot`)
      .set(bearer(token))
      .send(explicitDeep)
      .expect(200);
    expect(replay.body).toEqual({ ...first.body, deduplicated: true });
  });

  it("publishes and completes a submitting job and schedule in one transaction, then replays canonically without new rows", async () => {
    const f = fixture();
    const { jobId, token } = await claimAndAdvanceToSubmitting(f);
    const payload = snapshot(["PUBLISH-1"]);
    const beforeSchedule = f.schedule.list().find(
      ({ source }) => source === "panzhi"
    )!;
    f.setNow(new Date("2026-08-04T02:01:00.000Z"));

    const first = await request(f.app)
      .post(`/api/sources/panzhi/automation/jobs/${jobId}/snapshot`)
      .set(bearer(token))
      .send(payload)
      .expect(200);
    expect(first.body).toMatchObject({
      source: "panzhi",
      mode: "deep",
      state: "success",
      published: true,
      deduplicated: false
    });
    const runId = first.body.scanRunId as number;
    expect(f.automationRepository.getJob(jobId)).toMatchObject({
      state: "success",
      scanRunId: runId
    });
    expect(f.schedule.list().find(({ source }) => source === "panzhi"))
      .toMatchObject({
        lastMode: "deep",
        lastState: "success",
        lastError: null
      });
    expect(f.schedule.list().find(({ source }) => source === "panzhi")!
      .nextQuickAt).toBe(beforeSchedule.nextQuickAt);
    expect(f.schedule.list().find(({ source }) => source === "panzhi")!
      .nextDeepAt).not.toBe(beforeSchedule.nextDeepAt);
    const completedSchedule = f.schedule.list().find(
      ({ source }) => source === "panzhi"
    )!;
    f.schedule.synchronizeSourceStatuses(
      f.listings.getSourceStatuses(new Date("2026-08-04T02:01:00.000Z"))
    );
    expect(f.schedule.list().find(({ source }) => source === "panzhi"))
      .toMatchObject({
        nextQuickAt: completedSchedule.nextQuickAt,
        nextDeepAt: completedSchedule.nextDeepAt
      });
    expect(f.tracker.snapshot()).toMatchObject({ runId, state: "success" });

    const before = {
      runs: count(f.database, "scan_runs"),
      results: count(f.database, "scan_source_results"),
      events: count(f.database, "refresh_events")
    };
    const reordered = {
      items: payload.items,
      stopReason: payload.stopReason,
      observedUniqueCount: payload.observedUniqueCount,
      loadActionCount: payload.loadActionCount,
      filterProof: payload.filterProof,
      mode: payload.mode
    };
    const replay = await request(f.app)
      .post(`/api/sources/panzhi/automation/jobs/${jobId}/snapshot`)
      .set(bearer(token))
      .send(reordered)
      .expect(200);
    expect(replay.body).toEqual({ ...first.body, deduplicated: true });
    expect({
      runs: count(f.database, "scan_runs"),
      results: count(f.database, "scan_source_results"),
      events: count(f.database, "refresh_events")
    }).toEqual(before);

    await request(f.app)
      .post(`/api/sources/panzhi/automation/jobs/${jobId}/snapshot`)
      .set(bearer("wrong-token"))
      .send(payload)
      .expect(401);
    await request(f.app)
      .post(`/api/sources/panzhi/automation/jobs/${jobId}/snapshot`)
      .set(bearer(token))
      .send({
        ...payload,
        items: [{ ...payload.items[0], title: "different title" }]
      })
      .expect(409);
  });

  it("keeps a refresh-conflicted snapshot unbound and retryable after the admission lease is released", async () => {
    const f = fixture();
    const { jobId, token } = await claimAndAdvanceToSubmitting(f);
    const held = f.admission.withAllSourcesLease(() => "held");
    expect(held.kind).toBe("acquired");

    const conflict = await request(f.app)
      .post(`/api/sources/panzhi/automation/jobs/${jobId}/snapshot`)
      .set(bearer(token))
      .send(snapshot(["CONFLICT-RETRY"]))
      .expect(409);
    expect(conflict.body).toMatchObject({
      error: "refresh_conflict",
      activeKind: "all_sources"
    });
    expect(f.automationRepository.getJob(jobId)).toMatchObject({
      state: "submitting",
      normalizedRequestDigest: null
    });
    expect(count(f.database, "scan_runs")).toBe(0);

    if (held.kind === "acquired") held.lease.release();
    const retried = await request(f.app)
      .post(`/api/sources/panzhi/automation/jobs/${jobId}/snapshot`)
      .set(bearer(token))
      .send(snapshot(["CONFLICT-RETRY"]))
      .expect(200);
    expect(retried.body.deduplicated).toBe(false);
  });

  it("advances only the quick cadence after a successful quick job", async () => {
    const f = fixture();
    f.publisher.publish(snapshot(["QUICK-BASELINE"]), baseTime);
    const { jobId, token } = await claimAndAdvanceToSubmitting(f, "quick");
    const before = f.schedule.list().find(
      ({ source }) => source === "panzhi"
    )!;
    f.setNow(new Date("2026-08-04T02:01:00.000Z"));

    await request(f.app)
      .post(`/api/sources/panzhi/automation/jobs/${jobId}/snapshot`)
      .set(bearer(token))
      .send(snapshot(["QUICK-WINDOW"], {
        mode: "quick",
        loadActionCount: 2,
        stopReason: "quick_window"
      }))
      .expect(200);
    const after = f.schedule.list().find(
      ({ source }) => source === "panzhi"
    )!;
    expect(after.nextQuickAt).not.toBe(before.nextQuickAt);
    expect(after.nextDeepAt).toBe(before.nextDeepAt);
  });

  it("completes a strict-empty quick job while preserving its baseline", async () => {
    const f = fixture();
    f.publisher.publish(snapshot(["EMPTY-JOB-BASELINE"]), baseTime);
    const { jobId, token } = await claimAndAdvanceToSubmitting(f, "quick");

    const response = await request(f.app)
      .post(`/api/sources/panzhi/automation/jobs/${jobId}/snapshot`)
      .set(bearer(token))
      .send(snapshot([], {
        mode: "quick",
        loadActionCount: 1,
        stopReason: "empty_result"
      }))
      .expect(200);

    expect(response.body).toMatchObject({
      state: "success",
      observedItemCount: 0,
      publishedItemCount: 1,
      preservedItemCount: 1,
      published: true,
      deduplicated: false
    });
    expect(f.automationRepository.getJob(jobId)).toMatchObject({
      state: "success",
      error: null,
      scanRunId: expect.any(Number)
    });
    expect(f.listings.getListings().filter(({ source }) =>
      source === "panzhi"
    )).toEqual([expect.objectContaining({
      sourceListingId: "EMPTY-JOB-BASELINE"
    })]);
  });

  it("fails an anomaly-guard job atomically without advancing either due time and retains its trusted snapshot", async () => {
    const f = fixture();
    const trustedIds = Array.from(
      { length: 20 },
      (_, index) => `TRUSTED-${String(index).padStart(2, "0")}`
    );
    f.publisher.publish(snapshot(trustedIds, { loadActionCount: 10 }), baseTime);
    const scheduleBefore = f.schedule.list().find(
      ({ source }) => source === "panzhi"
    )!;
    const { jobId, token } = await claimAndAdvanceToSubmitting(f);

    const response = await request(f.app)
      .post(`/api/sources/panzhi/automation/jobs/${jobId}/snapshot`)
      .set(bearer(token))
      .send(snapshot(["ANOMALY-1", "ANOMALY-2"], {
        loadActionCount: 2
      }))
      .expect(200);
    expect(response.body).toMatchObject({
      state: "quarantined",
      published: false,
      deduplicated: false
    });
    expect(f.automationRepository.getJob(jobId)).toMatchObject({
      state: "failed",
      error: "anomaly_guard",
      scanRunId: null
    });
    const scheduleAfter = f.schedule.list().find(
      ({ source }) => source === "panzhi"
    )!;
    expect(scheduleAfter).toMatchObject({
      lastMode: "deep",
      lastState: "partial",
      lastError: "anomaly_guard",
      consecutiveFailures: 1,
      attentionRequired: false
    });
    expect(scheduleAfter.nextQuickAt).toBe(scheduleBefore.nextQuickAt);
    expect(scheduleAfter.nextDeepAt).toBe(scheduleBefore.nextDeepAt);
    expect(scheduleAfter.backoffUntil).not.toBeNull();
    expect(f.listings.getListings().filter(({ source }) =>
      source === "panzhi"
    ).map(({ sourceListingId }) => sourceListingId)).toEqual(trustedIds);
  });

  it("rolls scan, job, schedule, listings, observations, and events back when the schedule hook fails", async () => {
    const f = fixture();
    const trustedIds = Array.from(
      { length: 20 },
      (_, index) => `ROLLBACK-${String(index).padStart(2, "0")}`
    );
    f.publisher.publish(snapshot(trustedIds, { loadActionCount: 10 }), baseTime);
    const { jobId, token } = await claimAndAdvanceToSubmitting(f);
    f.database.exec(`
      CREATE TRIGGER reject_automation_failure
      BEFORE UPDATE ON refresh_schedule
      WHEN NEW.source = 'panzhi' AND NEW.last_error = 'anomaly_guard'
      BEGIN
        SELECT RAISE(ABORT, 'injected schedule failure');
      END;
    `);
    const before = {
      runs: count(f.database, "scan_runs"),
      results: count(f.database, "scan_source_results"),
      observations: count(f.database, "listing_observations"),
      events: count(f.database, "refresh_events"),
      schedule: f.schedule.list().find(({ source }) => source === "panzhi"),
      listings: f.listings.getListings()
    };

    await request(f.app)
      .post(`/api/sources/panzhi/automation/jobs/${jobId}/snapshot`)
      .set(bearer(token))
      .send(snapshot(["ROLLBACK-LOW-1", "ROLLBACK-LOW-2"], {
        loadActionCount: 2
      }))
      .expect(500);

    expect({
      runs: count(f.database, "scan_runs"),
      results: count(f.database, "scan_source_results"),
      observations: count(f.database, "listing_observations"),
      events: count(f.database, "refresh_events"),
      schedule: f.schedule.list().find(({ source }) => source === "panzhi"),
      listings: f.listings.getListings()
    }).toEqual(before);
    expect(f.automationRepository.getJob(jobId)).toMatchObject({
      state: "submitting",
      normalizedRequestDigest: null
    });
  });

  it("rejects automation captcha snapshots without a partial publish while the manual publisher remains compatible", async () => {
    const f = fixture();
    const { jobId, token } = await claimAndAdvanceToSubmitting(f);
    const captcha = snapshot(["CAPTCHA-AUTO"], {
      stopReason: "captcha_required"
    });

    await request(f.app)
      .post(`/api/sources/panzhi/automation/jobs/${jobId}/snapshot`)
      .set(bearer("wrong-token"))
      .send(captcha)
      .expect(401);
    await request(f.app)
      .post(`/api/sources/panzhi/automation/jobs/${jobId}/snapshot`)
      .set(bearer(token))
      .send(captcha)
      .expect(409);
    expect(count(f.database, "scan_runs")).toBe(0);
    expect(f.automationRepository.getJob(jobId)).toMatchObject({
      state: "submitting",
      normalizedRequestDigest: null
    });

    const manual = await request(f.app)
      .post("/api/sources/panzhi/browser-snapshot")
      .send(captcha)
      .expect(200);
    expect(manual.body).toMatchObject({
      source: "panzhi",
      mode: "deep",
      state: "partial",
      observedItemCount: 1
    });
  });

  it("upgrades an initial quick enqueue to deep and preserves quick after a trusted full baseline", () => {
    const f = fixture();
    expect(f.automation.enqueue("quick")).toMatchObject({
      job: { mode: "deep", state: "queued" },
      created: true
    });

    const complete = fixture();
    complete.publisher.publish(snapshot(["BASELINE"]), baseTime);
    expect(complete.automation.enqueue("quick")).toMatchObject({
      job: { mode: "quick", state: "queued" },
      created: true
    });
  });
});
