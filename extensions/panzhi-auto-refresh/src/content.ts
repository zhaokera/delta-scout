import type {
  PageRunnerResult,
  PanzhiPageMode,
  PanzhiPageStage
} from "./contracts.js";
import {
  createDefaultPageRunnerDependencies,
  PanzhiPageRunner
} from "./pageRunner.js";
import { detectVerificationBlocker } from "./pageSelectors.js";

interface ContentChromeLike {
  runtime: {
    sendMessage(message: unknown): Promise<unknown>;
    onMessage: {
      addListener(
        listener: (message: unknown) => Promise<unknown> | undefined
      ): void;
    };
  };
}

declare const chrome: ContentChromeLike;

let running: Promise<PageRunnerResult> | null = null;

interface PanzhiContentGlobal extends Window {
  __panzhiAutoRefreshContentInstalled?: boolean;
}

function runVisiblePage(mode: PanzhiPageMode): Promise<PageRunnerResult> {
  if (running) return running;
  const defaults = createDefaultPageRunnerDependencies(document);
  const runner = new PanzhiPageRunner({
    ...defaults,
    onStage: async (stage: PanzhiPageStage) => {
      await chrome.runtime.sendMessage({ type: "panzhi-stage", stage });
    }
  });
  const execution = runner.run(mode).finally(() => {
    if (running === execution) running = null;
  });
  running = execution;
  return execution;
}

const contentGlobal = window as PanzhiContentGlobal;
if (!contentGlobal.__panzhiAutoRefreshContentInstalled) {
  contentGlobal.__panzhiAutoRefreshContentInstalled = true;
  chrome.runtime.onMessage.addListener((message) => {
    if (message === null || typeof message !== "object") return undefined;
    const input = message as { type?: unknown; mode?: unknown };
    if (
      input.type === "panzhi-run" &&
      (input.mode === "quick" || input.mode === "deep")
    ) {
      return runVisiblePage(input.mode);
    }
    if (input.type === "panzhi-check-verification") {
      return Promise.resolve(detectVerificationBlocker(document));
    }
    return undefined;
  });
}
