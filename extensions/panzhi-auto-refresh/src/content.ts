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

type ContentMessageListener = (
  message: unknown
) => Promise<unknown> | undefined;

interface PanzhiContentBridgeState {
  version: "3";
  listener: ContentMessageListener;
  activeRunId: string | null;
  activeExecution: {
    runId: string;
    promise: Promise<PageRunnerResult>;
  } | null;
}

interface PanzhiContentGlobal extends Window {
  __panzhiAutoRefreshContentBridge?: PanzhiContentBridgeState;
}

async function delayThroughBackground(milliseconds: number): Promise<void> {
  const accepted = await chrome.runtime.sendMessage({
    type: "panzhi-delay-v2",
    milliseconds
  });
  if (accepted !== true) {
    throw new Error("Panzhi background delay is unavailable");
  }
}

function runVisiblePage(
  mode: PanzhiPageMode,
  runId: string,
  bridge: PanzhiContentBridgeState
): Promise<PageRunnerResult> {
  if (bridge.activeExecution?.runId === runId) {
    return bridge.activeExecution.promise;
  }
  bridge.activeRunId = runId;
  const defaults = createDefaultPageRunnerDependencies(document);
  const runner = new PanzhiPageRunner({
    ...defaults,
    sleep: delayThroughBackground,
    settlementDelay: delayThroughBackground,
    onStage: async (stage: PanzhiPageStage) => {
      await chrome.runtime.sendMessage({ type: "panzhi-stage", stage });
    },
    isCurrentRun: () =>
      contentGlobal.__panzhiAutoRefreshContentBridge?.activeRunId === runId
  });
  const execution = runner.run(mode).finally(() => {
    if (bridge.activeExecution?.promise === execution) {
      bridge.activeExecution = null;
    }
  });
  bridge.activeExecution = { runId, promise: execution };
  return execution;
}

const contentGlobal = window as PanzhiContentGlobal;
const previousBridge = contentGlobal.__panzhiAutoRefreshContentBridge;
if (previousBridge) {
  chrome.runtime.onMessage.removeListener(previousBridge.listener);
}
const bridge: PanzhiContentBridgeState = {
  version: "3",
  listener: () => undefined,
  activeRunId: previousBridge?.activeRunId ?? null,
  activeExecution: previousBridge?.activeExecution ?? null
};
const listener: ContentMessageListener = (message) => {
  if (message === null || typeof message !== "object") return undefined;
  const input = message as {
    type?: unknown;
    mode?: unknown;
    runId?: unknown;
  };
  if (
    input.type === "panzhi-run-v3" &&
    (input.mode === "quick" || input.mode === "deep") &&
    typeof input.runId === "string" &&
    input.runId.length > 0
  ) {
    return runVisiblePage(input.mode, input.runId, bridge);
  }
  if (input.type === "panzhi-check-verification-v2") {
    return Promise.resolve(detectVerificationBlocker(document));
  }
  return undefined;
};
bridge.listener = listener;
chrome.runtime.onMessage.addListener(listener);
contentGlobal.__panzhiAutoRefreshContentBridge = bridge;
