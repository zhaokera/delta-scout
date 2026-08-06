import {
  PanzhiAutomationApi,
  PanzhiAutomationApiError,
  PanzhiAutomationNetworkError,
  PanzhiAutomationProtocolError,
  type PanzhiAutomationApiPort,
  type PanzhiAutomationJobView,
  type PanzhiAutomationState,
  type PanzhiAutomationStateUpdate
} from "./api.js";
import {
  PANZHI_CATALOG_URL,
  PANZHI_REQUIRED_OPERATOR_SKINS,
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

export class PanzhiContentProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PanzhiContentProtocolError";
  }
}

function strictRecord(
  value: unknown,
  keys: readonly string[]
): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const input = value as Record<string, unknown>;
  const actualKeys = Object.keys(input);
  return actualKeys.length === keys.length &&
    actualKeys.every((key) => keys.includes(key))
    ? input
    : null;
}

function contentProtocol(message: string): never {
  throw new PanzhiContentProtocolError(message);
}

function verificationBlocker(value: unknown): VerificationBlocker | null {
  return value === "captcha" || value === "slider" || value === "login"
    ? value
    : null;
}

export function parseVerificationCheck(value: unknown): VerificationCheck {
  const clear = strictRecord(value, ["kind"]);
  if (clear?.kind === "clear") return { kind: "clear" };
  const blocked = strictRecord(value, ["kind", "blocker"]);
  const blocker = verificationBlocker(blocked?.blocker);
  if (blocked?.kind === "blocked" && blocker) {
    return { kind: "blocked", blocker };
  }
  return contentProtocol("invalid verification response");
}

function validIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function parseFilterProof(value: unknown): boolean {
  const proof = strictRecord(value, [
    "currentUrl",
    "gameLabel",
    "minPriceInput",
    "maxPriceInput",
    "secondRealNameFilter",
    "operatorSkinFilter",
    "observedAt"
  ]);
  if (!proof) return false;
  const realName = strictRecord(proof.secondRealNameFilter, [
    "label",
    "selected"
  ]);
  const skin = strictRecord(proof.operatorSkinFilter, [
    "fieldId",
    "fieldLabel",
    "fieldType",
    "mappingField",
    "searchType",
    "searchTypeLabel",
    "selectedOptions"
  ]);
  if (!realName || !skin || !Array.isArray(skin.selectedOptions)) return false;
  const optionsValid = skin.selectedOptions.length ===
      PANZHI_REQUIRED_OPERATOR_SKINS.length &&
    skin.selectedOptions.every((option, index) => {
      const parsed = strictRecord(option, [
        "optionId",
        "label",
        "metadataCode"
      ]);
      const expected = PANZHI_REQUIRED_OPERATOR_SKINS[index];
      return parsed !== null && expected !== undefined &&
        parsed.optionId === expected.optionId &&
        parsed.label === expected.label &&
        parsed.metadataCode === expected.metadataCode;
    });
  return proof.currentUrl === PANZHI_CATALOG_URL &&
    proof.gameLabel === "三角洲行动" &&
    proof.minPriceInput === "1900" &&
    proof.maxPriceInput === "4000" &&
    realName.label === "可二次实名" &&
    realName.selected === true &&
    skin.fieldId === "22858" &&
    skin.fieldLabel === "特战干员外观" &&
    skin.fieldType === "CHECKBOX" &&
    skin.mappingField === "22858" &&
    skin.searchType === "ALL" &&
    skin.searchTypeLabel === "全部都要有" &&
    optionsValid &&
    validIsoTimestamp(proof.observedAt);
}

interface ParsedSnapshotItem {
  id: string;
  url: string;
  priceCny: number;
}

function parseSnapshotItem(value: unknown): ParsedSnapshotItem | null {
  const item = strictRecord(value, [
    "sourceListingId",
    "url",
    "title",
    "rawText",
    "priceCny"
  ]);
  if (
    !item ||
    typeof item.sourceListingId !== "string" ||
    !/^[A-Za-z0-9_-]{1,80}$/.test(item.sourceListingId) ||
    typeof item.url !== "string" ||
    item.url.length > 300 ||
    typeof item.title !== "string" ||
    item.title.trim().length < 1 ||
    item.title.trim().length > 500 ||
    typeof item.rawText !== "string" ||
    item.rawText.trim().length < 1 ||
    item.rawText.trim().length > 4_000 ||
    typeof item.priceCny !== "number" ||
    !Number.isFinite(item.priceCny) ||
    item.priceCny < 0 ||
    item.priceCny > 100_000_000 ||
    item.url !== item.url.trim()
  ) return null;
  try {
    const url = new URL(item.url);
    if (
      url.origin !== "https://www.pzds.com" ||
      url.pathname !== `/goodsDetails/${item.sourceListingId}/6` ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) return null;
  } catch {
    return null;
  }
  return {
    id: item.sourceListingId,
    url: item.url,
    priceCny: item.priceCny
  };
}

