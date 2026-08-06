import {
  PANZHI_CATALOG_URL,
  PANZHI_REQUIRED_OPERATOR_SKINS,
  type PageRunnerDependencies,
  type PageRunnerResult,
  type PanzhiFilterProof,
  type PanzhiPageMode,
  type PanzhiPageSnapshot,
  type PanzhiPageStage,
  type PanzhiSnapshotItem,
  type VerificationBlocker
} from "./contracts.js";
import {
  detectVerificationBlocker,
  extractVisibleCards,
  locateMissingFilterSearchOpener,
  locateOperatorSearchTypeChooser,
  locateRequiredControls,
  readResultState,
  selectedState,
  visibleFilterSearchInputs,
  verifyRequiredFilters,
  type ResultState,
  type SelectorFailure
} from "./pageSelectors.js";

export type { PageRunnerDependencies } from "./contracts.js";

const QUICK_MAX_LOAD_ACTIONS = 6;
const QUICK_MAX_CARDS = 60;
const DEEP_MAX_LOAD_ACTIONS = 100;
const DEEP_MAX_CARDS = 500;
const HUMAN_DELAY_MIN_MS = 350;
const HUMAN_DELAY_MAX_MS = 850;
const PAGE_READY_POLL_MS = 250;
const PAGE_READY_MAX_ATTEMPTS = 60;
const FILTER_SEARCH_MAX_ATTEMPTS = 12;

class RunnerFailure extends Error {
  constructor(
    readonly code: "structural_drift" | "operation_timeout",
    message: string
  ) {
    super(message);
  }
}

function selectorFailureResult(
  stage: "applying_filters" | "collecting",
  error: SelectorFailure,
  loadActionCount?: number
): PageRunnerResult {
  return {
    kind: "failure",
    stage,
    code: error.code,
    message: error.message,
    ...(loadActionCount === undefined ? {} : { loadActionCount })
  };
}

function assignNativeInputValue(input: HTMLInputElement, value: string): void {
  const view = input.ownerDocument.defaultView;
  const prototype = view?.HTMLInputElement.prototype ?? HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  descriptor?.set?.call(input, value);
}

