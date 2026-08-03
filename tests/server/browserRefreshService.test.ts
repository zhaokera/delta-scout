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
  JiaoyimaoBrowserTaskService,
  type JiaoyimaoBrowserTaskServiceOptions
} from "../../src/server/browserRefresh/service.js";
import { ListingRepository } from "../../src/server/repository.js";
import { RefreshAdmissionController } from "../../src/server/refreshAdmission.js";
import { RefreshTracker } from "../../src/server/refreshTracker.js";
import { makeListing } from "../domain/listingFactory.js";
import {
  APPROVED_JIAOYIMAO_REFERER
} from "../../src/server/collector/mtop.js";

const baseTime = new Date("2026-07-30T10:00:00.000Z");
const filterUrl = APPROVED_JIAOYIMAO_REFERER;

function proof(overrides: Partial<BrowserFilterProof> = {}): BrowserFilterProof {
  return {
    currentUrl: filterUrl,
    gameLabel: "三角洲行动",
    platformLabel: "QQ",
    categoryLabel: "账号",
    activeFilterLabels: [
      "1900-4000",
      "骇爪-维什戴尔",
      "露娜-黑·天际线",
      "可二次实名"
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

function reusableJiaoyimaoListing(capturedAt: string) {
  return makeListing({
    key: "jiaoyimao:1",
    source: "jiaoyimao",
    sourceListingId: "1",
    url: "https://www.jiaoyimao.com/jg2007840/1.html",
    title: "商品 1",
    originalDescription:
      "商品卡片\nQQ 官服 M7 棱镜攻势 极品A 总资产266M " +
      "可二次实名 支持包赔",
    capturedAt,
    evidence: [
      { text: "商品卡片", truncated: false },
      {
        text: "QQ 官服 M7 棱镜攻势 极品A 总资产266M",
        truncated: false
      },
      { text: "可二次实名 支持包赔", truncated: false }
    ],
    parseWarnings: [],
    verificationAt: new Date(
      Date.parse(capturedAt) - 60_000
    ).toISOString()
  });
}

function fixture(random = 0) {
  const database = createDatabase(":memory:");
  const repository = new BrowserRefreshRepository(database);
  const listingRepository = new ListingRepository(database);
  let time = baseTime.getTime();
  const publisher = vi.spyOn(
    listingRepository,
    "commitBrowserSourceRefresh"
  );
  const service = new JiaoyimaoBrowserTaskService(repository, {
    now: () => new Date(time),
    random: () => random,
    publisher: listingRepository
  });
  return {
    database,
    repository,
    listingRepository,
    service,
    publisher,
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

function captureServiceError(operation: () => unknown): BrowserRefreshServiceError {
  try {
    operation();
    throw new Error("Expected operation to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(BrowserRefreshServiceError);
    return error as BrowserRefreshServiceError;
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
      "bridge_unauthorized"
    );
  });

  it("requires valid visible filter proof before staging list batches", () => {
    const missing = claimed();
    expectCode(
      () => missing.service.submitListBatch(
        missing.id,
        missing.token,
        listBatch([["1", 2_500]])
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
      listBatch([
        ["30", null],
        ["05", 1_899],
        ["10", 1_900],
        ["20", 4_000],
        ["40", 4_001]
      ])
    );
    f.service.submitLoadEvent(
      f.id,
      f.token,
      loadEvent(1, 5, 5, {
        visibleTotalCount: 5,
        endMarkerVisible: true
      })
    );
    expect(f.repository.getJob(f.id, baseTime)).toMatchObject({
      state: "collecting_details",
      detailRequiredCount: 3,
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

  it("reuses a recent unchanged trusted detail while keeping the new price", () => {
    const f = claimed();
    f.listingRepository.replaceSourceSnapshot(
      "jiaoyimao",
      [
        reusableJiaoyimaoListing(
          new Date(baseTime.getTime() - 60 * 60 * 1_000).toISOString()
        )
      ],
      "success",
      baseTime,
      { pagesScanned: 1, stopReason: "end_of_pages" }
    );
    f.service.saveFilterProof(f.id, f.token, proof());
    f.service.submitListBatch(
      f.id,
      f.token,
      listBatch([["1", 3_500]])
    );
    f.service.submitLoadEvent(
      f.id,
      f.token,
      loadEvent(1, 1, 1, {
        visibleTotalCount: 1,
        endMarkerVisible: true
      })
    );

    expect(f.repository.getJob(f.id, baseTime)).toMatchObject({
      state: "validating",
      detailRequiredCount: 1,
      detailCompletedCount: 1,
      nextActionAt: null
    });
    // Reuse eligibility is fixed when the task is claimed, so a slow manual
    // verification session cannot invalidate an otherwise complete snapshot.
    f.advance(6 * 60 * 60 * 1_000);
    expect(f.service.getWork(f.id, f.token).kind).toBe("validating");
    const completed = f.service.complete(f.id, f.token);
    expect(completed.state).toBe("success");
    expect(f.listingRepository.getListing("jiaoyimao:1")).toMatchObject({
      priceCny: 3_500,
      totalAssetsM: 266,
      secondRealNameAvailable: true,
      recoveryCoverage: true
    });
  });

  it("does not reuse an unchanged detail after the six-hour trust window", () => {
    const f = claimed();
    f.listingRepository.replaceSourceSnapshot(
      "jiaoyimao",
      [
        reusableJiaoyimaoListing(
          new Date(baseTime.getTime() - 7 * 60 * 60 * 1_000).toISOString()
        )
      ],
      "success",
      baseTime,
      { pagesScanned: 1, stopReason: "end_of_pages" }
    );
    f.service.saveFilterProof(f.id, f.token, proof());
    f.service.submitListBatch(
      f.id,
      f.token,
      listBatch([["1", 3_500]])
    );
    f.service.submitLoadEvent(
      f.id,
      f.token,
      loadEvent(1, 1, 1, {
        visibleTotalCount: 1,
        endMarkerVisible: true
      })
    );

    expect(f.repository.getJob(f.id, baseTime)).toMatchObject({
      state: "collecting_details",
      detailRequiredCount: 1,
      detailCompletedCount: 0
    });
  });

  it("uses exact list and detail replay without advancing cursors", () => {
    const f = claimed();
    f.service.saveFilterProof(f.id, f.token, proof());
    const batch = listBatch([["1", 3_000]]);
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
    f.service.submitListBatch(f.id, f.token, listBatch([["1", 2_500]]));
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

  it("automatically starts the first cooldown for a normal rate-limit outcome", () => {
    const f = claimed();
    f.service.saveFilterProof(f.id, f.token, proof());
    f.service.submitLoadEvent(
      f.id,
      f.token,
      loadEvent(1, 0, 0, { blockingState: "rate_limited" })
    );
    expect(f.repository.getJob(f.id, baseTime)).toMatchObject({
      state: "cooling_down",
      reason: "rate_limited",
      cooldownAttempt: 1,
      cooldownUntil: new Date(
        baseTime.getTime() + 30_000
      ).toISOString(),
      loadActionCount: 1
    });
    expectCode(
      () => f.service.getWork(f.id, f.token),
      "cooldown_active"
    );
  });

  it("throttles immediate retry while the list is visibly loading", () => {
    const f = claimed();
    f.service.saveFilterProof(f.id, f.token, proof());
    f.service.submitLoadEvent(
      f.id,
      f.token,
      loadEvent(1, 0, 0, { loadingVisible: true })
    );
    expect(f.repository.getJob(f.id, baseTime)).toMatchObject({
      state: "collecting_list",
      cooldownAttempt: 0,
      nextActionAt: new Date(
        baseTime.getTime() + 1_200
      ).toISOString()
    });
    expectCode(
      () => f.service.getWork(f.id, f.token),
      "action_too_early"
    );
  });

  it("advances a permitted loading outcome to the next cooldown", () => {
    const f = claimed();
    f.service.saveFilterProof(f.id, f.token, proof());
    const firstCooldown = f.service.startCooldown(f.id, f.token);
    f.setTime(Date.parse(firstCooldown.cooldownUntil!));
    const work = f.service.getWork(f.id, f.token);

    f.service.submitLoadEvent(
      f.id,
      f.token,
      loadEvent(1, 0, 0, {
        loadingVisible: true,
        actionPermit: work.actionPermit
      })
    );

    const secondDeadline = new Date(
      Date.parse(firstCooldown.cooldownUntil!) + 120_000
    ).toISOString();
    expect(f.repository.getJob(
      f.id,
      new Date(Date.parse(firstCooldown.cooldownUntil!))
    )).toMatchObject({
      state: "cooling_down",
      reason: "rate_limited",
      cooldownAttempt: 2,
      cooldownUntil: secondDeadline,
      nextActionAt: null,
      actionPermitExpiresAt: null,
      actionPermitConsumedAt: null,
      loadActionCount: 1
    });
    expectCode(
      () => f.service.getWork(f.id, f.token),
      "cooldown_active"
    );
  });

  it("pauses after a permitted loading outcome exhausts stage four and resumes manually", () => {
    const f = claimed();
    f.service.saveFilterProof(f.id, f.token, proof());
    let cooldown = f.service.startCooldown(f.id, f.token);

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      f.setTime(Date.parse(cooldown.cooldownUntil!));
      const work = f.service.getWork(f.id, f.token);
      f.service.submitLoadEvent(
        f.id,
        f.token,
        loadEvent(attempt, 0, 0, {
          loadingVisible: true,
          actionPermit: work.actionPermit
        })
      );
      if (attempt < 4) {
        cooldown = f.repository.getJob(
          f.id,
          new Date(Date.parse(cooldown.cooldownUntil!))
        )!;
      }
    }

    const pausedAt = Date.parse(cooldown.cooldownUntil!);
    expect(f.repository.getJob(f.id, new Date(pausedAt))).toMatchObject({
      state: "paused",
      reason: "rate_limited",
      cooldownAttempt: 4,
      cooldownUntil: null,
      nextActionAt: null,
      actionPermitExpiresAt: null,
      actionPermitConsumedAt: null,
      loadActionCount: 4
    });

    expect(f.service.resume(f.id, f.token)).toMatchObject({
      state: "collecting_list",
      reason: null,
      cooldownAttempt: 0,
      cooldownUntil: null,
      nextActionAt: new Date(pausedAt + 1_200).toISOString()
    });
    expectCode(
      () => f.service.getWork(f.id, f.token),
      "action_too_early"
    );
    f.advance(1_200);
    const manualWork = f.service.getWork(f.id, f.token);
    expect(manualWork.kind).toBe("list");
    expect(manualWork.actionPermit).toBeUndefined();
  });

  it.each([
    ["login", "awaiting_user_verification", "login_required"],
    ["captcha", "awaiting_user_verification", "captcha_required"],
    ["error", "paused", "structure_changed"]
  ] as const)(
    "atomically applies the intended %s blocking transition",
    (blockingState, state, reason) => {
      const f = claimed();
      f.service.saveFilterProof(f.id, f.token, proof());
      f.service.submitLoadEvent(
        f.id,
        f.token,
        loadEvent(1, 0, 0, { blockingState })
      );
      expect(f.repository.getJob(f.id, baseTime)).toMatchObject({
        state,
        reason,
        loadActionCount: 1
      });
      expect(
        f.database.prepare(`
          SELECT COUNT(*) AS count FROM browser_refresh_load_events
          WHERE job_id = ?
        `).get(f.id)
      ).toEqual({ count: 1 });
    }
  );

  it("enforces deterministic normal list and detail timing boundaries", () => {
    const list = claimed(fixture(0));
    list.service.saveFilterProof(list.id, list.token, proof());
    list.service.submitListBatch(
      list.id,
      list.token,
      listBatch([["1", 3_000]])
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
      listBatch([["1", 3_000], ["2", 3_000]])
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
    f.service.submitListBatch(f.id, f.token, listBatch([["1", 2_500]]));
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
      "bridge_unauthorized"
    );
  });

  it("recovers an interrupted detail queue to its exact stage and cursor", () => {
    const f = claimed();
    f.service.saveFilterProof(f.id, f.token, proof());
    f.service.submitListBatch(
      f.id,
      f.token,
      listBatch([["1", 2_500], ["2", 2_500]])
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

  it("replaces one unreturnable unconsumed permit after its original expiry", () => {
    const f = claimed();
    f.service.saveFilterProof(f.id, f.token, proof());
    const firstCooldown = f.service.startCooldown(f.id, f.token);
    f.setTime(Date.parse(firstCooldown.cooldownUntil!));
    const lostWork = f.service.getWork(f.id, f.token);
    const lostExpiry = f.repository.getJob(
      f.id,
      new Date(Date.parse(firstCooldown.cooldownUntil!))
    )!.actionPermitExpiresAt!;
    expect(lostWork.actionPermit).toEqual(expect.any(String));

    f.advance(10_000);
    const recoveryTime = Date.parse(firstCooldown.cooldownUntil!) + 10_000;
    f.repository.recoverInterruptedJobs(new Date(recoveryTime));
    expect(f.repository.getJob(f.id, new Date(recoveryTime))).toMatchObject({
      state: "paused",
      reason: "process_interrupted",
      cooldownAttempt: 1,
      cooldownUntil: lostExpiry,
      actionPermitExpiresAt: null,
      actionPermitConsumedAt: null
    });

    let restartedTime = recoveryTime;
    const restarted = new JiaoyimaoBrowserTaskService(f.repository, {
      now: () => new Date(restartedTime),
      random: () => 0
    });
    expect(restarted.resume(f.id, f.token)).toMatchObject({
      state: "cooling_down",
      cooldownAttempt: 1,
      cooldownUntil: lostExpiry
    });
    expectCode(
      () => restarted.getWork(f.id, f.token),
      "cooldown_active"
    );
    restartedTime = Date.parse(lostExpiry);
    const replacement = restarted.getWork(f.id, f.token);
    expect(replacement).toMatchObject({
      kind: "list",
      cooldownAttempt: 1,
      actionPermit: expect.any(String)
    });
    expect(replacement.actionPermit).not.toBe(lostWork.actionPermit);
    expectCode(
      () => restarted.getWork(f.id, f.token),
      "action_permit_required"
    );
    restarted.submitLoadEvent(
      f.id,
      f.token,
      loadEvent(1, 0, 0, {
        blockingState: "rate_limited",
        actionPermit: replacement.actionPermit
      })
    );
    expect(restarted.startCooldown(f.id, f.token)).toMatchObject({
      cooldownAttempt: 2,
      cooldownUntil: new Date(restartedTime + 120_000).toISOString(),
      loadActionCount: 1
    });
  });

  it("advances a consumed attempt-one permit to the second cooldown after restart", () => {
    const f = claimed();
    f.service.saveFilterProof(f.id, f.token, proof());
    const firstCooldown = f.service.startCooldown(f.id, f.token);
    f.setTime(Date.parse(firstCooldown.cooldownUntil!));
    const work = f.service.getWork(f.id, f.token);
    f.service.submitLoadEvent(
      f.id,
      f.token,
      loadEvent(1, 0, 0, {
        blockingState: "rate_limited",
        actionPermit: work.actionPermit
      })
    );
    const recoveryTime = Date.parse(firstCooldown.cooldownUntil!);
    f.repository.recoverInterruptedJobs(new Date(recoveryTime));
    const secondDeadline = new Date(
      recoveryTime + 120_000
    ).toISOString();
    expect(f.repository.getJob(f.id, new Date(recoveryTime))).toMatchObject({
      state: "paused",
      reason: "process_interrupted",
      cooldownAttempt: 2,
      cooldownUntil: secondDeadline,
      loadActionCount: 1,
      actionPermitExpiresAt: null,
      actionPermitConsumedAt: null
    });

    let restartedTime = recoveryTime;
    const restarted = new JiaoyimaoBrowserTaskService(f.repository, {
      now: () => new Date(restartedTime),
      random: () => 0
    });
    expect(restarted.resume(f.id, f.token)).toMatchObject({
      state: "cooling_down",
      cooldownAttempt: 2,
      cooldownUntil: secondDeadline
    });
    expectCode(
      () => restarted.getWork(f.id, f.token),
      "cooldown_active"
    );
    restartedTime = Date.parse(secondDeadline);
    const replacement = restarted.getWork(f.id, f.token);
    restarted.submitLoadEvent(
      f.id,
      f.token,
      loadEvent(2, 0, 0, {
        blockingState: "rate_limited",
        actionPermit: replacement.actionPermit
      })
    );
    expect(restarted.startCooldown(f.id, f.token)).toMatchObject({
      cooldownAttempt: 3,
      cooldownUntil: new Date(restartedTime + 300_000).toISOString(),
      loadActionCount: 2
    });
  });

  it("requires explicit resume after exhausted stage four and restarts at stage one", () => {
    const f = claimed();
    f.service.saveFilterProof(f.id, f.token, proof());
    let permit: string | undefined;
    let recoveryTime = baseTime.getTime();
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const cooldown = f.service.startCooldown(f.id, f.token);
      recoveryTime = Date.parse(cooldown.cooldownUntil!);
      f.setTime(recoveryTime);
      permit = f.service.getWork(f.id, f.token).actionPermit;
      if (attempt < 4) {
        f.service.submitLoadEvent(
          f.id,
          f.token,
          loadEvent(attempt, 0, 0, {
            blockingState: "rate_limited",
            actionPermit: permit
          })
        );
      }
    }
    f.service.submitLoadEvent(
      f.id,
      f.token,
      loadEvent(4, 0, 0, {
        blockingState: "rate_limited",
        actionPermit: permit
      })
    );
    f.repository.recoverInterruptedJobs(new Date(recoveryTime));
    expect(f.repository.getJob(f.id, new Date(recoveryTime))).toMatchObject({
      state: "paused",
      reason: "rate_limited",
      cooldownAttempt: 4,
      cooldownUntil: null,
      loadActionCount: 4,
      actionPermitExpiresAt: null,
      actionPermitConsumedAt: null
    });
    expectCode(
      () => f.service.getWork(f.id, f.token),
      "invalid_transition"
    );

    const resumed = f.service.resume(f.id, f.token);
    expect(resumed).toMatchObject({
      state: "collecting_list",
      reason: null,
      cooldownAttempt: 0,
      cooldownUntil: null,
      nextActionAt: new Date(recoveryTime + 1_200).toISOString(),
      actionPermitExpiresAt: null,
      actionPermitConsumedAt: null
    });
    expectCode(
      () => f.service.getWork(f.id, f.token),
      "action_too_early"
    );
    f.advance(1_200);
    const manualWork = f.service.getWork(f.id, f.token);
    expect(manualWork.kind).toBe("list");
    expect(manualWork.actionPermit).toBeUndefined();
    f.service.submitLoadEvent(
      f.id,
      f.token,
      loadEvent(5, 0, 0, {
        blockingState: "rate_limited"
      })
    );
    expect(f.repository.getJob(f.id, new Date(
      recoveryTime + 1_200
    ))).toMatchObject({
      state: "cooling_down",
      cooldownAttempt: 1,
      cooldownUntil: new Date(
        recoveryTime + 1_200 + 30_000
      ).toISOString(),
      loadActionCount: 5
    });
  });

  it("uses the normal detail delay for explicit exhausted-stage continuation", () => {
    const f = claimed();
    f.service.saveFilterProof(f.id, f.token, proof());
    f.service.submitListBatch(f.id, f.token, listBatch([["1", 2_500]]));
    f.service.submitLoadEvent(
      f.id,
      f.token,
      loadEvent(1, 1, 1, {
        visibleTotalCount: 1,
        endMarkerVisible: true
      })
    );
    f.repository.transition(
      f.id,
      ["collecting_details"],
      "paused",
      {
        stage: "collecting_details",
        reason: "rate_limited",
        cooldownAttempt: 4,
        cooldownUntil: null,
        nextActionAt: null,
        actionPermit: null,
        actionPermitExpiresAt: null
      },
      baseTime
    );
    expect(f.service.resume(f.id, f.token)).toMatchObject({
      state: "collecting_details",
      cooldownAttempt: 0,
      nextActionAt: new Date(
        baseTime.getTime() + 2_000
      ).toISOString()
    });
  });

  it("rolls back a load event if its natural-end transition fails", () => {
    const f = claimed();
    f.service.saveFilterProof(f.id, f.token, proof());
    f.service.submitListBatch(f.id, f.token, listBatch([["1", 2_500]]));
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

  it("replays the same stable error after a count-mismatch commit", () => {
    const f = claimed();
    f.service.saveFilterProof(f.id, f.token, proof());
    f.service.submitListBatch(f.id, f.token, listBatch([["1", 2_500]]));
    const mismatch = loadEvent(1, 0, 0, {
      visibleTotalCount: 0,
      endMarkerVisible: true
    });
    const first = captureServiceError(
      () => f.service.submitLoadEvent(f.id, f.token, mismatch)
    );
    expect(first.code).toBe("staging_invalid");
    const firstJob = f.repository.getJob(f.id, baseTime);
    expect(firstJob).toMatchObject({
      state: "paused",
      reason: "staging_invalid",
      loadActionCount: 1
    });
    expect(
      f.database.prepare(`
        SELECT COUNT(*) AS count FROM browser_refresh_load_events
        WHERE job_id = ?
      `).get(f.id)
    ).toEqual({ count: 1 });

    const replay = captureServiceError(
      () => f.service.submitLoadEvent(f.id, f.token, mismatch)
    );
    expect(replay).toMatchObject({
      code: first.code,
      message: first.message
    });
    expect(f.repository.getJob(f.id, baseTime)).toEqual(firstJob);
    expect(
      f.database.prepare(`
        SELECT COUNT(*) AS count FROM browser_refresh_load_events
        WHERE job_id = ?
      `).get(f.id)
    ).toEqual({ count: 1 });
  });

  it("rolls back detail evidence if its validation transition fails", () => {
    const f = claimed();
    f.service.saveFilterProof(f.id, f.token, proof());
    f.service.submitListBatch(f.id, f.token, listBatch([["1", 2_500]]));
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

  it("refuses incomplete completion and invokes the scoped publisher exactly once", async () => {
    const f = claimed();
    f.service.saveFilterProof(f.id, f.token, proof());
    f.service.submitListBatch(f.id, f.token, listBatch([["1", 3_000]]));
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
    expect(f.publisher).toHaveBeenCalledOnce();
    expect(f.repository.getJob(f.id, baseTime)?.state).toBe("success");
  });

  it("does not allow a legacy completeJob callback to bypass the scoped publisher", () => {
    const f = claimed();
    f.service.saveFilterProof(f.id, f.token, proof());
    f.service.submitListBatch(f.id, f.token, listBatch([["1", 6_001]]));
    f.service.submitLoadEvent(
      f.id,
      f.token,
      loadEvent(1, 1, 1, {
        visibleTotalCount: 1,
        endMarkerVisible: true
      })
    );
    const bypass = vi.fn();
    const legacy = new JiaoyimaoBrowserTaskService(
      f.repository,
      ({
        now: () => baseTime,
        random: () => 0,
        completeJob: bypass
      } as unknown as JiaoyimaoBrowserTaskServiceOptions)
    );

    expectCode(
      () => legacy.complete(f.id, f.token),
      "staging_invalid"
    );
    expect(bypass).not.toHaveBeenCalled();
    expect(f.repository.getJobRecord(f.id, baseTime)).toMatchObject({
      state: "validating"
    });
  });

  it("builds trusted listings locally and publishes one scoped snapshot exactly once", async () => {
    const database = createDatabase(":memory:");
    const browserRepository = new BrowserRefreshRepository(database);
    const listingRepository = new ListingRepository(database);
    const releaseAdmission = vi.fn();
    let time = baseTime.getTime();
    const publish = vi.spyOn(
      listingRepository,
      "commitBrowserSourceRefresh"
    );
    const service = new JiaoyimaoBrowserTaskService(browserRepository, {
      now: () => new Date(time),
      random: () => 0,
      publisher: listingRepository,
      releaseAdmission
    });
    const created = service.create();
    const claim = service.claim(created.id, created.claimCode);
    service.saveFilterProof(created.id, claim.bridgeToken, proof());
    service.submitListBatch(
      created.id,
      claim.bridgeToken,
      {
        ...listBatch([["101", 3_000]]),
        items: [{
          sourceListingId: "101",
          url:
            "https://www.jiaoyimao.com/jg2007840/101.html",
          title: "M7 棱镜攻势 极品A",
          rawText:
            "QQ 官服 M7 棱镜攻势 极品A 骇爪-维什戴尔 露娜-黑·天际线",
          priceCny: 3_000
        }]
      }
    );
    service.submitLoadEvent(
      created.id,
      claim.bridgeToken,
      loadEvent(1, 1, 1, {
        visibleTotalCount: 1,
        endMarkerVisible: true
      })
    );
    time += 2_000;
    service.submitDetails(
      created.id,
      claim.bridgeToken,
      {
        sequence: 1,
        items: [{
          sourceListingId: "101",
          url:
            "https://www.jiaoyimao.com/jg2007840/101.html",
          observedAt: baseTime.toISOString(),
          sections: {
            head: "QQ双端帐号 M7 棱镜攻势 极品A",
            report:
              "M7 棱镜攻势 极品A 可二次实名 永久包赔 验号时间：2026-07-30 17:00:00",
            safety: "安全保障 永久包赔",
            description:
              "威龙 红皮 骇爪-维什戴尔 露娜-黑·天际线 " +
              "巨浪 极品 总资产：2.66亿 哈夫币：28880000"
          }
        }]
      }
    );

    const result = await service.complete(
      created.id,
      claim.bridgeToken
    );

    expect(result).toMatchObject({
      state: "success",
      scanRunId: expect.any(Number),
      publishedRunId: expect.any(Number)
    });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: created.id,
        source: "jiaoyimao",
        pagesScanned: 1,
        stopReason: "end_of_pages",
        listings: [
          expect.objectContaining({
            key: "jiaoyimao:101",
            source: "jiaoyimao",
            loginPlatform: "qq",
            service: "official",
            m7PrismStatus: "peak",
            m7PrismQuality: "A",
            eligibility: "eligible"
          })
        ]
      })
    );
    expect(releaseAdmission).toHaveBeenCalledOnce();
    expect(releaseAdmission).toHaveBeenCalledWith(created.id);
  });

  it("excludes a listing that visibly became unavailable after list collection", async () => {
    const database = createDatabase(":memory:");
    const browserRepository = new BrowserRefreshRepository(database);
    const listingRepository = new ListingRepository(database);
    let time = baseTime.getTime();
    const publish = vi.spyOn(
      listingRepository,
      "commitBrowserSourceRefresh"
    );
    const service = new JiaoyimaoBrowserTaskService(browserRepository, {
      now: () => new Date(time),
      random: () => 0,
      publisher: listingRepository
    });
    const created = service.create();
    const claim = service.claim(created.id, created.claimCode);
    service.saveFilterProof(created.id, claim.bridgeToken, proof());
    service.submitListBatch(
      created.id,
      claim.bridgeToken,
      listBatch([["101", 3_000], ["102", 4_000]])
    );
    service.submitLoadEvent(
      created.id,
      claim.bridgeToken,
      loadEvent(1, 2, 2, {
        visibleTotalCount: 2,
        endMarkerVisible: true
      })
    );
    time += 2_000;
    service.submitDetails(
      created.id,
      claim.bridgeToken,
      {
        sequence: 1,
        items: [
          {
            sourceListingId: "101",
            url:
              "https://www.jiaoyimao.com/jg2007840/101.html",
            observedAt: baseTime.toISOString(),
            sections: {
              head: "QQ双端帐号 M7 棱镜攻势 极品A",
              report: "M7 棱镜攻势 极品A 可二次实名 永久包赔",
              safety: "安全保障 永久包赔",
              description: "威龙 红皮 巨浪"
            }
          },
          {
            sourceListingId: "102",
            url:
              "https://www.jiaoyimao.com/jg2007840/102.html",
            observedAt: baseTime.toISOString(),
            sections: {
              head:
                "商品已下架 很抱歉，无法查看【商品已下架】的商品信息 返回首页查看类似商品",
              report: "",
              safety: "",
              description: ""
            }
          }
        ]
      }
    );

    const result = await service.complete(
      created.id,
      claim.bridgeToken
    );

    expect(result.state).toBe("success");
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        listings: [
          expect.objectContaining({ key: "jiaoyimao:101" })
        ]
      })
    );
  });

  it("refuses completion when staged visible detail cannot be parsed", () => {
    const database = createDatabase(":memory:");
    const browserRepository = new BrowserRefreshRepository(database);
    const listingRepository = new ListingRepository(database);
    const releaseAdmission = vi.fn();
    let time = baseTime.getTime();
    const service = new JiaoyimaoBrowserTaskService(browserRepository, {
      now: () => new Date(time),
      random: () => 0,
      publisher: listingRepository,
      releaseAdmission
    });
    const created = service.create();
    const claim = service.claim(created.id, created.claimCode);
    service.saveFilterProof(created.id, claim.bridgeToken, proof());
    service.submitListBatch(
      created.id,
      claim.bridgeToken,
      listBatch([["101", 3_000]])
    );
    service.submitLoadEvent(
      created.id,
      claim.bridgeToken,
      loadEvent(1, 1, 1, {
        visibleTotalCount: 1,
        endMarkerVisible: true
      })
    );
    time += 2_000;
    service.submitDetails(
      created.id,
      claim.bridgeToken,
      details(["101"])
    );
    database.prepare(`
      UPDATE browser_refresh_details
      SET evidence_json = ?
      WHERE job_id = ? AND source_listing_id = '101'
    `).run(
      JSON.stringify({
        head: "详情标题",
        report: "",
        safety: "",
        description: ""
      }),
      created.id
    );

    const error = captureServiceError(
      () => service.complete(created.id, claim.bridgeToken)
    );
    expect(error).toMatchObject({
      code: "staging_invalid",
      message: "Staged detail 101 could not be parsed"
    });
    expect(
      browserRepository.getJobRecord(created.id, baseTime)
    ).toMatchObject({ state: "validating" });
    expect(releaseAdmission).not.toHaveBeenCalled();
  });

  it("marks a failed publish in a second transaction and always releases admission", async () => {
    const database = createDatabase(":memory:");
    const browserRepository = new BrowserRefreshRepository(database);
    const listingRepository = new ListingRepository(database);
    const tracker = new RefreshTracker(
      listingRepository.getRefreshSnapshot()
    );
    const admission = new RefreshAdmissionController({
      browserRepository,
      tracker,
      now: () => baseTime
    });
    const service = new JiaoyimaoBrowserTaskService(browserRepository, {
      now: () => baseTime,
      random: () => 0,
      publisher: {
        commitBrowserSourceRefresh: vi.fn(() => {
          throw new Error("PRIVATE publisher failure");
        })
      },
      releaseAdmission: (jobId) => admission.releaseBrowser(jobId)
    });
    const acquired = admission.withBrowserLease(() => service.create());
    expect(acquired.kind).toBe("acquired");
    if (acquired.kind !== "acquired") throw new Error("expected lease");
    const claim = service.claim(
      acquired.value.id,
      acquired.value.claimCode
    );
    service.saveFilterProof(
      acquired.value.id,
      claim.bridgeToken,
      proof()
    );
    service.submitListBatch(
      acquired.value.id,
      claim.bridgeToken,
      listBatch([["101", 6_001]])
    );
    service.submitLoadEvent(
      acquired.value.id,
      claim.bridgeToken,
      loadEvent(1, 1, 1, {
        visibleTotalCount: 1,
        endMarkerVisible: true
      })
    );

    await expect(
      Promise.resolve().then(() =>
        service.complete(acquired.value.id, claim.bridgeToken)
      )
    ).rejects.toMatchObject({
      code: "staging_invalid",
      message: "Browser refresh publish failed"
    });
    expect(browserRepository.getJobRecord(
      acquired.value.id,
      baseTime
    )).toMatchObject({
      state: "failed",
      reason: "commit_failed",
      lastError: "commit_failed"
    });
    expect(
      admission.withAllSourcesLease(() => 42)
    ).toMatchObject({ kind: "acquired", value: 42 });
  });

  it("releases admission even if recording commit_failed throws and restart recovers committing", async () => {
    const database = createDatabase(":memory:");
    const browserRepository = new BrowserRefreshRepository(database);
    const listingRepository = new ListingRepository(database);
    const tracker = new RefreshTracker(
      listingRepository.getRefreshSnapshot()
    );
    const admission = new RefreshAdmissionController({
      browserRepository,
      tracker,
      now: () => baseTime
    });
    const service = new JiaoyimaoBrowserTaskService(browserRepository, {
      now: () => baseTime,
      random: () => 0,
      publisher: {
        commitBrowserSourceRefresh: vi.fn(() => {
          throw new Error("publish failed");
        })
      },
      releaseAdmission: (jobId) => admission.releaseBrowser(jobId)
    });
    const acquired = admission.withBrowserLease(() => service.create());
    if (acquired.kind !== "acquired") throw new Error("expected lease");
    const claim = service.claim(
      acquired.value.id,
      acquired.value.claimCode
    );
    service.saveFilterProof(
      acquired.value.id,
      claim.bridgeToken,
      proof()
    );
    service.submitListBatch(
      acquired.value.id,
      claim.bridgeToken,
      listBatch([["101", 6_001]])
    );
    service.submitLoadEvent(
      acquired.value.id,
      claim.bridgeToken,
      loadEvent(1, 1, 1, {
        visibleTotalCount: 1,
        endMarkerVisible: true
      })
    );
    database.exec(`
      CREATE TRIGGER fail_commit_failed_transition
      BEFORE UPDATE ON browser_refresh_jobs
      WHEN NEW.state = 'failed' AND NEW.reason = 'commit_failed'
      BEGIN
        SELECT RAISE(ABORT, 'cannot record failure');
      END;
    `);

    await expect(
      Promise.resolve().then(() =>
        service.complete(acquired.value.id, claim.bridgeToken)
      )
    ).rejects.toMatchObject({ code: "staging_invalid" });
    expect(admission.snapshot()).toEqual({ activeKind: "none" });
    expect(browserRepository.getJobRecord(
      acquired.value.id,
      baseTime
    )).toMatchObject({ state: "committing" });
    database.exec("DROP TRIGGER fail_commit_failed_transition");
    browserRepository.recoverInterruptedJobs(
      new Date(baseTime.getTime() + 1_000)
    );
    expect(browserRepository.getJobRecord(
      acquired.value.id,
      new Date(baseTime.getTime() + 1_000)
    )).toMatchObject({
      state: "failed",
      reason: "process_interrupted"
    });
    expect(
      admission.withAllSourcesLease(() => 42)
    ).toMatchObject({ kind: "acquired", value: 42 });
  });

  it("does not expose unexpected SQLite error details", () => {
    const f = claimed();
    f.service.saveFilterProof(f.id, f.token, proof());
    f.database.exec(`
      CREATE TRIGGER inject_private_storage_failure
      BEFORE INSERT ON browser_refresh_batches
      WHEN NEW.kind = 'list'
      BEGIN
        SELECT RAISE(
          ABORT,
          'PRIVATE_SQL table=browser_refresh_batches secret=bridge-token'
        );
      END;
    `);
    const error = captureServiceError(
      () => f.service.submitListBatch(
        f.id,
        f.token,
        listBatch([["1", 2_500]])
      )
    );
    expect(error).toMatchObject({
      code: "staging_invalid",
      message: "Browser refresh persistence failed"
    });
    expect(error.message).not.toMatch(/PRIVATE_SQL|table=|bridge-token/);
  });

  it("does not expose unexpected scoped publisher details", () => {
    const f = claimed();
    f.service.saveFilterProof(f.id, f.token, proof());
    f.service.submitListBatch(f.id, f.token, listBatch([["1", 6_001]]));
    f.service.submitLoadEvent(
      f.id,
      f.token,
      loadEvent(1, 1, 1, {
        visibleTotalCount: 1,
        endMarkerVisible: true
      })
    );
    const failing = new JiaoyimaoBrowserTaskService(f.repository, {
      now: () => baseTime,
      random: () => 0,
      publisher: {
        commitBrowserSourceRefresh: () => {
          throw new Error(
            "PRIVATE_PUBLISHER SQL=/tmp/private.sqlite token=bridge-secret"
          );
        }
      }
    });
    const error = captureServiceError(
      () => failing.complete(f.id, f.token)
    );
    expect(error).toMatchObject({
      code: "staging_invalid",
      message: "Browser refresh publish failed"
    });
    expect(error.message).not.toMatch(
      /PRIVATE_PUBLISHER|private\.sqlite|bridge-secret/
    );
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
