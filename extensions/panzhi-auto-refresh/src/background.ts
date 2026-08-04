import {
  PanzhiAutomationApi,
  PanzhiAutomationApiError,
  type PanzhiAutomationApiPort,
  type PanzhiAutomationJobView,
  type PanzhiAutomationState,
  type PanzhiAutomationStateUpdate
} from "./api.js";
import {
  PANZHI_CATALOG_URL,
  type PageRunnerResult,
  type PanzhiPageMode,
  type PanzhiPageSnapshot,
  type PanzhiPageStage,
  type VerificationBlocker
} from "./contracts.js";
import {
  selectOrCreatePanzhiTab,
  selectPanzhiTab,
  type PanzhiBrowserTab,
  type PanzhiTabsApi
} from "./tabSelection.js";

const STORAGE_KEY = "panzhiActiveJob";
const ALARM_NAME = "panzhi-automation-poll";
const ALARM_PERIOD_MINUTES = 0.5;
const MAX_SUBMISSION_ATTEMPTS = 4;

export interface ContentCommandBridge {
  sendMessage(tabId: number, message: unknown): Promise<unknown>;
  executeScript(injection: {
    target: { tabId: number };
    files: ["content.js"];
  }): Promise<unknown>;
}

const contentInjectionByTab = new Map<number, Promise<void>>();

function isMissingContentReceiver(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /receiving end does not exist|could not establish connection/i
    .test(message);
}

async function injectContentOnce(
  tabId: number,
  bridge: ContentCommandBridge
): Promise<void> {
  const existing = contentInjectionByTab.get(tabId);
  if (existing) return existing;
  const injection = bridge.executeScript({
    target: { tabId },
    files: ["content.js"]
  }).then(() => undefined).finally(() => {
    if (contentInjectionByTab.get(tabId) === injection) {
      contentInjectionByTab.delete(tabId);
    }
  });
  contentInjectionByTab.set(tabId, injection);
  return injection;
}

export async function sendContentCommandWithInjection(
  tabId: number,
  message: unknown,
  bridge: ContentCommandBridge
): Promise<unknown> {
  try {
    return await bridge.sendMessage(tabId, message);
  } catch (error) {
    if (!isMissingContentReceiver(error)) throw error;
    await injectContentOnce(tabId, bridge);
    return bridge.sendMessage(tabId, message);
  }
}

export interface StoredPanzhiJob {
  jobId: string;
  bearerToken: string;
  mode: PanzhiPageMode;
  tabId: number;
}

export interface PanzhiJobStorage {
  read(): Promise<StoredPanzhiJob | null>;
  write(active: StoredPanzhiJob): Promise<void>;
  clear(): Promise<void>;
}

export type VerificationCheck =
  | { kind: "clear" }
  | { kind: "blocked"; blocker: VerificationBlocker };

export interface PanzhiBackgroundDependencies {
  api: PanzhiAutomationApiPort;
  tabs: PanzhiTabsApi;
  storage: PanzhiJobStorage;
  runPage(tabId: number, mode: PanzhiPageMode): Promise<PageRunnerResult>;
  checkVerification(tabId: number): Promise<VerificationCheck>;
  focusTab(tabId: number): Promise<void>;
  notifyVerification(blocker: VerificationBlocker): Promise<void>;
  sleep(milliseconds: number): Promise<void>;
  now(): Date;
  random(): number;
}

interface ActiveJob {
  stored: StoredPanzhiJob;
  job: PanzhiAutomationJobView;
}

const FORWARD_STATE: Readonly<
  Partial<Record<PanzhiAutomationState, readonly PanzhiAutomationState[]>>
> = {
  opening_page: ["applying_filters"],
  applying_filters: ["collecting", "awaiting_user_verification"],
  collecting: ["awaiting_user_verification", "submitting"],
  awaiting_user_verification: ["applying_filters"]
};

function isLeaseRejection(error: unknown): boolean {
  return error instanceof PanzhiAutomationApiError &&
    (error.status === 401 || error.status === 404);
}

function isTerminalConflict(error: unknown): boolean {
  return error instanceof PanzhiAutomationApiError &&
    error.status === 409 && error.code === "terminal";
}

function isSubmissionConflict(error: unknown): boolean {
  return error instanceof PanzhiAutomationApiError &&
    error.status === 409 && error.code === "refresh_conflict";
}

function failureText(result: Extract<PageRunnerResult, { kind: "failure" }>): string {
  return `${result.code}: ${result.message}`.slice(0, 500);
}

export class PanzhiBackgroundController {
  private inFlight: Promise<void> | null = null;
  private heartbeatInFlight: Promise<void> | null = null;
  private active: ActiveJob | null = null;
  private consecutiveFailures = 0;
  private nextAttemptAt = 0;

  constructor(private readonly dependencies: PanzhiBackgroundDependencies) {}