function dispatchNativeInputEvents(input: HTMLInputElement): void {
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

type SettlementOutcome =
  | { kind: "settled" }
  | { kind: "superseded" }
  | { kind: "blocked"; blocker: VerificationBlocker }
  | { kind: "timeout" }
  | { kind: "failure"; failure: SelectorFailure }
  | { kind: "action-error"; error: unknown };

type ReadyState =
  | { kind: "ready-state"; ready: boolean }
  | SelectorFailure;

function observeActionUntilResultsSettle(
  root: Document,
  action: () => void | Promise<void>,
  readReady: () => ReadyState,
  timeoutMs: number,
  stabilityMs: number,
  settlementDelay: (milliseconds: number) => Promise<void>,
  allowExistingEndMarker = false,
  allowStableInitialState = false,
  isCurrentRun: () => boolean = () => true,
  preferredSearchInput: HTMLInputElement | null = null,
  allowQuietNoChangeAtTimeout = false
): Promise<SettlementOutcome> {
  if (!isCurrentRun()) return Promise.resolve({ kind: "superseded" });
  const initial = readResultState(root, preferredSearchInput);
  if (initial.kind === "failure") {
    return Promise.resolve({ kind: "failure", failure: initial });
  }
  const initialBlocker = detectVerificationBlocker(root);
  if (initialBlocker.kind === "blocked") return Promise.resolve(initialBlocker);
  const MutationObserverConstructor = root.defaultView?.MutationObserver;
  if (!MutationObserverConstructor) return Promise.resolve({ kind: "timeout" });

  return new Promise((resolve) => {
    let finished = false;
    let timeoutGeneration = 0;
    let stabilityGeneration = 0;
    let stabilityPending = false;
    let observer: MutationObserver | null = null;
    let actionCompleted = false;
    let observedResultStateChange = false;
    let current: ResultState = initial;
    let sawLoading = initial.loadingVisible;
    let completionWindowStarted = false;
    let hasCompletionEvidence =
      (allowExistingEndMarker && initial.endMarkerVisible) ||
      allowStableInitialState;
    const finish = (value: SettlementOutcome): void => {
      if (finished) return;
      finished = true;
      observer?.disconnect();
      timeoutGeneration += 1;
      stabilityGeneration += 1;
      stabilityPending = false;
      resolve(value);
    };

    const scheduleTimeout = (milliseconds: number): void => {
      const generation = ++timeoutGeneration;
      void settlementDelay(milliseconds).then(
        () => {
          if (finished || generation !== timeoutGeneration) return;
          if (!isCurrentRun()) {
            finish({ kind: "superseded" });
            return;
          }
          const blocker = detectVerificationBlocker(root);
          if (blocker.kind === "blocked") {
            finish(blocker);
            return;
          }
          if (
            allowQuietNoChangeAtTimeout &&
            actionCompleted &&
            !observedResultStateChange
          ) {
            const ready = readReady();
            if (ready.kind === "failure") {
              finish({ kind: "failure", failure: ready });
              return;
            }
            const finalState = readResultState(root, preferredSearchInput);
            if (finalState.kind === "failure") {
              finish({ kind: "failure", failure: finalState });
              return;
            }
            if (
              ready.ready &&
              !finalState.loadingVisible &&
              finalState.signature === initial.signature &&
              finalState.endMarkerVisible === initial.endMarkerVisible
            ) {
              finish({ kind: "settled" });
              return;
            }
          }
          finish({ kind: "timeout" });
        },
        (error: unknown) => {
          if (!finished && generation === timeoutGeneration) {
            finish({ kind: "action-error", error });
          }
        }
      );
    };

    const evaluate = (): void => {
      if (!isCurrentRun()) {
        finish({ kind: "superseded" });
        return;
      }
      const blocker = detectVerificationBlocker(root);
      if (blocker.kind === "blocked") {
        finish(blocker);
        return;
      }
      const ready = readReady();
      if (ready.kind === "failure") {
        finish({ kind: "failure", failure: ready });
        return;
      }
      const next = readResultState(root, preferredSearchInput);
      if (next.kind === "failure") {
        finish({ kind: "failure", failure: next });
        return;
      }
      const changed =
        next.signature !== current.signature ||
        next.loadingVisible !== current.loadingVisible ||
        next.endMarkerVisible !== current.endMarkerVisible;
      if (changed) observedResultStateChange = true;
      if (next.loadingVisible) sawLoading = true;
      if (
        next.signature !== initial.signature ||
        (!initial.endMarkerVisible && next.endMarkerVisible) ||
        (sawLoading && !next.loadingVisible)
      ) {
        hasCompletionEvidence = true;
      }
      current = next;

      if (changed && stabilityPending) {
        stabilityGeneration += 1;
        stabilityPending = false;
      }
      if (
        hasCompletionEvidence &&
        ready.ready &&
        !next.loadingVisible &&
        !stabilityPending
      ) {
        if (!completionWindowStarted) {
          completionWindowStarted = true;
          scheduleTimeout(timeoutMs + stabilityMs);
        }
        stabilityPending = true;
        const generation = ++stabilityGeneration;
        void settlementDelay(stabilityMs).then(
          () => {
            if (!finished && generation === stabilityGeneration) {
              finish(isCurrentRun()
                ? { kind: "settled" }
                : { kind: "superseded" });
            }
          },
          (error: unknown) => {
            if (!finished && generation === stabilityGeneration) {
              finish({ kind: "action-error", error });
            }
          }
        );
      }
    };

    observer = new MutationObserverConstructor(evaluate);
    observer.observe(root.documentElement, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true
    });
    scheduleTimeout(timeoutMs);
    Promise.resolve()
      .then(() => {
        if (!isCurrentRun()) {
          finish({ kind: "superseded" });
          return;
        }
        return action();
      })
      .then(() => {
        actionCompleted = true;
        evaluate();
      })
      .catch((error: unknown) => finish({ kind: "action-error", error }));
  });
}

