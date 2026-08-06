// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type ContentListener = (
  message: unknown
) => Promise<unknown> | undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as Record<string, unknown>)[
    "__panzhiAutoRefreshContentInstalled"
  ];
  delete (window as unknown as Record<string, unknown>)[
    "__panzhiAutoRefreshContentBridge"
  ];
  vi.resetModules();
});

describe("Panzhi content bridge installation", () => {
  it("replaces the current bridge even when a legacy listener remains", async () => {
    const staleListener: ContentListener = () => Promise.resolve("stale");
    const addListener = vi.fn();
    const removeListener = vi.fn();
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: vi.fn().mockResolvedValue(undefined),
        onMessage: { addListener, removeListener }
      }
    });
    const contentWindow = window as unknown as Record<string, unknown>;
    contentWindow.__panzhiAutoRefreshContentInstalled = true;
    contentWindow.__panzhiAutoRefreshContentBridge = {
      version: "stale",
      listener: staleListener
    };

    await import("../../extensions/panzhi-auto-refresh/src/content.js");

    expect(removeListener).toHaveBeenCalledWith(staleListener);
    expect(addListener).toHaveBeenCalledOnce();
    const listener = addListener.mock.calls[0]?.[0] as ContentListener;
    expect(listener({ type: "panzhi-check-verification" })).toBeUndefined();
    await expect(listener({
      type: "panzhi-check-verification-v2"
    })).resolves.toEqual({ kind: "clear" });
  });

  it("deduplicates one run ID and supersedes an older run ID", async () => {
    document.documentElement.innerHTML = readFileSync(resolve(
      process.cwd(),
      "tests/fixtures/panzhi-live-filter-page.html"
    ), "utf8");
    document.querySelector("[aria-label='商品列表']")?.remove();
    const firstDelay = deferred<void>();
    let delayCount = 0;
    let holdFirstRunDelays = true;
    const addListener = vi.fn();
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: vi.fn().mockImplementation((message: unknown) => {
          const input = message as { type?: unknown };
          if (input.type === "panzhi-delay-v2") {
            delayCount += 1;
            return holdFirstRunDelays
              ? firstDelay.promise.then(() => true)
              : Promise.resolve(true);
          }
          return Promise.resolve(true);
        }),
        onMessage: {
          addListener,
          removeListener: vi.fn()
        }
      }
    });

    await import("../../extensions/panzhi-auto-refresh/src/content.js");
    const listener = addListener.mock.calls[0]?.[0] as ContentListener;
    const first = listener({
      type: "panzhi-run-v3",
      mode: "quick",
      runId: "run-a"
    });
    const duplicate = listener({
      type: "panzhi-run-v3",
      mode: "quick",
      runId: "run-a"
    });
    expect(duplicate).toBe(first);
    await vi.waitFor(() => expect(delayCount).toBeGreaterThanOrEqual(1));

    holdFirstRunDelays = false;
    const replacement = listener({
      type: "panzhi-run-v3",
      mode: "quick",
      runId: "run-b"
    });
    expect(replacement).not.toBe(first);
    firstDelay.resolve();

    await expect(first).resolves.toEqual({
      kind: "superseded",
      stage: "applying_filters"
    });
    await expect(replacement).resolves.toEqual(expect.objectContaining({
      kind: "failure"
    }));
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
