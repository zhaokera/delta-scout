import type { FetchResult, PageFetcher } from "./types.js";
import type { SourceId } from "../../domain/listing.js";

type FetchFunction = (
  url: string,
  init?: RequestInit
) => Promise<Response>;

interface PublicPageFetcherOptions {
  fetchFn?: FetchFunction;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
  minimumIntervalMs?: number;
  maximumBytes?: number;
}

const BLOCKED_PATTERN =
  /验证码|安全验证|_____tmd_____|\/punish|action\s*[:=]\s*["']captcha["']|请完成.{0,10}验证|访问过于频繁/i;

export class PublicPageFetcher implements PageFetcher {
  private readonly fetchFn: FetchFunction;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly minimumIntervalMs: number;
  private readonly maximumBytes: number;
  private readonly lastAttemptBySource = new Map<SourceId, number>();

  constructor(options: PublicPageFetcherOptions = {}) {
    this.fetchFn = options.fetchFn ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.minimumIntervalMs = options.minimumIntervalMs ?? 2_000;
    this.maximumBytes = options.maximumBytes ?? 2 * 1024 * 1024;
  }

  private async throttle(source: SourceId): Promise<void> {
    const lastAttempt = this.lastAttemptBySource.get(source);
    if (lastAttempt !== undefined) {
      const remaining =
        this.minimumIntervalMs - (this.now() - lastAttempt);
      if (remaining > 0) await this.sleep(remaining);
    }
    this.lastAttemptBySource.set(source, this.now());
  }

  async fetchPage(url: string, source: SourceId): Promise<FetchResult> {
    let lastError = "request_failed";

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await this.throttle(source);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await this.fetchFn(url, {
          signal: controller.signal,
          headers: {
            Accept: "text/html,application/xhtml+xml",
            "User-Agent":
              "DeltaAccountScout/0.1 (+local personal comparison tool)"
          },
          redirect: "follow"
        });

        const declaredLength = Number(
          response.headers.get("content-length") ?? "0"
        );
        if (
          Number.isFinite(declaredLength) &&
          declaredLength > this.maximumBytes
        ) {
          return { kind: "failed", url, error: "response_too_large" };
        }

        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > this.maximumBytes) {
          return { kind: "failed", url, error: "response_too_large" };
        }
        const html = new TextDecoder().decode(bytes);

        if (BLOCKED_PATTERN.test(html)) {
          return { kind: "blocked", url, reason: "captcha_required" };
        }
        if (!response.ok) {
          lastError = `http_${response.status}`;
          continue;
        }
        return { kind: "ok", url, status: response.status, html };
      } catch (error) {
        lastError =
          error instanceof DOMException && error.name === "AbortError"
            ? "request_timeout"
            : error instanceof Error
              ? error.message
              : "request_failed";
      } finally {
        clearTimeout(timer);
      }
    }

    return { kind: "failed", url, error: lastError };
  }
}