export class PanzhiPageRunner {
  private currentStage: "applying_filters" | "collecting" | "submitting" =
    "applying_filters";
  private operatorSearchInput: HTMLInputElement | null = null;

  constructor(private readonly dependencies: PageRunnerDependencies) {}

  async run(mode: PanzhiPageMode): Promise<PageRunnerResult> {
    const openingStage = await this.stage("applying_filters");
    if (openingStage) return openingStage;
    const blockedBeforeFilters = await this.blockedResult();
    if (blockedBeforeFilters) return blockedBeforeFilters;
    const prepared = await this.prepareOperatorSkinField();
    if (prepared) return prepared;
    const ready = await this.waitForPageContract();
    if (ready) return ready;

    const applied = await this.applyRequiredFilters();
    if (applied) return applied;
    const blockedAfterFilters = await this.blockedResult();
    if (blockedAfterFilters) return blockedAfterFilters;

    const currentUrl = this.dependencies.currentUrl();
    if (currentUrl !== PANZHI_CATALOG_URL) {
      return {
        kind: "failure",
        stage: "applying_filters",
        code: "structural_drift",
        message: "Panzhi catalog URL is not the approved canonical URL"
      };
    }

    const collectingStage = await this.stage("collecting");
    if (collectingStage) return collectingStage;
    return this.collect(mode);
  }

  private supersededResult(): Extract<
    PageRunnerResult,
    { kind: "superseded" }
  > {
    return { kind: "superseded", stage: this.currentStage };
  }

  private cancellationResult(): Extract<
    PageRunnerResult,
    { kind: "superseded" }
  > | null {
    return this.dependencies.isCurrentRun() ? null : this.supersededResult();
  }

  private async stage(stage: PanzhiPageStage): Promise<PageRunnerResult | null> {
    const superseded = this.cancellationResult();
    if (superseded) return superseded;
    if (stage !== "awaiting_user_verification") {
      this.currentStage = stage;
    }
    await this.dependencies.onStage(stage);
    return this.cancellationResult();
  }

  private async blockedResult(): Promise<PageRunnerResult | null> {
    const superseded = this.cancellationResult();
    if (superseded) return superseded;
    const detection = detectVerificationBlocker(this.dependencies.document);
    if (detection.kind === "clear") return null;
    return this.verificationResult(detection.blocker);
  }

  private async verificationResult(
    blocker: VerificationBlocker
  ): Promise<PageRunnerResult> {
    const verificationStage = await this.stage("awaiting_user_verification");
    if (verificationStage) return verificationStage;
    return {
      kind: "awaiting_user_verification",
      stage: "awaiting_user_verification",
      blocker,
      resumeStage: "applying_filters"
    };
  }

  private async humanDelay(): Promise<PageRunnerResult | null> {
    const superseded = this.cancellationResult();
    if (superseded) return superseded;
    const random = Math.min(1, Math.max(0, this.dependencies.random()));
    await this.dependencies.sleep(
      HUMAN_DELAY_MIN_MS +
        Math.round((HUMAN_DELAY_MAX_MS - HUMAN_DELAY_MIN_MS) * random)
    );
    return this.cancellationResult();
  }

  private async waitForPageContract(): Promise<PageRunnerResult | null> {
    let lastFailure: SelectorFailure | null = null;
    for (let attempt = 0; attempt < PAGE_READY_MAX_ATTEMPTS; attempt += 1) {
      const blocked = await this.blockedResult();
      if (blocked) return blocked;
      const controls = this.locateControls();
      const results = readResultState(
        this.dependencies.document,
        this.operatorSearchInput
      );
      if (controls.kind === "found" && results.kind === "result-state") {
        return null;
      }
      const failures = [controls, results].filter(
        (value): value is SelectorFailure => value.kind === "failure"
      );
      const structural = failures.find(
        ({ code }) => code === "structural_drift"
      );
      if (structural) {
        return selectorFailureResult("applying_filters", structural);
      }
      lastFailure = failures[0] ?? lastFailure;
      if (attempt < PAGE_READY_MAX_ATTEMPTS - 1) {
        await this.dependencies.sleep(PAGE_READY_POLL_MS);
      }
    }
    return selectorFailureResult(
      "applying_filters",
      lastFailure ?? {
        kind: "failure",
        code: "missing_controls",
        message: "Panzhi page contract did not become ready"
      }
    );
  }

