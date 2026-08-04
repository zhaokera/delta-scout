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
      removeListener(
        listener: (message: unknown) => Promise<unknown> | undefined
      ): void;
    };
  };
}

declare const chrome: ContentChromeLike;

let running: Promise<PageRunnerResult> | null = null;

type ContentMessageListener = (
  message: unknown
) => Promise<unknown> | undefined;

interface PanzhiContentBridgeState {
  version: "2";
  listener: ContentMessageListener;
}

interface PanzhiContentGlobal extends Window {
  __panzhiAutoRefreshContentBridge?: PanzhiContentBridgeState;
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
const previousBridge = contentGlobal.__panzhiAutoRefreshContentBridge;
if (previousBridge) {
  chrome.runtime.onMessage.removeListener(previousBridge.listener);
}
const listener: ContentMessageListener = (message) => {
  if (message === null || typeof message !== "object") return undefined;
  const input = message as { type?: unknown; mode?: unknown };
  if (
    input.type === "panzhi-run-v2" &&
    (input.mode === "quick" || input.mode === "deep")
  ) {
    return runVisiblePage(input.mode);
  }
  if (input.type === "panzhi-check-verification-v2") {
    return Promise.resolve(detectVerificationBlocker(document));
  }
  return undefined;
};
chrome.runtime.onMessage.addListener(listener);
contentGlobal.__panzhiAutoRefreshContentBridge = {
  version: "2",
  listener
};