function parseSnapshot(value: unknown): PanzhiPageSnapshot | null {
  const snapshot = strictRecord(value, [
    "mode",
    "filterProof",
    "loadActionCount",
    "observedUniqueCount",
    "stopReason",
    "items"
  ]);
  if (
    !snapshot ||
    (snapshot.mode !== "quick" && snapshot.mode !== "deep") ||
    !Number.isInteger(snapshot.loadActionCount) ||
    typeof snapshot.loadActionCount !== "number" ||
    snapshot.loadActionCount < 1 ||
    !Number.isInteger(snapshot.observedUniqueCount) ||
    typeof snapshot.observedUniqueCount !== "number" ||
    snapshot.observedUniqueCount < 0 ||
    !Array.isArray(snapshot.items) ||
    !parseFilterProof(snapshot.filterProof)
  ) return null;
  const expectedStop = snapshot.mode === "quick"
    ? "quick_window"
    : "no_growth_twice";
  const maxLoads = snapshot.mode === "quick" ? 6 : 100;
  const maxItems = snapshot.mode === "quick" ? 60 : 500;
  const ids = snapshot.items.map(parseSnapshotItem);
  const parsedItems = ids.filter(
    (item): item is ParsedSnapshotItem => item !== null
  );
  const isEmptyResult = snapshot.stopReason === "empty_result";
  const validShape = isEmptyResult
    ? snapshot.loadActionCount === 1 &&
      snapshot.observedUniqueCount === 0 &&
      snapshot.items.length === 0
    : snapshot.stopReason === expectedStop &&
      snapshot.loadActionCount >= 2 &&
      snapshot.observedUniqueCount >= 1 &&
      snapshot.items.length >= 1 &&
      parsedItems.some(
        ({ priceCny }) => priceCny >= 1_900 && priceCny <= 4_000
      );
  if (
    !validShape ||
    snapshot.loadActionCount > maxLoads ||
    snapshot.items.length > maxItems ||
    snapshot.observedUniqueCount !== snapshot.items.length ||
    parsedItems.length !== snapshot.items.length ||
    new Set(parsedItems.map(({ id }) => id)).size !== parsedItems.length ||
    new Set(parsedItems.map(({ url }) => url)).size !== parsedItems.length
  ) return null;
  return snapshot as unknown as PanzhiPageSnapshot;
}

export function parsePageRunnerResult(value: unknown): PageRunnerResult {
  const superseded = strictRecord(value, ["kind", "stage"]);
  if (
    superseded?.kind === "superseded" &&
    (superseded.stage === "applying_filters" ||
      superseded.stage === "collecting" ||
      superseded.stage === "submitting")
  ) {
    return {
      kind: "superseded",
      stage: superseded.stage
    };
  }

  const awaiting = strictRecord(value, [
    "kind",
    "stage",
    "blocker",
    "resumeStage"
  ]);
  const blocker = verificationBlocker(awaiting?.blocker);
  if (
    awaiting?.kind === "awaiting_user_verification" &&
    awaiting.stage === "awaiting_user_verification" &&
    blocker &&
    awaiting.resumeStage === "applying_filters"
  ) {
    return {
      kind: "awaiting_user_verification",
      stage: "awaiting_user_verification",
      blocker,
      resumeStage: "applying_filters"
    };
  }

  const failureKeys = value !== null && typeof value === "object" &&
    "loadActionCount" in value
    ? ["kind", "stage", "code", "message", "loadActionCount"]
    : ["kind", "stage", "code", "message"];
  const failure = strictRecord(value, failureKeys);
  const validFailureCode = failure?.code === "missing_controls" ||
    failure?.code === "structural_drift" ||
    failure?.code === "collection_limit" ||
    failure?.code === "operation_timeout";
  const validFailureCount = failure && "loadActionCount" in failure
    ? typeof failure.loadActionCount === "number" &&
      Number.isInteger(failure.loadActionCount) &&
      failure.loadActionCount >= 0
    : true;
  if (
    failure?.kind === "failure" &&
    (failure.stage === "applying_filters" || failure.stage === "collecting") &&
    validFailureCode &&
    typeof failure.message === "string" &&
    validFailureCount
  ) {
    return failure as unknown as PageRunnerResult;
  }

  const result = strictRecord(value, ["kind", "stage", "snapshot"]);
  const snapshot = parseSnapshot(result?.snapshot);
  if (result?.kind === "snapshot" && result.stage === "submitting" && snapshot) {
    return { kind: "snapshot", stage: "submitting", snapshot };
  }
  return contentProtocol("invalid runner response");
}

