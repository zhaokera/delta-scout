// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicPageFetcher } from "../../src/server/collector/fetcher.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("PublicPageFetcher", () => {
  it("sends an approved JSON POST request without cookies or auth", async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe('{"pageIndex":1}');
      expect(headers.get("accept")).toBe(
        "application/json, text/plain, */*"
      );
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("origin")).toBe("https://www.pxb7.com");
      expect(headers.get("referer")).toBe("https://www.pxb7.com/");
      expect(headers.has("cookie")).toBe(false);
      expect(headers.has("authorization")).toBe(false);
      return new Response('{"success":true}', { status: 200 });
    });
    const fetcher = new PublicPageFetcher({
      fetchFn,
      minimumIntervalMs: 0
    });

    await expect(
      fetcher.fetchPage(
        {
          url: "https://api-pc.pxb7.com/list",
          options: {
            method: "POST",
            accept: "application/json, text/plain, */*",
            contentType: "application/json",
            origin: "https://www.pxb7.com",
            referer: "https://www.pxb7.com/",
            body: '{"pageIndex":1}'
          }
        },
        "pxb7"
      )
    ).resolves.toMatchObject({ kind: "ok" });
  });

  it("keeps URL-only requests as HTML GETs without a body", async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(init?.method ?? "GET").toBe("GET");
      expect(init?.body).toBeUndefined();
      expect(headers.get("accept")).toBe(
        "text/html,application/xhtml+xml"
      );
      return new Response("<p>ok</p>");
    });
    const fetcher = new PublicPageFetcher({
      fetchFn,
      minimumIntervalMs: 0
    });

    await expect(
      fetcher.fetchPage({ url: "https://example.com" }, "panzhi")
    ).resolves.toMatchObject({ kind: "ok" });
  });

  it("sets an explicit user agent and recognizes captcha pages", async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("user-agent")).toContain(
        "DeltaAccountScout"
      );
      return new Response("<p>请完成验证码 captcha</p>", { status: 200 });
    });
    const fetcher = new PublicPageFetcher({ fetchFn });

    await expect(
      fetcher.fetchPage({ url: "https://example.com" }, "jiaoyimao")
    ).resolves.toEqual({
      kind: "blocked",
      url: "https://example.com",
      reason: "captcha_required"
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("does not treat a dormant captcha script include as a challenge", async () => {
    const fetcher = new PublicPageFetcher({
      fetchFn: async () =>
        new Response(
          '<main>公开商品首页</main><script src="/assets/captcha.js"></script>'
        ),
      minimumIntervalMs: 0
    });

    await expect(
      fetcher.fetchPage({ url: "https://example.com" }, "pxb7")
    ).resolves.toMatchObject({ kind: "ok" });
  });

  it("retries a transient failure once", async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket reset"))
      .mockResolvedValueOnce(new Response("<p>ok</p>", { status: 200 }));
    const fetcher = new PublicPageFetcher({
      fetchFn,
      minimumIntervalMs: 0
    });

    const result = await fetcher.fetchPage(
      { url: "https://example.com/list" },
      "panzhi"
    );
    expect(result.kind).toBe("ok");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("aborts after 15 seconds and only attempts twice", async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(
      async (_url: string, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        })
    );
    const fetcher = new PublicPageFetcher({
      fetchFn,
      minimumIntervalMs: 0
    });

    const resultPromise = fetcher.fetchPage(
      { url: "https://example.com/slow" },
      "panzhi"
    );
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await resultPromise;
    expect(result).toMatchObject({ kind: "failed", error: "request_timeout" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("keeps requests to the same source two seconds apart", async () => {
    let now = 1_000;
    const sleeps: number[] = [];
    const fetchFn = vi.fn(async () => new Response("<p>ok</p>"));
    const fetcher = new PublicPageFetcher({
      fetchFn,
      now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      }
    });

    await fetcher.fetchPage({ url: "https://example.com/one" }, "panzhi");
    now += 500;
    await fetcher.fetchPage({ url: "https://example.com/two" }, "panzhi");
    expect(sleeps).toEqual([1_500]);
  });

  it("rejects responses larger than two megabytes", async () => {
    const fetcher = new PublicPageFetcher({
      fetchFn: async () =>
        new Response("x", {
          headers: { "content-length": String(2 * 1024 * 1024 + 1) }
        }),
      minimumIntervalMs: 0
    });
    await expect(
      fetcher.fetchPage({ url: "https://example.com/huge" }, "pxb7")
    ).resolves.toMatchObject({
      kind: "failed",
      error: "response_too_large"
    });
  });
});