  tick(): Promise<void> {
    if (this.inFlight) {
      void this.renewActiveLease();
      return this.inFlight;
    }
    const execution = this.executeTick().finally(() => {
      if (this.inFlight === execution) this.inFlight = null;
    });
    this.inFlight = execution;
    return execution;
  }

  private renewActiveLease(): Promise<void> {
    if (!this.active) return Promise.resolve();
    if (this.heartbeatInFlight) return this.heartbeatInFlight;
    const identity = this.active.stored;
    const heartbeat = Promise.all([
      this.dependencies.api.recordExtensionHeartbeat(),
      this.dependencies.api.heartbeatJob(identity)
    ])
      .then(() => undefined)
      .catch(async (error: unknown) => {
        if (isLeaseRejection(error) || isTerminalConflict(error)) {
          if (
            this.active?.stored.jobId === identity.jobId &&
            this.active.stored.bearerToken === identity.bearerToken
          ) {
            await this.clearActive();
          }
        }
      })
      .finally(() => {
        if (this.heartbeatInFlight === heartbeat) {
          this.heartbeatInFlight = null;
        }
      });
    this.heartbeatInFlight = heartbeat;
    return heartbeat;
  }

  async handleContentStage(
    tabId: number,
    stage: PanzhiPageStage
  ): Promise<boolean> {
    if (
      !this.active ||
      this.active.stored.tabId !== tabId ||
      stage === "awaiting_user_verification"
    ) {
      return false;
    }
    await this.advanceTo(stage);
    return true;
  }

  private async executeTick(): Promise<void> {
    if (this.dependencies.now().getTime() < this.nextAttemptAt) return;
    try {
      await this.runCycle();
      this.consecutiveFailures = 0;
      this.nextAttemptAt = 0;
    } catch {
      const base = Math.min(
        30_000,
        1_000 * 2 ** Math.min(this.consecutiveFailures, 5)
      );
      const jitter = Math.round(base * 0.25 * this.boundedRandom());
      this.consecutiveFailures += 1;
      this.nextAttemptAt = this.dependencies.now().getTime() + base + jitter;
    }
  }

  private boundedRandom(): number {
    return Math.min(1, Math.max(0, this.dependencies.random()));
  }

  private async runCycle(): Promise<void> {
    await this.dependencies.api.recordExtensionHeartbeat();
    const active = await this.recoverOrClaim();
    if (!active) return;
    await this.ensureValidTab();

    if (this.active?.job.state === "awaiting_user_verification") {
      const verification = await this.dependencies.checkVerification(
        this.active.stored.tabId
      );
      if (verification.kind === "blocked") return;
      await this.advanceTo("applying_filters");
    } else {
      await this.advanceTo("applying_filters");
    }

    if (!this.active) return;
    const result = await this.dependencies.runPage(
      this.active.stored.tabId,
      this.active.stored.mode
    );
    await this.handlePageResult(result);
  }

  private async recoverOrClaim(): Promise<ActiveJob | null> {
    if (this.active) {
      try {
        const heartbeat = await this.dependencies.api.heartbeatJob(
          this.active.stored
        );
        this.active.job = heartbeat.job;
        return this.active;
      } catch (error) {
        if (!isLeaseRejection(error) && !isTerminalConflict(error)) throw error;
        await this.clearActive();
      }
    } else {
      const stored = await this.dependencies.storage.read();
      if (stored) {
        try {
          const resumed = await this.dependencies.api.resumeJob(stored);
          this.active = { stored, job: resumed.job };
          return this.active;
        } catch (error) {
          if (!isLeaseRejection(error) && !isTerminalConflict(error)) throw error;
          await this.clearActive();
        }
      }
    }

    const claimed = await this.dependencies.api.claimJob();
    if (!claimed) return null;
    const selected = await selectOrCreatePanzhiTab(this.dependencies.tabs);
    const stored: StoredPanzhiJob = {
      jobId: claimed.job.id,
      bearerToken: claimed.bearerToken,
      mode: claimed.job.mode,
      tabId: selected.id
    };
    await this.dependencies.storage.write(stored);
    this.active = { stored, job: claimed.job };
    return this.active;
  }

  private async ensureValidTab(): Promise<void> {
    if (!this.active) return;
    let candidate: PanzhiBrowserTab | null = null;
    try {
      candidate = await this.dependencies.tabs.get(this.active.stored.tabId);
    } catch {
      candidate = null;
    }
    let selected = candidate && selectPanzhiTab([candidate])
      ? candidate
      : null;
    if (!selected || selected.id === undefined) {
      const replacement = await selectOrCreatePanzhiTab(
        this.dependencies.tabs
      );
      selected = replacement;
      this.active.stored = { ...this.active.stored, tabId: replacement.id };
      await this.dependencies.storage.write(this.active.stored);
    }
    if (selected.url !== PANZHI_CATALOG_URL) {
      selected = await this.dependencies.tabs.update(this.active.stored.tabId, {
        url: PANZHI_CATALOG_URL,
        active: false
      });
    }
    await this.waitForReadyTab(this.active.stored.tabId, selected);
  }

