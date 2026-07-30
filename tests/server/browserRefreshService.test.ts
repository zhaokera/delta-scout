// @vitest-environment node

import { createDatabase } from "../../src/server/db.js";
import type {
  BrowserDetailBatch,
  BrowserFilterProof,
  BrowserListBatch,
  BrowserLoadEvent,
  BrowserPause
} from "../../src/server/browserRefresh/contracts.js";
import {
  BrowserRefreshRepository
} from "../../src/server/browserRefresh/repository.js";
import {
  BROWSER_REFRESH_STATE_COMMANDS,
  BrowserRefreshServiceError,
  JiaoyimaoBrowserTaskService
} from "../../src/server/browserRefresh/service.js";

const baseTime = new Date("2026-07-30T10:00:00.000Z");
const filterUrl =
  "https://www.jiaoyimao.com/jg2007840/f8845003-c8845004/o110/";

function proof(overrides: Partial<BrowserFilterProof> = {}): BrowserFilterProof {
  return {
    currentUrl: filterUrl,
    gameLabel: "三角洲行动",
    platformLabel: "QQ",
    categoryLabel: "账号",
    m7FilterLabels: [
      "M7棱镜攻势极品S",
      "M7棱镜攻势极品A",
      "M7棱镜攻势极品B",
      "M7棱镜攻势极品C"
    ],
    observedAt: baseTime.toISOString(),
    ...overrides
  };
}

function listBatch(
  items: Array<[string, number | null]>,
  sequence = 1
): BrowserListBatch {
  return {
    sequence,
    observedAt: baseTime.toISOString(),
    items: items.map(([sourceListingId, priceCny]) => ({
      sourceListingId,
      url:
        `https://www.jiaoyimao.com/jg2007840/${sourceListingId}.html`,
      title: `商品 ${sourceListingId}`,
      rawText: "商品卡片",
      priceCny
    }))
  };
}

function loadEvent(
  sequence: number,
  count: number,
  added: number,
  overrides: Partial<BrowserLoadEvent> = {}
): BrowserLoadEvent {
  return {
    sequence,
    observedUniqueCount: count,
    newItemCount: added,
    visibleTotalCount: null,
    endMarkerVisible: false,
    loadingVisible: false,
    blockingState: "none",
    observedAt: baseTime.toISOString(),
    ...overrides
  };
}

function details(
  ids: string[],
  sequence = 1,
  actionPermit?: string
): BrowserDetailBatch {
  return {
    sequence,
    items: ids.map((sourceListingId) => ({
      sourceListingId,
      url:
        `https://www.jiaoyimao.com/jg2007840/${sourceListingId}.html`,
      observedAt: baseTime.toISOString(),
      sections: {
        head: "详情标题",
        report: "验号报告",
        safety: "安全保障",
        description: "商品描述"
      }
    })),
    ...(actionPermit ? { actionPermit } : {})
  };
}

function fixture(random = 0) {
  const database = createDatabase(":memory:");
  const repository = new BrowserRefreshRepository(database);
  let time = baseTime.getTime();
  const completed: string[] = [];
  const service = new JiaoyimaoBrowserTaskService(repository, {
    now: () => new Date(time),
    random: () => random,
    completeJob: (jobId) => {
      completed.push(jobId);
    }
  });
  return {
    database,
    repository,
    service,
    completed,
    setTime: (next: number) => {
      time = next;
    },
    advance: (milliseconds: number) => {
      time += milliseconds;
    }
  };
}

function claimed(f = fixture()) {
  const created = f.service.create();
  const claim = f.service.claim(created.id, created.claimCode);
  return { ...f, id: created.id, token: claim.bridgeToken };
}

function expectCode(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error("Expected operation to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(BrowserRefreshServiceError);
    expect((error as BrowserRefreshServiceError).code).toBe(code);
  }
}