  private async prepareOperatorSkinField(): Promise<PageRunnerResult | null> {
    const initial = this.locateControls();
    if (initial.kind === "found") return null;

    let initialSearches = visibleFilterSearchInputs(
      this.dependencies.document
    );
    if (initialSearches.length === 0) {
      const opener = locateMissingFilterSearchOpener(
        this.dependencies.document
      );
      if ("kind" in opener) {
        return opener.code === "structural_drift"
          ? selectorFailureResult("applying_filters", opener)
          : null;
      }
      opener.click();
      for (
        let attempt = 0;
        attempt < FILTER_SEARCH_MAX_ATTEMPTS;
        attempt += 1
      ) {
        const blocked = await this.blockedResult();
        if (blocked) return blocked;
        initialSearches = visibleFilterSearchInputs(
          this.dependencies.document
        );
        if (initialSearches.length > 0) break;
        if (attempt < FILTER_SEARCH_MAX_ATTEMPTS - 1) {
          await this.dependencies.sleep(PAGE_READY_POLL_MS);
        }
      }
      if (initialSearches.length === 0) {
        return selectorFailureResult("applying_filters", initial);
      }
    }
    let lastFailure: SelectorFailure = initial;

    for (
      let candidateIndex = 0;
      candidateIndex < initialSearches.length;
      candidateIndex += 1
    ) {
      const superseded = this.cancellationResult();
      if (superseded) return superseded;
      const searches = visibleFilterSearchInputs(this.dependencies.document);
      if (candidateIndex >= searches.length) break;

      for (let index = 0; index < searches.length; index += 1) {
        if (index === candidateIndex) continue;
        assignNativeInputValue(searches[index], "");
        dispatchNativeInputEvents(searches[index]);
      }
      const target = searches[candidateIndex];
      assignNativeInputValue(target, "特战干员外观");
      dispatchNativeInputEvents(target);

      for (
        let attempt = 0;
        attempt < FILTER_SEARCH_MAX_ATTEMPTS;
        attempt += 1
      ) {
        const blocked = await this.blockedResult();
        if (blocked) return blocked;
        const located = locateRequiredControls(
          this.dependencies.document,
          target
        );
        if (located.kind === "found") {
          this.operatorSearchInput = target;
          const delayed = await this.humanDelay();
          if (delayed) return delayed;
          return this.blockedResult();
        }
        lastFailure = located;
        if (attempt < FILTER_SEARCH_MAX_ATTEMPTS - 1) {
          await this.dependencies.sleep(PAGE_READY_POLL_MS);
        }
      }
    }

    return selectorFailureResult("applying_filters", lastFailure);
  }

  private async setPriceRange(controls: {
    minPrice: HTMLInputElement;
    maxPrice: HTMLInputElement;
  }): Promise<PageRunnerResult | null> {
    if (
      controls.minPrice.value === "1900" &&
      controls.maxPrice.value === "4000"
    ) {
      return null;
    }
    const outcome = await observeActionUntilResultsSettle(
      this.dependencies.document,
      () => {
        assignNativeInputValue(controls.minPrice, "1900");
        assignNativeInputValue(controls.maxPrice, "4000");
        dispatchNativeInputEvents(controls.minPrice);
        dispatchNativeInputEvents(controls.maxPrice);
      },
      () => {
        if (!controls.minPrice.isConnected || !controls.maxPrice.isConnected) {
          return {
            kind: "failure" as const,
            code: "missing_controls" as const,
            message: "Panzhi price controls detached during selection"
          };
        }
        return {
          kind: "ready-state",
          ready:
            controls.minPrice.value === "1900" &&
            controls.maxPrice.value === "4000"
        };
      },
      this.dependencies.mutationTimeoutMs,
      this.dependencies.resultStabilityMs,
      this.dependencies.settlementDelay,
      false,
      true,
      this.dependencies.isCurrentRun,
      this.operatorSearchInput
    );
    if (outcome.kind === "superseded") return this.supersededResult();
    if (outcome.kind === "blocked") {
      return this.verificationResult(outcome.blocker);
    }
    if (outcome.kind === "failure") {
      return selectorFailureResult("applying_filters", outcome.failure);
    }
    if (outcome.kind === "action-error") {
      return {
        kind: "failure",
        stage: "applying_filters",
        code: "operation_timeout",
        message: outcome.error instanceof Error
          ? outcome.error.message
          : "Panzhi price range action failed"
      };
    }
    if (outcome.kind === "timeout") {
      return {
        kind: "failure",
        stage: "applying_filters",
        code: "operation_timeout",
        message: "Panzhi price range did not settle"
      };
    }
    const delayed = await this.humanDelay();
    if (delayed) return delayed;
    return this.blockedResult();
  }