  private async waitForReadyTab(
    tabId: number,
    initial: PanzhiBrowserTab | null
  ): Promise<void> {
    let current = initial;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (
        current?.url === PANZHI_CATALOG_URL &&
        current.status !== "loading"
      ) {
        return;
      }
      await this.dependencies.sleep(500);
      try {
        current = await this.dependencies.tabs.get(tabId);
      } catch {
        current = null;
      }
    }
    throw new Error("Panzhi catalog tab did not finish loading");
  }

  private async handlePageResult(result: PageRunnerResult): Promise<void> {
    if (!this.active) return;
    if (result.kind === "awaiting_user_verification") {
      if (this.active.job.state === "submitting") {
        await this.failActive("captcha_required_during_safe_recollection");
        return;
      }
      const response = await this.updateState({
        state: "awaiting_user_verification"
      });
      if (response?.shouldNotify && this.active) {
        await this.dependencies.focusTab(this.active.stored.tabId);
        await this.dependencies.notifyVerification(result.blocker);
      }
      return;
    }
    if (result.kind === "failure") {
      await this.failActive(failureText(result));
      return;
    }

    await this.advanceTo("submitting");
    if (!this.active) return;
    try {
      await this.submitWithRetry(result.snapshot);
      await this.clearActive();
    } catch (error) {
      if (isSubmissionConflict(error)) {
        await this.failActive("snapshot_submit_conflict");
        return;
      }
      if (isLeaseRejection(error) || isTerminalConflict(error)) {
        await this.clearActive();
        return;
      }
      throw error;
    }
  }

  private async submitWithRetry(snapshot: PanzhiPageSnapshot): Promise<void> {
    if (!this.active) return;
    const identity = this.active.stored;
    for (let attempt = 0; attempt < MAX_SUBMISSION_ATTEMPTS; attempt += 1) {
      try {
        await this.dependencies.api.submitSnapshot(identity, snapshot);
        return;
      } catch (error) {
        if (!isSubmissionConflict(error) || attempt === MAX_SUBMISSION_ATTEMPTS - 1) {
          throw error;
        }
        const base = Math.min(4_000, 500 * 2 ** attempt);
        const jitter = Math.round(base * 0.5 * this.boundedRandom());
        await this.dependencies.sleep(base + jitter);
      }
    }
  }

  private async failActive(error: string): Promise<void> {
    if (!this.active) return;
    try {
      await this.updateState({ state: "failed", error: error.slice(0, 500) });
    } finally {
      await this.clearActive();
    }
  }

  private async advanceTo(
    desired: Extract<
      PanzhiPageStage,
      "applying_filters" | "collecting" | "submitting"
    >
  ): Promise<void> {
    if (!this.active || this.active.job.state === desired) return;
    const current = this.active.job.state;
    if (current === "submitting") return;
    if (current === "collecting") {
      if (desired === "submitting") {
        await this.updateState({ state: "submitting" });
      }
      return;
    }
    if (current === "applying_filters") {
      if (desired === "collecting") {
        await this.updateState({ state: "collecting" });
      } else if (desired === "submitting") {
        await this.updateState({ state: "collecting" });
        await this.updateState({ state: "submitting" });
      }
      return;
    }
    if (
      desired === "applying_filters" &&
      FORWARD_STATE[current]?.includes(desired)
    ) {
      await this.updateState({ state: desired });
      return;
    }
    if (current === "opening_page") {
      await this.updateState({ state: "applying_filters" });
      if (desired === "collecting" || desired === "submitting") {
        await this.updateState({ state: "collecting" });
      }
      if (desired === "submitting") {
        await this.updateState({ state: "submitting" });
      }
    }
  }

  private async updateState(
    update: PanzhiAutomationStateUpdate
  ): Promise<Awaited<ReturnType<PanzhiAutomationApiPort["updateJobState"]>> | null> {
    if (!this.active) return null;
    const response = await this.dependencies.api.updateJobState(
      this.active.stored,
      update
    );
    this.active.job = response.job;
    return response;
  }

  private async clearActive(): Promise<void> {
    this.active = null;
    await this.dependencies.storage.clear();
  }
}

interface ChromeRuntimeMessageSender {
  tab?: { id?: number };
}

function isRunnerStage(value: unknown): value is PanzhiPageStage {
  return value === "applying_filters" ||
    value === "collecting" ||
    value === "awaiting_user_verification" ||
    value === "submitting";
}