export interface ContentCommandBridge {
  contentScriptFile: string;
  sendMessage(tabId: number, message: unknown): Promise<unknown>;
  executeScript(injection: {
    target: { tabId: number };
    files: [string];
  }): Promise<unknown>;
}

export function resolvePackagedContentScript(manifest: unknown): string {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Panzhi extension must declare exactly one packaged content script");
  }
  const entries = (manifest as { content_scripts?: unknown }).content_scripts;
  if (!Array.isArray(entries)) {
    throw new Error("Panzhi extension must declare exactly one packaged content script");
  }
  const files = entries.flatMap((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const scripts = (entry as { js?: unknown }).js;
    return Array.isArray(scripts) ? scripts : [];
  });
  if (
    files.length !== 1 ||
    typeof files[0] !== "string" ||
    !/^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.js$/.test(files[0])
  ) {
    throw new Error("Panzhi extension must declare exactly one packaged content script");
  }
  return files[0];
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
    files: [bridge.contentScriptFile]
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
  await injectContentOnce(tabId, bridge);
  return bridge.sendMessage(tabId, message);
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
  runPage(
    tabId: number,
    mode: PanzhiPageMode,
    runId: string
  ): Promise<PageRunnerResult>;
  checkVerification(tabId: number): Promise<VerificationCheck>;
  focusTab(tabId: number): Promise<void>;
  notifyVerification(blocker: VerificationBlocker): Promise<void>;
  reportError(error: unknown): void;
  sleep(milliseconds: number): Promise<void>;
  now(): Date;
  random(): number;
  createRunId(): string;
}

interface ActiveJob {
  stored: StoredPanzhiJob;
  job: PanzhiAutomationJobView;
}

interface PendingSnapshot {
  jobId: string;
  bearerToken: string;
  snapshot: PanzhiPageSnapshot;
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

function isTransientSubmissionError(error: unknown): boolean {
  return error instanceof PanzhiAutomationNetworkError ||
    (error instanceof PanzhiAutomationApiError && (
      error.status === 408 ||
      error.status === 429 ||
      (error.status >= 500 && error.status <= 599)
    ));
}

function permanentSubmissionCode(error: unknown): string {
  if (error instanceof PanzhiAutomationApiError) return error.code;
  if (error instanceof PanzhiAutomationProtocolError) return "protocol_error";
  return "unexpected_error";
}

function failureText(result: Extract<PageRunnerResult, { kind: "failure" }>): string {
  return `${result.code}: ${result.message}`.slice(0, 500);
}

export class PanzhiBackgroundController {
  private inFlight: Promise<void> | null = null;
  private heartbeatInFlight: Promise<void> | null = null;
  private active: ActiveJob | null = null;
  private pendingSnapshot: PendingSnapshot | null = null;
  private tabResetJobId: string | null = null;
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
            const tabId = identity.tabId;
            await this.clearActive();
            await this.resetTabAfterLeaseLoss(tabId);
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

  async handleContentDelay(
    tabId: number,
    milliseconds: number
  ): Promise<boolean> {
    if (
      !this.active ||
      this.active.stored.tabId !== tabId ||
      !Number.isInteger(milliseconds) ||
      milliseconds < 0 ||
      milliseconds > 10_000
    ) {
      return false;
    }
    await this.dependencies.api.delayJob(this.active.stored, milliseconds);
    return true;
  }