  private async selectControl(
    resolve: () => HTMLElement | SelectorFailure,
    description: string
  ): Promise<PageRunnerResult | null> {
    const control = resolve();
    if ("kind" in control) {
      return selectorFailureResult("applying_filters", control);
    }
    const current = selectedState(control);
    if (current.kind === "failure") {
      return selectorFailureResult("applying_filters", current);
    }
    if (current.kind === "selected-state" && current.selected) return null;
    const resultBeforeSelection = readResultState(
      this.dependencies.document,
      this.operatorSearchInput
    );
    if (resultBeforeSelection.kind === "failure") {
      return selectorFailureResult("applying_filters", resultBeforeSelection);
    }

    const outcome = await observeActionUntilResultsSettle(
      this.dependencies.document,
      () => control.click(),
      () => {
        const latest = resolve();
        if ("kind" in latest) return latest;
        const state = selectedState(latest);
        if (state.kind === "failure") return state;
        return {
          kind: "ready-state",
          ready: state.kind === "selected-state" && state.selected
        };
      },
      this.dependencies.mutationTimeoutMs,
      this.dependencies.resultStabilityMs,
      this.dependencies.settlementDelay,
      false,
      resultBeforeSelection.emptyResultVisible,
      this.dependencies.isCurrentRun,
      this.operatorSearchInput
    );
    if (outcome.kind === "superseded") return this.supersededResult();
    if (outcome.kind === "blocked") {
      return this.verificationResult(outcome.blocker);
    }
    if (outcome.kind === "failure") {
      return selectorFailureResult("applying_filters", outcome.failure);
    }
    if (outcome.kind === "action-error") {
      return {
        kind: "failure",
        stage: "applying_filters",
        code: "operation_timeout",
        message: outcome.error instanceof Error
          ? outcome.error.message
          : `Panzhi filter action failed: ${description}`
      };
    }
    if (outcome.kind === "timeout") {
      return {
        kind: "failure",
        stage: "applying_filters",
        code: "operation_timeout",
        message: `Panzhi filter did not become selected: ${description}`
      };
    }
    const delayed = await this.humanDelay();
    if (delayed) return delayed;
    return this.blockedResult();
  }

