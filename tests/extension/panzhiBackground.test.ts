import { describe, expect, it, vi } from "vitest";
import type {
  PageRunnerResult,
  PanzhiPageSnapshot,
  VerificationBlocker
} from "../../extensions/panzhi-auto-refresh/src/contracts.js";
import {
  PanzhiAutomationApi,
  PanzhiAutomationNetworkError,
  PanzhiAutomationApiError,
  PanzhiAutomationProtocolError,
  type PanzhiAutomationApiPort,
  type PanzhiAutomationClaim,
  type PanzhiAutomationJobView
} from "../../extensions/panzhi-auto-refresh/src/api.js";
import {
  normalizeStoredPanzhiJob,
  parsePageRunnerResult,
  parseVerificationCheck,
  PanzhiContentProtocolError,
  PanzhiBackgroundController,
  sendContentCommandWithInjection,
  type PanzhiBackgroundDependencies,
  type StoredPanzhiJob
} from "../../extensions/panzhi-auto-refresh/src/background.js";
import type {
  PanzhiBrowserTab,
  PanzhiTabsApi
} from "../../extensions/panzhi-auto-refresh/src/tabSelection.js";

const canonicalUrl = "https://www.pzds.com/goodsList/391/6";
const firstJobId = "00000000-0000-4000-8000-000000000001";
const secondJobId = "00000000-0000-4000-8000-000000000002";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function job(
  id = firstJobId,
  state: PanzhiAutomationJobView["state"] = "opening_page",
  mode: PanzhiAutomationJobView["mode"] = "quick"
): PanzhiAutomationJobView {
  return {
    id,
    mode,
    state,
    leaseExpiresAt: "2026-08-04T08:02:00.000Z",
    verificationDeadlineAt:
      state === "awaiting_user_verification"
        ? "2026-08-05T08:00:00.000Z"
        : null,
    verificationNotifiedAt:
      state === "awaiting_user_verification"
        ? "2026-08-04T08:00:00.000Z"
        : null,
    error: null,
    scanRunId: null,
    createdAt: "2026-08-04T08:00:00.000Z",
    updatedAt: "2026-08-04T08:00:00.000Z",
    finishedAt: null
  };
}

function claim(
  id = firstJobId,
  state: PanzhiAutomationJobView["state"] = "opening_page",
  mode: PanzhiAutomationJobView["mode"] = "quick",
  bearerToken = `token-${id}-abcdefghijklmnopqrstuvwxyz0123456789`
): PanzhiAutomationClaim {
  return { job: job(id, state, mode), bearerToken };
}

function snapshot(id = "CARD-1"): PanzhiPageSnapshot {
  return {
    mode: "quick",
    filterProof: {
      currentUrl: canonicalUrl,
      gameLabel: "三角洲行动",
      minPriceInput: "1900",
      maxPriceInput: "4000",
      secondRealNameFilter: { label: "可二次实名", selected: true },
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
      observedAt: "2026-08-04T08:00:00.000Z"
    },
    loadActionCount: 2,
    observedUniqueCount: 1,
    stopReason: "quick_window",
    items: [{
      sourceListingId: id,
      url: `https://www.pzds.com/goodsDetails/${id}/6`,
      title: id,
      rawText: `${id} QQ 可二次实名`,
      priceCny: 2_999
    }]
  };
}

function snapshotResult(value = snapshot()): PageRunnerResult {
  return { kind: "snapshot", stage: "submitting", snapshot: value };
}