interface ChromeLike {
  alarms: {
    create(name: string, info: { periodInMinutes: number }): void;
    onAlarm: {
      addListener(listener: (alarm: { name: string }) => void): void;
    };
  };
  tabs: {
    query(queryInfo: { url: string }): Promise<PanzhiBrowserTab[]>;
    create(createProperties: {
      url: string;
      active: boolean;
    }): Promise<PanzhiBrowserTab>;
    get(tabId: number): Promise<PanzhiBrowserTab>;
    update(
      tabId: number,
      updateProperties: { active?: boolean; url?: string }
    ): Promise<PanzhiBrowserTab>;
    sendMessage(tabId: number, message: unknown): Promise<unknown>;
  };
  storage: {
    local: {
      get(key: string): Promise<Record<string, unknown>>;
      set(value: Record<string, unknown>): Promise<void>;
      remove(key: string): Promise<void>;
    };
  };
  notifications: {
    create(options: {
      type: "basic";
      iconUrl: string;
      title: string;
      message: string;
      priority: number;
    }): Promise<string>;
  };
  scripting: {
    executeScript(injection: {
      target: { tabId: number };
      files: ["content.js"];
    }): Promise<unknown>;
  };
  runtime: {
    onInstalled: { addListener(listener: () => void): void };
    onStartup: { addListener(listener: () => void): void };
    onMessage: {
      addListener(
        listener: (
          message: unknown,
          sender: ChromeRuntimeMessageSender
        ) => Promise<unknown> | undefined
      ): void;
    };
  };
}

declare const chrome: ChromeLike | undefined;

function isStoredJob(value: unknown): value is StoredPanzhiJob {
  if (value === null || typeof value !== "object") return false;
  const input = value as Partial<StoredPanzhiJob>;
  return typeof input.jobId === "string" &&
    typeof input.bearerToken === "string" &&
    (input.mode === "quick" || input.mode === "deep") &&
    typeof input.tabId === "number";
}

function createChromeController(browser: ChromeLike): PanzhiBackgroundController {
  const tabs: PanzhiTabsApi = {
    query: (queryInfo) => browser.tabs.query(queryInfo),
    create: (properties) => browser.tabs.create(properties),
    get: async (tabId) => {
      try {
        return await browser.tabs.get(tabId);
      } catch {
        return null;
      }
    },
    update: async (tabId, properties) => {
      try {
        return await browser.tabs.update(tabId, properties);
      } catch {
        return null;
      }
    }
  };
  const contentBridge: ContentCommandBridge = {
    sendMessage: (tabId, message) => browser.tabs.sendMessage(tabId, message),
    executeScript: (injection) => browser.scripting.executeScript(injection)
  };
  return new PanzhiBackgroundController({
    api: new PanzhiAutomationApi(),
    tabs,
    storage: {
      read: async () => {
        const value = (await browser.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
        return isStoredJob(value) ? value : null;
      },
      write: (active) => browser.storage.local.set({ [STORAGE_KEY]: active }),
      clear: () => browser.storage.local.remove(STORAGE_KEY)
    },
    runPage: async (tabId, mode) =>
      await sendContentCommandWithInjection(tabId, {
        type: "panzhi-run",
        mode
      }, contentBridge) as PageRunnerResult,
    checkVerification: async (tabId) =>
      await sendContentCommandWithInjection(tabId, {
        type: "panzhi-check-verification"
      }, contentBridge) as VerificationCheck,
    focusTab: async (tabId) => {
      await browser.tabs.update(tabId, { active: true });
    },
    notifyVerification: async (blocker) => {
      await browser.notifications.create({
        type: "basic",
        iconUrl: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>",
        title: "盼之需要人工验证",
        message: `请在已打开的盼之页面完成${
          blocker === "login" ? "登录" : blocker === "slider" ? "滑块" : "验证码"
        }，完成后会自动继续。`,
        priority: 2
      });
    },
    sleep: (milliseconds) => new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    }),
    now: () => new Date(),
    random: () => Math.random()
  });
}

if (typeof chrome !== "undefined") {
  const controller = createChromeController(chrome);
  const ensureAlarm = (): void => {
    chrome.alarms.create(ALARM_NAME, {
      periodInMinutes: ALARM_PERIOD_MINUTES
    });
    void controller.tick();
  };
  chrome.runtime.onInstalled.addListener(ensureAlarm);
  chrome.runtime.onStartup.addListener(ensureAlarm);
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) void controller.tick();
  });
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (
      message === null ||
      typeof message !== "object" ||
      (message as { type?: unknown }).type !== "panzhi-stage" ||
      !isRunnerStage((message as { stage?: unknown }).stage) ||
      sender.tab?.id === undefined
    ) {
      return undefined;
    }
    return controller.handleContentStage(
      sender.tab.id,
      (message as { stage: PanzhiPageStage }).stage
    );
  });
  ensureAlarm();
}