  private async selectAllSemantics(): Promise<PageRunnerResult | null> {
    const controls = this.locateControls();
    if (controls.kind === "failure") {
      return selectorFailureResult("applying_filters", controls);
    }
    const current = selectedState(controls.allSemantics);
    if (current.kind === "failure") {
      return selectorFailureResult("applying_filters", current);
    }
    if (current.kind === "selected-state" && current.selected) return null;
    if (!controls.allSemantics.matches(".filter-item-checkbox")) {
      return this.selectControl(
        this.control((latest) => latest.allSemantics),
        "operator skin conjunction"
      );
    }

    const chooser = locateOperatorSearchTypeChooser(
      this.dependencies.document,
      this.operatorSearchInput
    );
    if ("kind" in chooser) {
      return selectorFailureResult("applying_filters", chooser);
    }
    chooser.click();
    for (
      let attempt = 0;
      attempt < FILTER_SEARCH_MAX_ATTEMPTS;
      attempt += 1
    ) {
      const blocked = await this.blockedResult();
      if (blocked) return blocked;
      const latest = this.locateControls();
      if (
        latest.kind === "found" &&
        latest.allSemantics.matches(".drop-item")
      ) {
        return this.selectControl(
          this.control((next) => next.allSemantics),
          "operator skin conjunction: 全部都要有"
        );
      }
      if (
        latest.kind === "failure" &&
        latest.code === "structural_drift"
      ) {
        return selectorFailureResult("applying_filters", latest);
      }
      if (attempt < FILTER_SEARCH_MAX_ATTEMPTS - 1) {
        await this.dependencies.sleep(PAGE_READY_POLL_MS);
      }
    }
    return selectorFailureResult("applying_filters", {
      kind: "failure",
      code: "missing_controls",
      message: "Missing visible control: 全部都要有"
    });
  }

  private control(
    pick: (
      controls: Extract<
        ReturnType<typeof locateRequiredControls>,
        { kind: "found" }
      >
    ) => HTMLElement
  ): () => HTMLElement | SelectorFailure {
    return () => {
      const controls = this.locateControls();
      return controls.kind === "failure" ? controls : pick(controls);
    };
  }

  private locateControls(): ReturnType<typeof locateRequiredControls> {
    return locateRequiredControls(
      this.dependencies.document,
      this.operatorSearchInput
    );
  }

  private knownControl(
    control: HTMLElement,
    description: string
  ): () => HTMLElement | SelectorFailure {
    return () => control.isConnected
      ? control
      : {
          kind: "failure",
          code: "missing_controls",
          message: `${description} detached during selection`
        };
  }

  private async applyRequiredFilters(): Promise<PageRunnerResult | null> {
    const initial = this.locateControls();
    if (initial.kind === "failure") {
      return selectorFailureResult("applying_filters", initial);
    }

    const operations: Array<() => Promise<PageRunnerResult | null>> = [
      () => this.selectControl(
        this.control((controls) => controls.requiredSkins[0]),
        PANZHI_REQUIRED_OPERATOR_SKINS[0].label
      ),
      () => this.selectControl(
        this.control((controls) => controls.requiredSkins[1]),
        PANZHI_REQUIRED_OPERATOR_SKINS[1].label
      ),
      () => this.selectAllSemantics(),
      () => this.setPriceRange(initial),
      () => this.selectControl(
        this.knownControl(initial.qq, "QQ control"),
        "QQ"
      ),
      () => this.selectControl(
        this.knownControl(initial.secondRealName, "Real-name control"),
        "可二次实名"
      )
    ];
    for (const operation of operations) {
      const blocked = await this.blockedResult();
      if (blocked) return blocked;
      const result = await operation();
      if (result) return result;
    }

    const verified = verifyRequiredFilters(
      this.dependencies.document,
      this.operatorSearchInput
    );
    if (verified.kind === "failure") {
      return selectorFailureResult("applying_filters", verified);
    }
    const stable = await observeActionUntilResultsSettle(
      this.dependencies.document,
      () => undefined,
      () => ({ kind: "ready-state", ready: true }),
      this.dependencies.mutationTimeoutMs,
      this.dependencies.resultStabilityMs,
      this.dependencies.settlementDelay,
      false,
      true,
      this.dependencies.isCurrentRun,
      this.operatorSearchInput
    );
    if (stable.kind === "superseded") return this.supersededResult();
    if (stable.kind === "blocked") {
      return this.verificationResult(stable.blocker);
    }
    if (stable.kind === "failure") {
      return selectorFailureResult("applying_filters", stable.failure);
    }
    if (stable.kind !== "settled") {
      return {
        kind: "failure",
        stage: "applying_filters",
        code: "operation_timeout",
        message: "Panzhi filtered results did not become quietly stable"
      };
    }
    return null;
  }