describe("JiaoyimaoBrowserTaskService", () => {
  it("defines command guards for every contract state", () => {
    expect(Object.keys(BROWSER_REFRESH_STATE_COMMANDS).sort()).toEqual([
      "awaiting_codex",
      "awaiting_user_verification",
      "cancelled",
      "collecting_details",
      "collecting_list",
      "committing",
      "cooling_down",
      "expired",
      "failed",
      "paused",
      "quarantined",
      "success",
      "validating"
    ]);
  });

  it("only a valid one-time claim moves awaiting_codex to collecting_list", () => {
    const f = fixture();
    const created = f.service.create();
    expect(created.state).toBe("awaiting_codex");
    expectCode(
      () => f.service.getWork(created.id, "not-a-token"),
      "bridge_unauthorized"
    );
    const result = f.service.claim(created.id, created.claimCode);
    expect(result.state).toBe("collecting_list");
    expectCode(
      () => f.service.claim(created.id, created.claimCode),
      "invalid_transition"
    );
  });

  it("requires valid visible filter proof before staging list batches", () => {
    const missing = claimed();
    expectCode(
      () => missing.service.submitListBatch(
        missing.id,
        missing.token,
        listBatch([["1", 100]])
      ),
      "filter_mismatch"
    );
    expect(missing.repository.getJob(missing.id, baseTime)).toMatchObject({
      state: "paused",
      reason: "filter_mismatch"
    });

    const f = claimed();
    expectCode(
      () => f.service.saveFilterProof(
        f.id,
        f.token,
        proof({ platformLabel: "微信" })
      ),
      "filter_mismatch"
    );
    expect(f.repository.getJob(f.id, baseTime)).toMatchObject({
      state: "paused",
      reason: "filter_mismatch"
    });
  });

  it("builds a deterministic required-detail queue at natural end", () => {
    const f = claimed();
    f.service.saveFilterProof(f.id, f.token, proof());
    f.service.submitListBatch(
      f.id,
      f.token,
      listBatch([["30", null], ["10", 6_001], ["20", 6_000]])
    );
    f.service.submitLoadEvent(
      f.id,
      f.token,
      loadEvent(1, 3, 3, {
        visibleTotalCount: 3,
        endMarkerVisible: true
      })
    );
    expect(f.repository.getJob(f.id, baseTime)).toMatchObject({
      state: "collecting_details",
      detailRequiredCount: 2,
      nextActionAt: "2026-07-30T10:00:02.000Z"
    });
    f.advance(1_999);
    expectCode(
      () => f.service.getWork(f.id, f.token),
      "action_too_early"
    );
    f.advance(1);
    const work = f.service.getWork(f.id, f.token);
    expect(work).toMatchObject({
      kind: "detail",
      sourceListingId: "30",
      nextDetailSequence: 1
    });
  });

  it("uses exact list and detail replay without advancing cursors", () => {
    const f = claimed();
    f.service.saveFilterProof(f.id, f.token, proof());
    const batch = listBatch([["1", 5_000]]);
    expect(f.service.submitListBatch(f.id, f.token, batch)).toEqual(
      f.service.submitListBatch(f.id, f.token, batch)
    );
    f.service.submitLoadEvent(
      f.id,
      f.token,
      loadEvent(1, 1, 1, {
        visibleTotalCount: 1,
        endMarkerVisible: true
      })
    );
    f.advance(2_000);
    const detail = details(["1"]);
    const accepted = f.service.submitDetails(f.id, f.token, detail);
    expect(f.service.submitDetails(f.id, f.token, detail)).toEqual(accepted);
    expect(f.repository.getJob(f.id, baseTime)).toMatchObject({
      state: "validating",
      detailCompletedCount: 1
    });
  });

  it("pauses and explicitly resumes without losing list cursors", () => {
    const f = claimed();
    f.service.saveFilterProof(f.id, f.token, proof());
    f.service.submitListBatch(f.id, f.token, listBatch([["1", 100]]));
    const pause: BrowserPause = {
      reason: "structure_changed",
      message: "等待页面恢复"
    };
    f.service.pause(f.id, f.token, pause);
    expect(f.repository.getJob(f.id, baseTime)).toMatchObject({
      state: "paused",
      listBatchCursor: 1
    });
    const resumed = f.service.resume(f.id, f.token);
    expect(resumed).toMatchObject({
      state: "collecting_list",
      listBatchCursor: 1
    });
  });

  it.each([
    ["captcha", "captcha_required"],
    ["login", "login_required"]
  ] as const)("requires explicit resume after %s", (blockingState, reason) => {
    const f = claimed();
    f.service.saveFilterProof(f.id, f.token, proof());
    f.service.submitLoadEvent(
      f.id,
      f.token,
      loadEvent(1, 0, 0, { blockingState })
    );
    expect(f.repository.getJob(f.id, baseTime)).toMatchObject({
      state: "awaiting_user_verification",
      reason
    });
    expect(f.service.resume(f.id, f.token).state).toBe("collecting_list");
  });

  it("enforces deterministic normal list and detail timing boundaries", () => {
    const list = claimed(fixture(0));
    list.service.saveFilterProof(list.id, list.token, proof());
    list.service.submitListBatch(
      list.id,
      list.token,
      listBatch([["1", 5_000]])
    );
    list.service.submitLoadEvent(
      list.id,
      list.token,
      loadEvent(1, 1, 1)
    );
    expect(list.repository.getJob(list.id, baseTime)?.nextActionAt).toBe(
      "2026-07-30T10:00:01.200Z"
    );
    expectCode(
      () => list.service.getWork(list.id, list.token),
      "action_too_early"
    );
    list.advance(1_200);
    expect(list.service.getWork(list.id, list.token).kind).toBe("list");

    const detail = claimed(fixture(1));
    detail.service.saveFilterProof(detail.id, detail.token, proof());
    detail.service.submitListBatch(
      detail.id,
      detail.token,
      listBatch([["1", 5_000], ["2", 5_000]])
    );
    detail.service.submitLoadEvent(
      detail.id,
      detail.token,
      loadEvent(1, 2, 2, {
        visibleTotalCount: 2,
        endMarkerVisible: true
      })
    );
    expect(detail.repository.getJob(
      detail.id,
      baseTime
    )?.nextActionAt).toBe("2026-07-30T10:00:03.500Z");
    detail.advance(3_500);
    detail.service.submitDetails(detail.id, detail.token, details(["1"]));
    expect(detail.repository.getJob(detail.id, baseTime)?.nextActionAt).toBe(
      "2026-07-30T10:00:07.000Z"
    );
  });

  it("runs the four cooldown stages, issues one-use permits, and pauses on the fifth", () => {
    const f = claimed(fixture(0));
    f.service.saveFilterProof(f.id, f.token, proof());
    const expectedDelays = [30_000, 120_000, 300_000, 900_000];
    let permit: string | undefined;
    for (let index = 0; index < expectedDelays.length; index += 1) {
      if (index > 0) {
        f.service.submitLoadEvent(
          f.id,
          f.token,
          loadEvent(index, 0, 0, {
            blockingState: "rate_limited",
            actionPermit: permit
          })
        );
      }
      const cooldown = f.service.startCooldown(f.id, f.token);
      expect(
        Date.parse(cooldown.cooldownUntil!) -
        Date.parse(cooldown.updatedAt)
      ).toBe(expectedDelays[index]);
      expectCode(
        () => f.service.getWork(f.id, f.token),
        "cooldown_active"
      );
      f.setTime(Date.parse(cooldown.cooldownUntil!));
      const work = f.service.getWork(f.id, f.token);
      permit = work.actionPermit;
      expect(permit).toEqual(expect.any(String));
      expect(f.repository.getJob(f.id, new Date(Date.parse(cooldown.cooldownUntil!))))
        .toMatchObject({ actionPermitExpiresAt: expect.any(String) });
      expectCode(
        () => f.service.getWork(f.id, f.token),
        "action_permit_required"
      );
    }
    f.service.submitLoadEvent(
      f.id,
      f.token,
      loadEvent(4, 0, 0, {
        blockingState: "rate_limited",
        actionPermit: permit
      })
    );
    expect(f.service.startCooldown(f.id, f.token)).toMatchObject({
      state: "paused",
      reason: "rate_limited",
      cooldownAttempt: 4
    });
  });

  it("rejects wrong and expired permits and resets cooldown after success", () => {
    const wrong = claimed();
    wrong.service.startCooldown(wrong.id, wrong.token);
    wrong.advance(30_000);
    wrong.service.getWork(wrong.id, wrong.token);
    expectCode(
      () => wrong.service.submitLoadEvent(
        wrong.id,
        wrong.token,
        loadEvent(1, 0, 0, { actionPermit: "wrong" })
      ),
      "action_permit_invalid"
    );

    const expired = claimed();
    expired.service.startCooldown(expired.id, expired.token);
    expired.advance(30_000);
    const work = expired.service.getWork(expired.id, expired.token);
    expired.advance(60_000);
    expectCode(
      () => expired.service.submitLoadEvent(
        expired.id,
        expired.token,
        loadEvent(1, 0, 0, { actionPermit: work.actionPermit })
      ),
      "action_permit_invalid"
    );

    const success = claimed();
    success.service.startCooldown(success.id, success.token);
    success.advance(30_000);
    const allowed = success.service.getWork(success.id, success.token);
    success.service.submitLoadEvent(
      success.id,
      success.token,
      loadEvent(1, 0, 0, { actionPermit: allowed.actionPermit })
    );
    expect(success.repository.getJob(success.id, new Date(
      baseTime.getTime() + 30_000
    ))).toMatchObject({
      cooldownAttempt: 0,
      cooldownUntil: null,
      actionPermitExpiresAt: null
    });
  });

  it("does not issue another permit after a failed permitted action", () => {
    const f = claimed();
    f.service.startCooldown(f.id, f.token);
    f.advance(30_000);
    const work = f.service.getWork(f.id, f.token);
    f.service.submitLoadEvent(
      f.id,
      f.token,
      loadEvent(1, 0, 0, {
        blockingState: "rate_limited",
        actionPermit: work.actionPermit
      })
    );
    expectCode(
      () => f.service.getWork(f.id, f.token),
      "action_permit_required"
    );
  });

  it("persists staging across a recreated service using the same database", () => {
    const f = claimed();
    f.service.saveFilterProof(f.id, f.token, proof());
    f.service.submitListBatch(f.id, f.token, listBatch([["1", 100]]));
    const recreated = new JiaoyimaoBrowserTaskService(f.repository, {
      now: () => baseTime,
      random: () => 0
    });
    expect(recreated.getWork(f.id, f.token)).toMatchObject({
      kind: "list",
      nextListBatchSequence: 2,
      nextLoadSequence: 1
    });
  });

  it("allows only an interrupted, still-unclaimed job to use its claim code", () => {
    const restart = fixture();
    const created = restart.service.create();
    restart.repository.recoverInterruptedJobs(baseTime);
    expect(restart.repository.getJob(created.id, baseTime)).toMatchObject({
      state: "paused",
      reason: "process_interrupted",
      claimedAt: null
    });
    expect(
      restart.service.claim(created.id, created.claimCode)
    ).toMatchObject({
      state: "collecting_list",
      bridgeToken: expect.any(String)
    });

    const arbitrary = fixture();
    const other = arbitrary.service.create();
    arbitrary.repository.transition(
      other.id,
      ["awaiting_codex"],
      "paused",
      {
        stage: "collecting_list",
        reason: "structure_changed"
      },
      baseTime
    );
    expectCode(
      () => arbitrary.service.claim(other.id, other.claimCode),
      "invalid_transition"
    );
  });

  it("recovers an interrupted detail queue to its exact stage and cursor", () => {
    const f = claimed();
    f.service.saveFilterProof(f.id, f.token, proof());
    f.service.submitListBatch(
      f.id,
      f.token,
      listBatch([["1", 100], ["2", 100]])
    );
    f.service.submitLoadEvent(
      f.id,
      f.token,
      loadEvent(1, 2, 2, {
        visibleTotalCount: 2,
        endMarkerVisible: true
      })
    );
    f.advance(2_000);
    f.service.submitDetails(f.id, f.token, details(["1"]));
    f.repository.recoverInterruptedJobs(new Date(
      baseTime.getTime() + 2_000
    ));
    const restarted = new JiaoyimaoBrowserTaskService(f.repository, {
      now: () => new Date(baseTime.getTime() + 4_000),
      random: () => 0
    });
    restarted.resume(f.id, f.token);
    expect(restarted.getWork(f.id, f.token)).toMatchObject({
      kind: "detail",
      sourceListingId: "2",
      nextDetailSequence: 2
    });
  });

  it("resumes validation rather than restarting collection", () => {
    const f = claimed();
    f.service.saveFilterProof(f.id, f.token, proof());
    f.service.submitListBatch(
      f.id,
      f.token,
      listBatch([["1", 6_001]])
    );
    f.service.submitLoadEvent(
      f.id,
      f.token,
      loadEvent(1, 1, 1, {
        visibleTotalCount: 1,
        endMarkerVisible: true
      })
    );
    f.service.pause(f.id, f.token, {
      reason: "structure_changed"
    });
    expect(f.service.resume(f.id, f.token).state).toBe("validating");
  });

  it("restores interrupted cooldown without bypassing or resetting it", () => {
    const f = claimed();
    f.service.saveFilterProof(f.id, f.token, proof());
    const cooldown = f.service.startCooldown(f.id, f.token);
    f.repository.recoverInterruptedJobs(baseTime);
    let restartedTime = baseTime.getTime();
    const restarted = new JiaoyimaoBrowserTaskService(f.repository, {
      now: () => new Date(restartedTime),
      random: () => 0
    });
    expect(restarted.resume(f.id, f.token)).toMatchObject({
      state: "cooling_down",
      cooldownAttempt: 1,
      cooldownUntil: cooldown.cooldownUntil
    });
    expectCode(
      () => restarted.getWork(f.id, f.token),
      "cooldown_active"
    );
    restartedTime = Date.parse(cooldown.cooldownUntil!);
    const work = restarted.getWork(f.id, f.token);
    expect(work).toMatchObject({
      kind: "list",
      actionPermit: expect.any(String)
    });
    restarted.submitLoadEvent(
      f.id,
      f.token,
      loadEvent(1, 0, 0, {
        blockingState: "rate_limited",
        actionPermit: work.actionPermit
      })
    );
    expect(restarted.startCooldown(f.id, f.token)).toMatchObject({
      cooldownAttempt: 2,
      cooldownUntil: new Date(restartedTime + 120_000).toISOString()
    });
  });

  it("rolls back a load event if its natural-end transition fails", () => {
    const f = claimed();
    f.service.saveFilterProof(f.id, f.token, proof());
    f.service.submitListBatch(f.id, f.token, listBatch([["1", 100]]));
    f.database.exec(`
      CREATE TRIGGER inject_load_transition_failure
      BEFORE UPDATE OF state ON browser_refresh_jobs
      WHEN NEW.id = '${f.id}' AND NEW.state = 'collecting_details'
      BEGIN
        SELECT RAISE(ABORT, 'injected load transition failure');
      END;
    `);
    const event = loadEvent(1, 1, 1, {
      visibleTotalCount: 1,
      endMarkerVisible: true
    });
    expectCode(
      () => f.service.submitLoadEvent(f.id, f.token, event),
      "staging_invalid"
    );
    expect(
      f.database.prepare(`
        SELECT COUNT(*) AS count FROM browser_refresh_load_events
        WHERE job_id = ?
      `).get(f.id)
    ).toEqual({ count: 0 });
    expect(f.repository.getJob(f.id, baseTime)).toMatchObject({
      state: "collecting_list",
      loadActionCount: 0
    });

    f.database.exec("DROP TRIGGER inject_load_transition_failure");
    f.service.submitLoadEvent(f.id, f.token, event);
    expect(
      f.database.prepare(`
        SELECT COUNT(*) AS count FROM browser_refresh_load_events
        WHERE job_id = ?
      `).get(f.id)
    ).toEqual({ count: 1 });
    expect(f.repository.getJob(f.id, baseTime)).toMatchObject({
      state: "collecting_details",
      loadActionCount: 1,
      detailRequiredCount: 1
    });
  });

  it("rolls back detail evidence if its validation transition fails", () => {
    const f = claimed();
    f.service.saveFilterProof(f.id, f.token, proof());
    f.service.submitListBatch(f.id, f.token, listBatch([["1", 100]]));
    f.service.submitLoadEvent(
      f.id,
      f.token,
      loadEvent(1, 1, 1, {
        visibleTotalCount: 1,
        endMarkerVisible: true
      })
    );
    f.advance(2_000);
    f.database.exec(`
      CREATE TRIGGER inject_detail_transition_failure
      BEFORE UPDATE OF state ON browser_refresh_jobs
      WHEN NEW.id = '${f.id}' AND NEW.state = 'validating'
      BEGIN
        SELECT RAISE(ABORT, 'injected detail transition failure');
      END;
    `);
    const batch = details(["1"]);
    expectCode(
      () => f.service.submitDetails(f.id, f.token, batch),
      "staging_invalid"
    );
    expect(
      f.database.prepare(`
        SELECT COUNT(*) AS count FROM browser_refresh_details
        WHERE job_id = ?
      `).get(f.id)
    ).toEqual({ count: 0 });
    expect(
      f.database.prepare(`
        SELECT COUNT(*) AS count FROM browser_refresh_batches
        WHERE job_id = ? AND kind = 'detail'
      `).get(f.id)
    ).toEqual({ count: 0 });
    expect(f.repository.getJob(f.id, new Date(
      baseTime.getTime() + 2_000
    ))).toMatchObject({
      state: "collecting_details",
      detailCompletedCount: 0
    });

    f.database.exec("DROP TRIGGER inject_detail_transition_failure");
    f.service.submitDetails(f.id, f.token, batch);
    expect(
      f.database.prepare(`
        SELECT COUNT(*) AS count FROM browser_refresh_details
        WHERE job_id = ?
      `).get(f.id)
    ).toEqual({ count: 1 });
    expect(f.repository.getJob(f.id, new Date(
      baseTime.getTime() + 2_000
    ))).toMatchObject({
      state: "validating",
      detailCompletedCount: 1
    });
  });

  it("refuses incomplete completion and invokes only the injected callback", async () => {
    const f = claimed();
    f.service.saveFilterProof(f.id, f.token, proof());
    f.service.submitListBatch(f.id, f.token, listBatch([["1", 5_000]]));
    expectCode(
      () => f.service.complete(f.id, f.token),
      "list_incomplete"
    );
    f.service.submitLoadEvent(
      f.id,
      f.token,
      loadEvent(1, 1, 1, {
        visibleTotalCount: 1,
        endMarkerVisible: true
      })
    );
    expectCode(
      () => f.service.complete(f.id, f.token),
      "details_incomplete"
    );
    f.advance(2_000);
    f.service.submitDetails(f.id, f.token, details(["1"]));
    await f.service.complete(f.id, f.token);
    expect(f.completed).toEqual([f.id]);
    expect(f.repository.getJob(f.id, baseTime)?.state).toBe("committing");
  });

  it("cancels terminally without changing formal listings", () => {
    const f = claimed();
    f.database.prepare(`
      INSERT INTO listings (listing_key, source, eligibility, payload)
      VALUES ('jiaoyimao:old', 'jiaoyimao', 'eligible', '{}')
    `).run();
    f.service.cancel(f.id);
    expect(f.repository.getJob(f.id, baseTime)?.state).toBe("cancelled");
    expect(
      f.database.prepare("SELECT listing_key FROM listings").all()
    ).toEqual([{ listing_key: "jiaoyimao:old" }]);
    expectCode(
      () => f.service.getWork(f.id, f.token),
      "bridge_unauthorized"
    );
  });
});