function makeFixture(options: {
  stored?: StoredPanzhiJob | null;
  claimResult?: PanzhiAutomationClaim | null;
  resumeResult?: PanzhiAutomationClaim;
  runnerResult?: PageRunnerResult | Promise<PageRunnerResult>;
  existingTabs?: PanzhiBrowserTab[];
  checkResult?:
    | { kind: "clear" }
    | { kind: "blocked"; blocker: VerificationBlocker };
  random?: number;
} = {}) {
  let stored = options.stored ?? null;
  let currentTime = Date.parse("2026-08-04T08:00:00.000Z");
  let currentJob = options.resumeResult?.job ??
    options.claimResult?.job ??
    job(
      options.stored?.jobId,
      "opening_page",
      options.stored?.mode
    );
  const writes: StoredPanzhiJob[] = [];
  const api: PanzhiAutomationApiPort = {
    recordExtensionHeartbeat: vi.fn().mockResolvedValue(undefined),
    claimJob: vi.fn().mockImplementation(async () => {
      const result = options.claimResult === undefined ? claim() : options.claimResult;
      if (result) currentJob = result.job;
      return result;
    }),
    resumeJob: vi.fn().mockImplementation(async () => {
      const result = options.resumeResult ?? claim();
      currentJob = result.job;
      return result;
    }),
    heartbeatJob: vi.fn().mockImplementation(async (active) => ({
      job: currentJob.id === active.jobId
        ? currentJob
        : job(active.jobId, "opening_page", active.mode),
      leaseExpiresAt: "2026-08-04T08:02:00.000Z"
    })),
    updateJobState: vi.fn().mockImplementation(async (_active, update) => {
      currentJob = job(
        _active.jobId,
        update.state,
        _active.mode
      );
      return {
        job: currentJob,
        ...(update.state === "awaiting_user_verification"
          ? { shouldNotify: true }
          : {})
      };
    }),
    submitSnapshot: vi.fn().mockResolvedValue({ deduplicated: false })
  };
  const existingTabs = options.existingTabs ?? [{
    id: 7,
    url: canonicalUrl,
    lastAccessed: 100
  }];
  const tabs: PanzhiTabsApi = {
    query: vi.fn().mockResolvedValue(existingTabs),
    create: vi.fn().mockResolvedValue({
      id: 8,
      url: canonicalUrl,
      lastAccessed: 101
    }),
    get: vi.fn().mockImplementation(async (id) =>
      existingTabs.find((candidate) => candidate.id === id) ?? null),
    update: vi.fn().mockImplementation(async (id, properties) => {
      const candidate = existingTabs.find((item) => item.id === id);
      if (!candidate) return null;
      if (properties.url !== undefined) candidate.url = properties.url;
      return candidate;
    })
  };
  const delays: number[] = [];
  const dependencies: PanzhiBackgroundDependencies = {
    api,
    tabs,
    storage: {
      read: vi.fn().mockImplementation(async () => stored),
      write: vi.fn().mockImplementation(async (value) => {
        stored = { ...value };
        writes.push({ ...value });
      }),
      clear: vi.fn().mockImplementation(async () => {
        stored = null;
      })
    },
    runPage: vi.fn().mockImplementation(async () =>
      await (options.runnerResult ?? snapshotResult())),
    checkVerification: vi.fn().mockResolvedValue(
      options.checkResult ?? { kind: "blocked", blocker: "captcha" }
    ),
    focusTab: vi.fn().mockResolvedValue(undefined),
    notifyVerification: vi.fn().mockResolvedValue(undefined),
    reportError: vi.fn(),
    sleep: vi.fn().mockImplementation(async (milliseconds) => {
      delays.push(milliseconds);
    }),
    now: () => new Date(currentTime),
    random: () => options.random ?? 0.5
  };
  const controller = new PanzhiBackgroundController(dependencies);
  return {
    controller,
    dependencies,
    api,
    tabs,
    delays,
    writes,
    advanceTime: (milliseconds: number) => {
      currentTime += milliseconds;
    },
    getStored: () => stored
  };
}