  private collectCards(
    collected: Map<string, PanzhiSnapshotItem>,
    maxCards: number
  ): SelectorFailure | null {
    const verified = verifyRequiredFilters(
      this.dependencies.document,
      this.operatorSearchInput
    );
    if (verified.kind === "failure") return verified;
    const extracted = extractVisibleCards(this.dependencies.document);
    if (extracted.kind === "failure") return extracted;
    for (const item of extracted.items) {
      if (!collected.has(item.sourceListingId) && collected.size >= maxCards) {
        break;
      }
      collected.set(item.sourceListingId, item);
    }
    return null;
  }

  private async submitSnapshot(
    mode: PanzhiPageMode,
    collected: Map<string, PanzhiSnapshotItem>,
    maxCards: number,
    loadActionCount: number,
    stopReason: PanzhiPageSnapshot["stopReason"]
  ): Promise<PageRunnerResult> {
    const blockedBeforeSnapshot = await this.blockedResult();
    if (blockedBeforeSnapshot) return blockedBeforeSnapshot;
    const finalVerification = verifyRequiredFilters(
      this.dependencies.document,
      this.operatorSearchInput
    );
    if (finalVerification.kind === "failure") {
      return selectorFailureResult(
        "collecting",
        finalVerification,
        loadActionCount
      );
    }
    if (this.dependencies.currentUrl() !== PANZHI_CATALOG_URL) {
      return {
        kind: "failure",
        stage: "collecting",
        code: "structural_drift",
        message: "Panzhi catalog URL drifted during collection",
        loadActionCount
      };
    }
    if (stopReason === "empty_result") {
      const emptyState = readResultState(
        this.dependencies.document,
        this.operatorSearchInput
      );
      if (emptyState.kind === "failure") {
        return selectorFailureResult("collecting", emptyState, loadActionCount);
      }
      if (!emptyState.emptyResultVisible) {
        return selectorFailureResult("collecting", {
          kind: "failure",
          code: "structural_drift",
          message: "Verified Panzhi zero-card result changed before submission"
        }, loadActionCount);
      }
    }

    const observedAt = this.dependencies.now().toISOString();
    const filterProof: PanzhiFilterProof = {
      currentUrl: PANZHI_CATALOG_URL,
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
        selectedOptions: PANZHI_REQUIRED_OPERATOR_SKINS.map((skin) => ({
          ...skin
        }))
      },
      observedAt
    };
    const items = [...collected.values()].slice(0, maxCards);

