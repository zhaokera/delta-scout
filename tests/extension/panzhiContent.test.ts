// @vitest-environment jsdom

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
});
