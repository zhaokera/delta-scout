import {
  PANZHI_CATALOG_URL,
  PANZHI_REQUIRED_OPERATOR_SKINS,
  type PageRunnerDependencies,
  type PageRunnerResult,
  type PanzhiFilterProof,
  type PanzhiPageMode,
  type PanzhiPageStage,
  type PanzhiSnapshotItem
} from "./contracts.js";
import {
  detectVerificationBlocker,
  extractVisibleCards,
  locateRequiredControls,
  selectedState,
  verifyRequiredFilters,
  type SelectorFailure
} from "./pageSelectors.js";

export type { PageRunnerDependencies } from "./contracts.js";

const QUICK_MAX_LOAD_ACTIONS = 6;
const QUICK_MAX_CARDS = 60;
const DEEP_MAX_LOAD_ACTIONS = 100;
const DEEP_MAX_CARDS = 500;
const HUMAN_DELAY_MIN_MS = 350;
const HUMAN_DELAY_MAX_MS = 850;

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

function setNativeInputValue(input: HTMLInputElement, value: string): void {
  const view = input.ownerDocument.defaultView;
  const prototype = view?.HTMLInputElement.prototype ?? HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  descriptor?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function observeUntil(
  root: Document,
  predicate: () => boolean,
  timeoutMs: number
): Promise<boolean> {
  if (predicate()) return Promise.resolve(true);
  const MutationObserverConstructor = root.defaultView?.MutationObserver;
  if (!MutationObserverConstructor) return Promise.resolve(false);

  return new Promise((resolve) => {
    let finished = false;
    const finish = (value: boolean): void => {
      if (finished) return;
      finished = true;
      observer.disconnect();
      root.defaultView?.clearTimeout(timeout);
      resolve(value);
    };
    const observer = new MutationObserverConstructor(() => {
      if (predicate()) finish(true);
    });
    observer.observe(root.documentElement, {
      attributes: true,
      childList: true,
      subtree: true
    });
    const timeout = root.defaultView?.setTimeout(
      () => finish(predicate()),
      timeoutMs
    );
  });
}

export class PanzhiPageRunner {
  constructor(private readonly dependencies: PageRunnerDependencies) {}

  async run(mode: PanzhiPageMode): Promise<PageRunnerResult> {
    await this.stage("applying_filters");
    const blockedBeforeFilters = await this.blockedResult();
    if (blockedBeforeFilters) return blockedBeforeFilters;

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

    await this.stage("collecting");
    return this.collect(mode);
  }

  private async stage(stage: PanzhiPageStage): Promise<void> {
    await this.dependencies.onStage(stage);
  }

  private async blockedResult(): Promise<PageRunnerResult | null> {
    const detection = detectVerificationBlocker(this.dependencies.document);
    if (detection.kind === "clear") return null;
    await this.stage("awaiting_user_verification");
    return {
      kind: "awaiting_user_verification",
      stage: "awaiting_user_verification",
      blocker: detection.blocker,
      resumeStage: "applying_filters"
    };
  }

  private async humanDelay(): Promise<void> {
    const random = Math.min(1, Math.max(0, this.dependencies.random()));
    await this.dependencies.sleep(
      HUMAN_DELAY_MIN_MS +
        Math.round((HUMAN_DELAY_MAX_MS - HUMAN_DELAY_MIN_MS) * random)
    );
  }

  private async setPrice(
    which: "minPrice" | "maxPrice",
    value: "1900" | "4000"
  ): Promise<PageRunnerResult | null> {
    const controls = locateRequiredControls(this.dependencies.document);
    if (controls.kind === "failure") {
      return selectorFailureResult("applying_filters", controls);
    }
    const input = controls[which];
    if (input.value === value) return null;
    setNativeInputValue(input, value);
    const changed = await observeUntil(
      this.dependencies.document,
      () => {
        const latest = locateRequiredControls(this.dependencies.document);
        return latest.kind === "found" && latest[which].value === value;
      },
      this.dependencies.mutationTimeoutMs
    );
    if (!changed) {
      return {
        kind: "failure",
        stage: "applying_filters",
        code: "operation_timeout",
        message: `Panzhi ${which} did not settle`
      };
    }
    await this.humanDelay();
    return this.blockedResult();
  }

  private async selectControl(
    resolve: () => HTMLElement | SelectorFailure
  ): Promise<PageRunnerResult | null> {
    const control = resolve();
    if ("kind" in control) {
      return selectorFailureResult("applying_filters", control);
    }
    const current = selectedState(control);
    if (current) return null;

    control.click();
    const changed = await observeUntil(
      this.dependencies.document,
      () => {
        const latest = resolve();
        return !("kind" in latest) && selectedState(latest) === true;
      },
      this.dependencies.mutationTimeoutMs
    );
    if (!changed) {
      return {
        kind: "failure",
        stage: "applying_filters",
        code: "operation_timeout",
        message: "Panzhi filter did not become selected"
      };
    }
    await this.humanDelay();
    return this.blockedResult();
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
      const controls = locateRequiredControls(this.dependencies.document);
      return controls.kind === "failure" ? controls : pick(controls);
    };
  }

  private async applyRequiredFilters(): Promise<PageRunnerResult | null> {
    const initial = locateRequiredControls(this.dependencies.document);
    if (initial.kind === "failure") {
      return selectorFailureResult("applying_filters", initial);
    }

    const operations: Array<() => Promise<PageRunnerResult | null>> = [
      () => this.setPrice("minPrice", "1900"),
      () => this.setPrice("maxPrice", "4000"),
      () => this.selectControl(this.control((controls) => controls.qq)),
      () => this.selectControl(this.control((controls) => controls.secondRealName)),
      () => this.selectControl(this.control((controls) => controls.requiredSkins[0])),
      () => this.selectControl(this.control((controls) => controls.requiredSkins[1])),
      () => this.selectControl(this.control((controls) => controls.allSemantics))
    ];
    for (const operation of operations) {
      const blocked = await this.blockedResult();
      if (blocked) return blocked;
      const result = await operation();
      if (result) return result;
    }

    const verified = verifyRequiredFilters(this.dependencies.document);
    return verified.kind === "failure"
      ? selectorFailureResult("applying_filters", verified)
      : null;
  }

  private collectCards(
    collected: Map<string, PanzhiSnapshotItem>,
    maxCards: number
  ): SelectorFailure | null {
    const verified = verifyRequiredFilters(this.dependencies.document);
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

  private async collect(mode: PanzhiPageMode): Promise<PageRunnerResult> {
    const maxActions = mode === "quick"
      ? QUICK_MAX_LOAD_ACTIONS
      : DEEP_MAX_LOAD_ACTIONS;
    const maxCards = mode === "quick" ? QUICK_MAX_CARDS : DEEP_MAX_CARDS;
    const collected = new Map<string, PanzhiSnapshotItem>();
    let loadActionCount = 1;
    let noGrowthCount = 0;

    const initialFailure = this.collectCards(collected, maxCards);
    if (initialFailure) {
      return selectorFailureResult("collecting", initialFailure, loadActionCount);
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
      try {
        await this.dependencies.loadMore();
      } catch (error) {
        const runnerError = error instanceof RunnerFailure
          ? error
          : new RunnerFailure(
              "operation_timeout",
              error instanceof Error ? error.message : "Panzhi load failed"
            );
        return {
          kind: "failure",
          stage: "collecting",
          code: runnerError.code,
          message: runnerError.message,
          loadActionCount
        };
      }
      loadActionCount += 1;
      await this.humanDelay();

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

    const blockedBeforeSnapshot = await this.blockedResult();
    if (blockedBeforeSnapshot) return blockedBeforeSnapshot;
    const finalVerification = verifyRequiredFilters(this.dependencies.document);
    if (finalVerification.kind === "failure") {
      return selectorFailureResult(
        "collecting",
        finalVerification,
        loadActionCount
      );
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

    await this.stage("submitting");
    return {
      kind: "snapshot",
      stage: "submitting",
      snapshot: {
        mode,
        filterProof,
        loadActionCount,
        observedUniqueCount: items.length,
        stopReason: mode === "quick" ? "quick_window" : "no_growth_twice",
        items
      }
    };
  }
}

async function waitForMutation(
  root: Document,
  timeoutMs: number
): Promise<void> {
  const MutationObserverConstructor = root.defaultView?.MutationObserver;
  if (!MutationObserverConstructor) return;
  await new Promise<void>((resolve) => {
    const observer = new MutationObserverConstructor(() => finish());
    const finish = (): void => {
      observer.disconnect();
      root.defaultView?.clearTimeout(timeout);
      resolve();
    };
    observer.observe(root.documentElement, {
      attributes: true,
      childList: true,
      subtree: true
    });
    const timeout = root.defaultView?.setTimeout(finish, timeoutMs);
  });
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
    loadMore: async () => {
      const view = root.defaultView;
      if (!view) {
        throw new RunnerFailure("structural_drift", "Panzhi page has no window");
      }
      const mutation = waitForMutation(root, 5_000);
      view.scrollTo({
        top: root.documentElement.scrollHeight,
        behavior: "smooth"
      });
      await mutation;
    },
    mutationTimeoutMs: 5_000,
    onStage: () => undefined
  };
}