    const submittingStage = await this.stage("submitting");
    if (submittingStage) return submittingStage;
    const blockedAfterSubmittingStage = await this.blockedResult();
    if (blockedAfterSubmittingStage) return blockedAfterSubmittingStage;
    if (stopReason === "empty_result") {
      const finalEmptyState = readResultState(
        this.dependencies.document,
        this.operatorSearchInput
      );
      if (finalEmptyState.kind === "failure") {
        return selectorFailureResult(
          "collecting",
          finalEmptyState,
          loadActionCount
        );
      }
      if (!finalEmptyState.emptyResultVisible) {
        return selectorFailureResult("collecting", {
          kind: "failure",
          code: "structural_drift",
          message: "Verified Panzhi zero-card result changed before submission"
        }, loadActionCount);
      }
    }
    return {
      kind: "snapshot",
      stage: "submitting",
      snapshot: {
        mode,
        filterProof,
        loadActionCount,
        observedUniqueCount: items.length,
        stopReason,
        items
      }
    };
  }

  private async collect(mode: PanzhiPageMode): Promise<PageRunnerResult> {
    const maxActions = mode === "quick"
      ? QUICK_MAX_LOAD_ACTIONS
      : DEEP_MAX_LOAD_ACTIONS;
    const maxCards = mode === "quick" ? QUICK_MAX_CARDS : DEEP_MAX_CARDS;
    const collected = new Map<string, PanzhiSnapshotItem>();
    let loadActionCount = 1;
    let noGrowthCount = 0;

    const blockedBeforeInitialCollection = await this.blockedResult();
    if (blockedBeforeInitialCollection) return blockedBeforeInitialCollection;
    const initialFailure = this.collectCards(collected, maxCards);
    if (initialFailure) {
      return selectorFailureResult("collecting", initialFailure, loadActionCount);
    }
    const initialState = readResultState(
      this.dependencies.document,
      this.operatorSearchInput
    );
    if (initialState.kind === "failure") {
      return selectorFailureResult("collecting", initialState, loadActionCount);
    }
    if (initialState.emptyResultVisible) {
      return this.submitSnapshot(
        mode,
        collected,
        maxCards,
        loadActionCount,
        "empty_result"
      );
    }

    while (
      loadActionCount < maxActions &&
      (loadActionCount < 2 ||
        (collected.size < maxCards &&
          (mode === "quick" || noGrowthCount < 2)))
    ) {
      const blockedBeforeLoad = await this.blockedResult();
      if (blockedBeforeLoad) return blockedBeforeLoad;
      const previousSize = collected.size;
      const attemptedActionCount = loadActionCount + 1;
      const outcome = await observeActionUntilResultsSettle(
        this.dependencies.document,
        this.dependencies.loadMore,
        () => ({ kind: "ready-state", ready: true }),
        this.dependencies.mutationTimeoutMs,
        this.dependencies.resultStabilityMs,
        this.dependencies.settlementDelay,
        true,
        false,
        this.dependencies.isCurrentRun,
        this.operatorSearchInput,
        true
      );
      if (outcome.kind === "superseded") {
        return this.supersededResult();
      }
      if (outcome.kind === "blocked") {
        return this.verificationResult(outcome.blocker);
      }
      if (outcome.kind === "failure") {
        return selectorFailureResult(
          "collecting",
          outcome.failure,
          attemptedActionCount
        );
      }
      if (outcome.kind === "timeout" || outcome.kind === "action-error") {
        const error = outcome.kind === "action-error" ? outcome.error : null;
        return {
          kind: "failure",
          stage: "collecting",
          code: "operation_timeout",
          message: error instanceof Error
            ? error.message
            : `Panzhi results did not produce a complete load observation at action ${attemptedActionCount}`,
          loadActionCount: attemptedActionCount
        };
      }
      loadActionCount = attemptedActionCount;
      const delayed = await this.humanDelay();
      if (delayed) return delayed;

      const blockedAfterLoad = await this.blockedResult();
      if (blockedAfterLoad) return blockedAfterLoad;
      const iterationFailure = this.collectCards(collected, maxCards);
      if (iterationFailure) {
        return selectorFailureResult(
          "collecting",
          iterationFailure,
          loadActionCount
        );
      }
      noGrowthCount = collected.size === previousSize ? noGrowthCount + 1 : 0;
    }

    if (mode === "deep" && noGrowthCount < 2) {
      return {
        kind: "failure",
        stage: "collecting",
        code: "collection_limit",
        message: "Deep Panzhi collection reached its safety cap before a natural end",
        loadActionCount
      };
    }
    return this.submitSnapshot(
      mode,
      collected,
      maxCards,
      loadActionCount,
      mode === "quick" ? "quick_window" : "no_growth_twice"
    );
  }
}

export function createDefaultPageRunnerDependencies(
  root: Document = document
): PageRunnerDependencies {
  return {
    document: root,
    currentUrl: () => root.defaultView?.location.href ?? "",
    now: () => new Date(),
    random: () => Math.random(),
    sleep: (milliseconds) => new Promise((resolve) => {
      root.defaultView?.setTimeout(resolve, milliseconds);
    }),
    settlementDelay: (milliseconds) => new Promise((resolve) => {
      root.defaultView?.setTimeout(resolve, milliseconds);
    }),
    loadMore: async () => {
      const view = root.defaultView;
      if (!view) {
        throw new RunnerFailure("structural_drift", "Panzhi page has no window");
      }
      view.scrollTo({
        top: root.documentElement.scrollHeight,
        behavior: "smooth"
      });
    },
    mutationTimeoutMs: 5_000,
    resultStabilityMs: 350,
    onStage: () => undefined,
    isCurrentRun: () => true
  };
}