describe("Panzhi MV3 worker lifecycle", () => {
  it("reports an unexpected cycle failure instead of hiding it", async () => {
    const f = makeFixture({ claimResult: null });
    const failure = new PanzhiAutomationNetworkError(
      "Panzhi automation API is unreachable"
    );
    vi.mocked(f.api.recordExtensionHeartbeat).mockRejectedValueOnce(failure);

    await f.controller.tick();

    expect(f.dependencies.reportError).toHaveBeenCalledOnce();
    expect(f.dependencies.reportError).toHaveBeenCalledWith(failure);
  });

  it("classifies fetch rejection as network failure and malformed success as protocol failure", async () => {
    const networkApi = new PanzhiAutomationApi(
      vi.fn().mockRejectedValue(new TypeError("fetch failed"))
    );
    await expect(networkApi.claimJob()).rejects.toBeInstanceOf(
      PanzhiAutomationNetworkError
    );

    const protocolApi = new PanzhiAutomationApi(
      vi.fn().mockResolvedValue({
        ok: true,
        status: 202,
        json: vi.fn().mockResolvedValue({ bearerToken: "missing-job" })
      })
    );
    await expect(protocolApi.claimJob()).rejects.toBeInstanceOf(
      PanzhiAutomationProtocolError
    );
  });

  it("strictly parses content bridge verification and runner messages", () => {
    expect(parseVerificationCheck({ kind: "clear" })).toEqual({ kind: "clear" });
    expect(parseVerificationCheck({
      kind: "blocked",
      blocker: "login"
    })).toEqual({ kind: "blocked", blocker: "login" });
    expect(() => parseVerificationCheck({
      kind: "clear",
      blocker: "captcha"
    })).toThrow(PanzhiContentProtocolError);
    expect(() => parseVerificationCheck({
      kind: "blocked",
      blocker: "unknown"
    })).toThrow(PanzhiContentProtocolError);

    const complete = snapshotResult(snapshot("STRICT-CARD"));
    expect(parsePageRunnerResult(complete)).toEqual(complete);
    expect(() => parsePageRunnerResult({ kind: "snapshot" }))
      .toThrow(PanzhiContentProtocolError);
    expect(() => parsePageRunnerResult({
      ...complete,
      snapshot: { ...complete.snapshot, observedUniqueCount: Number.NaN }
    })).toThrow(PanzhiContentProtocolError);
    expect(() => parsePageRunnerResult({
      ...complete,
      snapshot: { ...complete.snapshot, loadActionCount: 1 }
    })).toThrow(PanzhiContentProtocolError);
    expect(() => parsePageRunnerResult({
      ...complete,
      snapshot: {
        ...complete.snapshot,
        observedUniqueCount: 0,
        items: []
      }
    })).toThrow(PanzhiContentProtocolError);
    expect(() => parsePageRunnerResult({
      ...complete,
      snapshot: {
        ...complete.snapshot,
        items: [{
          ...complete.snapshot.items[0],
          url: `${complete.snapshot.items[0]?.url}?tracking=1`
        }]
      }
    })).toThrow(PanzhiContentProtocolError);
  });

  it("normalizes legacy storage to the exact four ownership fields", () => {
    expect(normalizeStoredPanzhiJob({
      jobId: firstJobId,
      bearerToken: claim().bearerToken,
      mode: "quick",
      tabId: 7,
      items: snapshot().items,
      pendingSnapshot: snapshot()
    })).toEqual({
      jobId: firstJobId,
      bearerToken: claim().bearerToken,
      mode: "quick",
      tabId: 7
    });
  });

  it("injects the packaged content entry once when an existing tab has no receiver, then retries each command once", async () => {
    const injection = deferred<void>();
    const bridge = {
      sendMessage: vi.fn()
        .mockRejectedValueOnce(new Error("Could not establish connection. Receiving end does not exist."))
        .mockRejectedValueOnce(new Error("Could not establish connection. Receiving end does not exist."))
        .mockResolvedValueOnce({ kind: "clear" })
        .mockResolvedValueOnce({ kind: "clear" }),
      executeScript: vi.fn().mockReturnValue(injection.promise)
    };

    const first = sendContentCommandWithInjection(7, { type: "first" }, bridge);
    const second = sendContentCommandWithInjection(7, { type: "second" }, bridge);
    await vi.waitFor(() => expect(bridge.executeScript).toHaveBeenCalledOnce());
    injection.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { kind: "clear" },
      { kind: "clear" }
    ]);
    expect(bridge.executeScript).toHaveBeenCalledWith({
      target: { tabId: 7 },
      files: ["content.js"]
    });
    expect(bridge.sendMessage).toHaveBeenCalledTimes(4);
  });

  it("shares one in-memory promise across overlapping alarm ticks", async () => {
    const heartbeat = deferred<void>();
    const f = makeFixture({ claimResult: null });
    vi.mocked(f.api.recordExtensionHeartbeat).mockReturnValue(heartbeat.promise);

    const first = f.controller.tick();
    const second = f.controller.tick();

    expect(second).toBe(first);
    expect(f.api.recordExtensionHeartbeat).toHaveBeenCalledOnce();
    heartbeat.resolve();
    await first;
  });

  it("uses an overlapping 30-second alarm to renew the active lease without starting a second page run", async () => {
    const runner = deferred<PageRunnerResult>();
    const f = makeFixture({ runnerResult: runner.promise });
    const first = f.controller.tick();
    await vi.waitFor(() => expect(f.dependencies.runPage).toHaveBeenCalledOnce());

    const second = f.controller.tick();

    expect(second).toBe(first);
    await vi.waitFor(() => expect(f.api.heartbeatJob).toHaveBeenCalledOnce());
    expect(f.dependencies.runPage).toHaveBeenCalledOnce();
    runner.resolve(snapshotResult());
    await first;
  });

  it("keeps extension presence fresh and never lets a delayed lease heartbeat roll back content progress", async () => {
    const runner = deferred<PageRunnerResult>();
    const heartbeat = deferred<Awaited<
      ReturnType<PanzhiAutomationApiPort["heartbeatJob"]>
    >>();
    const f = makeFixture({ runnerResult: runner.promise });
    const first = f.controller.tick();
    await vi.waitFor(() => expect(f.dependencies.runPage).toHaveBeenCalledOnce());
    vi.mocked(f.api.heartbeatJob).mockReturnValue(heartbeat.promise);

    f.controller.tick();
    await f.controller.handleContentStage(7, "collecting");
    heartbeat.resolve({
      job: job(firstJobId, "applying_filters"),
      leaseExpiresAt: "2026-08-04T08:03:00.000Z"
    });
    await heartbeat.promise;
    await f.controller.handleContentStage(7, "submitting");

    expect(f.api.recordExtensionHeartbeat).toHaveBeenCalledTimes(2);
    expect(vi.mocked(f.api.updateJobState).mock.calls.map(([, update]) =>
      update.state
    )).toEqual(["applying_filters", "collecting", "submitting"]);
    runner.resolve(snapshotResult());
    await first;
  });

  it("persists job ID, bearer, mode, and chosen tab before page work", async () => {
    const runner = deferred<PageRunnerResult>();
    const f = makeFixture({ runnerResult: runner.promise });
    const pending = f.controller.tick();

    await vi.waitFor(() => expect(f.dependencies.runPage).toHaveBeenCalled());
    expect(f.getStored()).toEqual({
      jobId: firstJobId,
      bearerToken: claim().bearerToken,
      mode: "quick",
      tabId: 7
    });
    runner.resolve(snapshotResult());
    await pending;
  });

  it("resumes a valid persisted lease without claiming another job", async () => {
    const active = {
      jobId: firstJobId,
      bearerToken: claim().bearerToken,
      mode: "quick" as const,
      tabId: 7
    };
    const f = makeFixture({ stored: active, resumeResult: claim() });

    await f.controller.tick();

    expect(f.api.resumeJob).toHaveBeenCalledWith(active);
    expect(f.api.claimJob).not.toHaveBeenCalled();
  });

  it.each([401, 404])(
    "clears a rejected persisted lease on %s and reclaims immediately",
    async (status) => {
      const active = {
        jobId: firstJobId,
        bearerToken: claim().bearerToken,
        mode: "quick" as const,
        tabId: 7
      };
      const f = makeFixture({
        stored: active,
        claimResult: claim(secondJobId, "opening_page", "deep")
      });
      vi.mocked(f.api.resumeJob).mockRejectedValue(
        new PanzhiAutomationApiError(status, "expired", "expired")
      );

      await f.controller.tick();

      expect(f.dependencies.storage.clear).toHaveBeenCalled();
      expect(f.api.claimJob).toHaveBeenCalledOnce();
      expect(f.writes).toContainEqual(expect.objectContaining({
        jobId: secondJobId,
        mode: "deep"
      }));
    }
  );

  it("deterministically reselects when the persisted tab ID is invalid", async () => {
    const active = {
      jobId: firstJobId,
      bearerToken: claim().bearerToken,
      mode: "quick" as const,
      tabId: 99
    };
    const f = makeFixture({
      stored: active,
      existingTabs: [
        { id: 4, url: canonicalUrl, lastAccessed: 20 },
        { id: 3, url: canonicalUrl, lastAccessed: 20 }
      ]
    });

    await f.controller.tick();

    expect(f.writes).toContainEqual({ ...active, tabId: 3 });
    expect(f.tabs.create).not.toHaveBeenCalled();
  });

  it("navigates a reused matching-path tab to the strict canonical URL before the runner starts", async () => {
    const active = {
      jobId: firstJobId,
      bearerToken: claim().bearerToken,
      mode: "quick" as const,
      tabId: 7
    };
    const f = makeFixture({
      stored: active,
      existingTabs: [{
        id: 7,
        url: `${canonicalUrl}?from=favorite`,
        lastAccessed: 100
      }]
    });

    await f.controller.tick();

    expect(f.tabs.update).toHaveBeenCalledWith(7, {
      url: canonicalUrl,
      active: false
    });
    expect(f.dependencies.runPage).toHaveBeenCalledOnce();
  });

  it("focuses and notifies only once for one continuous verification block", async () => {
    const f = makeFixture({
      runnerResult: {
        kind: "awaiting_user_verification",
        stage: "awaiting_user_verification",
        blocker: "captcha",
        resumeStage: "applying_filters"
      }
    });

    await f.controller.tick();
    await f.controller.tick();

    expect(f.dependencies.focusTab).toHaveBeenCalledOnce();
    expect(f.dependencies.notifyVerification).toHaveBeenCalledOnce();
    expect(f.dependencies.checkVerification).toHaveBeenCalledOnce();
  });

  it("checks a login blocker in the original stored tab without navigating, reselecting, or creating", async () => {
    const active = {
      jobId: firstJobId,
      bearerToken: claim().bearerToken,
      mode: "quick" as const,
      tabId: 7
    };
    const f = makeFixture({
      stored: active,
      resumeResult: claim(firstJobId, "awaiting_user_verification"),
      existingTabs: [{
        id: 7,
        url: "https://www.pzds.com/login?redirect=%2FgoodsList%2F391%2F6",
        lastAccessed: 100
      }],
      checkResult: { kind: "blocked", blocker: "login" }
    });

    await f.controller.tick();

    expect(f.dependencies.checkVerification).toHaveBeenCalledWith(7);
    expect(f.tabs.query).not.toHaveBeenCalled();
    expect(f.tabs.update).not.toHaveBeenCalled();
    expect(f.tabs.create).not.toHaveBeenCalled();
    expect(f.dependencies.runPage).not.toHaveBeenCalled();
  });

  it("reselects only an existing deterministic tab when the stored verification tab was closed", async () => {
    const active = {
      jobId: firstJobId,
      bearerToken: claim().bearerToken,
      mode: "quick" as const,
      tabId: 99
    };
    const f = makeFixture({
      stored: active,
      resumeResult: claim(firstJobId, "awaiting_user_verification"),
      existingTabs: [
        { id: 4, url: canonicalUrl, lastAccessed: 50 },
        { id: 3, url: canonicalUrl, lastAccessed: 50 }
      ],
      checkResult: { kind: "blocked", blocker: "captcha" }
    });

    await f.controller.tick();

    expect(f.tabs.query).toHaveBeenCalledOnce();
    expect(f.tabs.create).not.toHaveBeenCalled();
    expect(f.tabs.update).not.toHaveBeenCalled();
    expect(f.dependencies.checkVerification).toHaveBeenCalledWith(3);
    expect(f.writes).toContainEqual({ ...active, tabId: 3 });
  });

  it("fails safely when a closed verification tab has no existing replacement", async () => {
    const active = {
      jobId: firstJobId,
      bearerToken: claim().bearerToken,
      mode: "quick" as const,
      tabId: 99
    };
    const f = makeFixture({
      stored: active,
      resumeResult: claim(firstJobId, "awaiting_user_verification"),
      existingTabs: []
    });

    await f.controller.tick();

    expect(f.tabs.query).toHaveBeenCalledOnce();
    expect(f.tabs.create).not.toHaveBeenCalled();
    expect(f.tabs.update).not.toHaveBeenCalled();
    expect(f.dependencies.checkVerification).not.toHaveBeenCalled();
    expect(f.api.updateJobState).toHaveBeenCalledWith(active, {
      state: "failed",
      error: "verification_tab_missing"
    });
    expect(f.getStored()).toBeNull();
  });

  it("fails safely on an invalid verification bridge response without navigating", async () => {
    const active = {
      jobId: firstJobId,
      bearerToken: claim().bearerToken,
      mode: "quick" as const,
      tabId: 7
    };
    const f = makeFixture({
      stored: active,
      resumeResult: claim(firstJobId, "awaiting_user_verification"),
      existingTabs: [{
        id: 7,
        url: "https://www.pzds.com/login",
        lastAccessed: 100
      }]
    });
    vi.mocked(f.dependencies.checkVerification).mockRejectedValue(
      new PanzhiContentProtocolError("invalid verification response")
    );

    await f.controller.tick();

    expect(f.tabs.query).not.toHaveBeenCalled();
    expect(f.tabs.update).not.toHaveBeenCalled();
    expect(f.tabs.create).not.toHaveBeenCalled();
    expect(f.api.updateJobState).toHaveBeenCalledWith(active, {
      state: "failed",
      error: "content_protocol_error:invalid verification response"
    });
    expect(f.getStored()).toBeNull();
  });

  it("after verification disappears, reports applying_filters before restarting the runner", async () => {
    const active = {
      jobId: firstJobId,
      bearerToken: claim().bearerToken,
      mode: "quick" as const,
      tabId: 7
    };
    const f = makeFixture({
      stored: active,
      resumeResult: claim(firstJobId, "awaiting_user_verification"),
      checkResult: { kind: "clear" }
    });

    await f.controller.tick();

    expect(f.api.updateJobState).toHaveBeenNthCalledWith(
      1,
      active,
      { state: "applying_filters" }
    );
    expect(f.dependencies.runPage).toHaveBeenCalledAfter(
      vi.mocked(f.api.updateJobState)
    );
  });

  it("pauses a recovered submitting recollection for verification instead of failing it", async () => {
    const active = {
      jobId: firstJobId,
      bearerToken: claim().bearerToken,
      mode: "quick" as const,
      tabId: 7
    };
    const f = makeFixture({
      stored: active,
      resumeResult: claim(firstJobId, "submitting"),
      runnerResult: {
        kind: "awaiting_user_verification",
        stage: "awaiting_user_verification",
        blocker: "slider",
        resumeStage: "applying_filters"
      }
    });

    await f.controller.tick();

    expect(f.api.updateJobState).toHaveBeenCalledWith(active, {
      state: "awaiting_user_verification"
    });
    expect(f.dependencies.focusTab).toHaveBeenCalledWith(7);
    expect(f.dependencies.notifyVerification).toHaveBeenCalledWith("slider");
    expect(f.dependencies.storage.clear).not.toHaveBeenCalled();
    expect(f.getStored()).toEqual(active);
  });

  it("fails safely on an invalid runner response without creating a pending snapshot", async () => {
    const f = makeFixture({
      runnerResult: Promise.reject(
        new PanzhiContentProtocolError("invalid runner response")
      )
    });

    await f.controller.tick();

    expect(f.api.submitSnapshot).not.toHaveBeenCalled();
    expect(f.api.updateJobState).toHaveBeenLastCalledWith(
      expect.anything(),
      {
        state: "failed",
        error: "content_protocol_error:invalid runner response"
      }
    );
    expect(f.getStored()).toBeNull();
  });

  it("never persists collected cards and discards them across worker restart", async () => {
    const active = {
      jobId: firstJobId,
      bearerToken: claim().bearerToken,
      mode: "quick" as const,
      tabId: 7
    };
    const f = makeFixture({
      stored: active,
      resumeResult: claim(firstJobId, "collecting"),
      runnerResult: {
        kind: "failure",
        stage: "collecting",
        code: "structural_drift",
        message: "restart requires a new visible collection"
      }
    });

    await f.controller.tick();

    expect(f.dependencies.runPage).toHaveBeenCalledOnce();
    expect(f.api.submitSnapshot).not.toHaveBeenCalled();
    expect(f.writes.every((value) =>
      Object.keys(value).sort().join(",") ===
      "bearerToken,jobId,mode,tabId"
    )).toBe(true);
  });

  it.each([
    ["opening_page", ["applying_filters", "collecting", "submitting"]],
    ["applying_filters", ["collecting", "submitting"]],
    ["collecting", ["submitting"]],
    ["submitting", []]
  ] as const)(
    "recollects a recovered %s lease while sending only legal forward states",
    async (state, expectedStates) => {
      const active = {
        jobId: firstJobId,
        bearerToken: claim().bearerToken,
        mode: "quick" as const,
        tabId: 7
      };
      const f = makeFixture({
        stored: active,
        resumeResult: claim(firstJobId, state)
      });

      await f.controller.tick();

      expect(f.dependencies.runPage).toHaveBeenCalledOnce();
      expect(vi.mocked(f.api.updateJobState).mock.calls.map(([, update]) =>
        update.state
      )).toEqual(expectedStates);
      expect(f.api.submitSnapshot).toHaveBeenCalledOnce();
    }
  );

  it("retries a submission conflict with the identical payload and bounded jittered exponential delays", async () => {
    const payload = snapshot("RETRY-CARD");
    const f = makeFixture({ runnerResult: snapshotResult(payload), random: 0.5 });
    vi.mocked(f.api.submitSnapshot)
      .mockRejectedValueOnce(new PanzhiAutomationApiError(
        409,
        "refresh_conflict",
        "busy"
      ))
      .mockRejectedValueOnce(new PanzhiAutomationApiError(
        409,
        "refresh_conflict",
        "busy"
      ))
      .mockResolvedValueOnce({ deduplicated: false });

    await f.controller.tick();

    const submitted = vi.mocked(f.api.submitSnapshot).mock.calls;
    expect(submitted).toHaveLength(3);
    expect(submitted.every(([, value]) => value === payload)).toBe(true);
    expect(f.delays).toHaveLength(2);
    expect(f.delays[0]).toBeGreaterThanOrEqual(500);
    expect(f.delays[1]).toBeGreaterThan(f.delays[0]!);
    expect(Math.max(...f.delays)).toBeLessThanOrEqual(4_500);
  });

  it.each([
    [
      "network failure",
      new PanzhiAutomationNetworkError("localhost unavailable")
    ],
    [
      "HTTP 503",
      new PanzhiAutomationApiError(
        503,
        "panzhi_automation_failed",
        "temporarily unavailable"
      )
    ]
  ])(
    "keeps a snapshot only in memory after %s and retries the same object before any page work on the next tick",
    async (_label, transientError) => {
      const payload = snapshot("PENDING-CARD");
      const f = makeFixture({ runnerResult: snapshotResult(payload) });
      vi.mocked(f.api.submitSnapshot)
        .mockRejectedValueOnce(transientError)
        .mockResolvedValueOnce({ deduplicated: false });

      await f.controller.tick();

      expect(f.dependencies.runPage).toHaveBeenCalledOnce();
      expect(f.api.submitSnapshot).toHaveBeenCalledOnce();
      expect(f.getStored()).toEqual(expect.objectContaining({
        jobId: firstJobId,
        tabId: 7
      }));
      const tabReadsAfterCollection = vi.mocked(f.tabs.get).mock.calls.length;

      f.advanceTime(30_000);
      await f.controller.tick();

      expect(f.dependencies.runPage).toHaveBeenCalledOnce();
      expect(f.tabs.get).toHaveBeenCalledTimes(tabReadsAfterCollection);
      const submitted = vi.mocked(f.api.submitSnapshot).mock.calls;
      expect(submitted).toHaveLength(2);
      expect(submitted[0]?.[1]).toBe(payload);
      expect(submitted[1]?.[1]).toBe(payload);
      expect(f.getStored()).toBeNull();
    }
  );

  it.each([
    [400, "invalid_panzhi_automation_payload"],
    [409, "body_mismatch"],
    [409, "invalid_transition"]
  ])(
    "fails and clears a permanently rejected snapshot (%s %s)",
    async (status, code) => {
      const f = makeFixture();
      vi.mocked(f.api.submitSnapshot).mockRejectedValueOnce(
        new PanzhiAutomationApiError(status, code, "permanent rejection")
      );

      await f.controller.tick();

      expect(f.api.submitSnapshot).toHaveBeenCalledOnce();
      expect(f.api.updateJobState).toHaveBeenLastCalledWith(
        expect.anything(),
        {
          state: "failed",
          error: `snapshot_submit_rejected:${code}`
        }
      );
      expect(f.getStored()).toBeNull();
    }
  );

  it("ignores content stages from any tab other than the owned tab", async () => {
    const runner = deferred<PageRunnerResult>();
    const f = makeFixture({ runnerResult: runner.promise });
    const pending = f.controller.tick();
    await vi.waitFor(() => expect(f.dependencies.runPage).toHaveBeenCalled());

    await expect(f.controller.handleContentStage(999, "collecting"))
      .resolves.toBe(false);
    expect(f.api.updateJobState).toHaveBeenCalledTimes(1);
    runner.resolve(snapshotResult());
    await pending;
  });

  it("clears sensitive persisted ownership after terminal success", async () => {
    const f = makeFixture();

    await f.controller.tick();

    expect(f.dependencies.storage.clear).toHaveBeenCalledOnce();
    expect(f.getStored()).toBeNull();
  });

  it("clears sensitive persisted ownership after terminal page failure", async () => {
    const f = makeFixture({
      runnerResult: {
        kind: "failure",
        stage: "applying_filters",
        code: "missing_controls",
        message: "required controls are absent"
      }
    });

    await f.controller.tick();

    expect(f.api.updateJobState).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ state: "failed" })
    );
    expect(f.dependencies.storage.clear).toHaveBeenCalledOnce();
    expect(f.getStored()).toBeNull();
  });
});