  private async executeTick(): Promise<void> {
    if (this.dependencies.now().getTime() < this.nextAttemptAt) return;
    try {
      await this.runCycle();
      this.consecutiveFailures = 0;
      this.nextAttemptAt = 0;
    } catch (error) {
      this.dependencies.reportError(error);
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
    if (
      this.pendingSnapshot?.jobId === active.stored.jobId &&
      this.pendingSnapshot.bearerToken === active.stored.bearerToken
    ) {
      await this.submitPendingSnapshot();
      return;
    }
    this.pendingSnapshot = null;

    if (this.active?.job.state === "awaiting_user_verification") {
      const verificationTabId = await this.resolveVerificationTab();
      if (verificationTabId === null) {
        await this.failActive("verification_tab_missing");
        return;
      }
      let verification: VerificationCheck;
      try {
        verification = await this.dependencies.checkVerification(
          verificationTabId
        );
      } catch (error) {
        if (error instanceof PanzhiContentProtocolError) {
          await this.failActive(`content_protocol_error:${error.message}`);
          return;
        }
        throw error;
      }
      if (verification.kind === "blocked") return;
      await this.advanceTo("applying_filters");
      await this.ensureValidTab();
    } else {
      await this.ensureValidTab();
      await this.advanceTo("applying_filters");
    }

    if (!this.active) return;
    await this.dependencies.focusTab(this.active.stored.tabId);
    let result: PageRunnerResult;
    try {
      result = await this.dependencies.runPage(
        this.active.stored.tabId,
        this.active.stored.mode,
        this.dependencies.createRunId()
      );
    } catch (error) {
      if (error instanceof PanzhiContentProtocolError) {
        await this.failActive(`content_protocol_error:${error.message}`);
        return;
      }
      throw error;
    }
    if (
      result.kind === "failure" &&
      result.code === "missing_controls" &&
      this.active
    ) {
      const tabId = this.active.stored.tabId;
      await this.dependencies.tabs.reload(tabId);
      await this.waitForReadyTab(
        tabId,
        await this.dependencies.tabs.get(tabId)
      );
      if (!this.active) return;
      await this.dependencies.focusTab(tabId);
      try {
        result = await this.dependencies.runPage(
          tabId,
          this.active.stored.mode,
          this.dependencies.createRunId()
        );
      } catch (error) {
        if (error instanceof PanzhiContentProtocolError) {
          await this.failActive(`content_protocol_error:${error.message}`);
          return;
        }
        throw error;
      }
    }
    await this.handlePageResult(result);
  }

  private async resolveVerificationTab(): Promise<number | null> {
    if (!this.active) return null;
    const storedTabId = this.active.stored.tabId;
    try {
      const storedTab = await this.dependencies.tabs.get(storedTabId);
      if (storedTab) return storedTabId;
    } catch {
      // Fall through to existing-tab selection without creating or navigating.
    }
    const candidates = await this.dependencies.tabs.query({
      url: "https://www.pzds.com/*"
    });
    const selected = selectPanzhiTab(candidates);
    if (selected?.id === undefined) return null;
    this.active.stored = { ...this.active.stored, tabId: selected.id };
    await this.dependencies.storage.write(this.active.stored);
    return selected.id;
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
          this.tabResetJobId = resumed.job.state === "awaiting_user_verification"
            ? null
            : resumed.job.id;
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

  private async resetTabAfterLeaseLoss(tabId: number): Promise<void> {
    try {
      const reset = await this.dependencies.tabs.update(tabId, {
        url: PANZHI_CATALOG_URL,
        active: false
      });
      if (!reset) {
        this.dependencies.reportError(
          new Error("Panzhi tab could not be reset after lease loss")
        );
      }
    } catch (error) {
      this.dependencies.reportError(error);
    }
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
    const resetRequested = this.tabResetJobId === this.active.stored.jobId;
    if (selected.url !== PANZHI_CATALOG_URL) {
      const updated = await this.dependencies.tabs.update(
        this.active.stored.tabId,
        {
          url: PANZHI_CATALOG_URL,
          active: false
        }
      );
      if (!updated) {
        throw new Error("Panzhi catalog tab could not be reset");
      }
      selected = updated;
      if (resetRequested) this.tabResetJobId = null;
    } else if (resetRequested) {
      await this.dependencies.tabs.reload(this.active.stored.tabId);
      selected = await this.dependencies.tabs.get(this.active.stored.tabId);
      this.tabResetJobId = null;
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
    if (result.kind === "superseded") {
      throw new Error("Panzhi page run was superseded");
    }
    if (result.kind === "awaiting_user_verification") {
      const response = await this.updateState({
        state: "awaiting_user_verification"
      });
      if (response?.shouldNotify && this.active) {
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
    this.pendingSnapshot = {
      jobId: this.active.stored.jobId,
      bearerToken: this.active.stored.bearerToken,
      snapshot: result.snapshot
    };
    await this.submitPendingSnapshot();
  }

  private async submitPendingSnapshot(): Promise<void> {
    if (!this.active || !this.pendingSnapshot) return;
    if (
      this.pendingSnapshot.jobId !== this.active.stored.jobId ||
      this.pendingSnapshot.bearerToken !== this.active.stored.bearerToken
    ) {
      this.pendingSnapshot = null;
      return;
    }
    try {
      await this.submitWithRetry(this.pendingSnapshot.snapshot);
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
      if (isTransientSubmissionError(error)) throw error;
      await this.failActive(
        `snapshot_submit_rejected:${permanentSubmissionCode(error)}`
      );
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
    this.pendingSnapshot = null;
    this.tabResetJobId = null;
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
    reload(tabId: number): Promise<void>;
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
      files: [string];
    }): Promise<unknown>;
  };
  runtime: {
    getManifest(): unknown;
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

export function normalizeStoredPanzhiJob(
  value: unknown
): StoredPanzhiJob | null {
  if (value === null || typeof value !== "object") return null;
  const input = value as Partial<StoredPanzhiJob>;
  if (
    typeof input.jobId !== "string" ||
    typeof input.bearerToken !== "string" ||
    (input.mode !== "quick" && input.mode !== "deep") ||
    typeof input.tabId !== "number" ||
    !Number.isInteger(input.tabId)
  ) return null;
  return {
    jobId: input.jobId,
    bearerToken: input.bearerToken,
    mode: input.mode,
    tabId: input.tabId
  };
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
    },
    reload: (tabId) => browser.tabs.reload(tabId)
  };
  const contentBridge: ContentCommandBridge = {
    contentScriptFile: resolvePackagedContentScript(
      browser.runtime.getManifest()
    ),
    sendMessage: (tabId, message) => browser.tabs.sendMessage(tabId, message),
    executeScript: (injection) => browser.scripting.executeScript(injection)
  };
  return new PanzhiBackgroundController({
    api: new PanzhiAutomationApi(),
    tabs,
    storage: {
      read: async () => {
        const value = (await browser.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
        return normalizeStoredPanzhiJob(value);
      },
      write: (active) => browser.storage.local.set({ [STORAGE_KEY]: active }),
      clear: () => browser.storage.local.remove(STORAGE_KEY)
    },
    runPage: async (tabId, mode, runId) =>
      parsePageRunnerResult(await sendContentCommandWithInjection(tabId, {
        type: "panzhi-run-v3",
        mode,
        runId
      }, contentBridge)),
    checkVerification: async (tabId) =>
      parseVerificationCheck(await sendContentCommandWithInjection(tabId, {
        type: "panzhi-check-verification-v2"
      }, contentBridge)),
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
    reportError: (error) => {
      console.error("[panzhi-auto-refresh] background cycle failed", error);
    },
    sleep: (milliseconds) => new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    }),
    now: () => new Date(),
    random: () => Math.random(),
    createRunId: () => crypto.randomUUID()
  });
}

export function handlePanzhiRuntimeMessage(
  controller: PanzhiBackgroundController,
  message: unknown,
  sender: ChromeRuntimeMessageSender
): Promise<unknown> | undefined {
  if (message === null || typeof message !== "object") return undefined;
  const input = message as {
    type?: unknown;
    stage?: unknown;
    milliseconds?: unknown;
  };
  if (
    input.type === "panzhi-stage" &&
    isRunnerStage(input.stage) &&
    sender.tab?.id !== undefined
  ) {
    return controller.handleContentStage(sender.tab.id, input.stage);
  }
  if (
    input.type === "panzhi-delay-v2" &&
    typeof input.milliseconds === "number" &&
    sender.tab?.id !== undefined
  ) {
    return controller.handleContentDelay(sender.tab.id, input.milliseconds);
  }
  return undefined;
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
  chrome.runtime.onMessage.addListener((message, sender) =>
    handlePanzhiRuntimeMessage(controller, message, sender));
  ensureAlarm();
}
