import type {
  AnonymousMtopRequestOptions,
  FetchResult,
  PageFetcher,
  SourceRequest
} from "./types.js";
import type { SourceId } from "../../domain/listing.js";
import {
  APPROVED_JIAOYIMAO_REFERER,
  buildJymMeta,
  buildMtopUrl,
  extractAnonymousMtopSession,
  isApprovedJiaoyimaoMtopRequest,
  signMtop
} from "./mtop.js";

type FetchFunction = (
  url: string,
  init?: RequestInit
) => Promise<Response>;

interface PublicPageFetcherOptions {
  fetchFn?: FetchFunction;
  now?: () => number;
  random?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
  minimumIntervalMs?: number;
  maximumBytes?: number;
}

const BLOCKED_PATTERN =
  /验证码|安全验证|_____tmd_____|\/punish|action\s*[:=]\s*["']captcha["']|请完成.{0,10}验证|访问过于频繁/i;
const USER_AGENT =
  "DeltaAccountScout/0.1 (+local personal comparison tool)";

interface MtopHttpResponse {
  readonly kind: "ok";
  readonly status: number;
  readonly html: string;
  readonly headers: Headers;
}

type MtopHttpResult =
  | MtopHttpResponse
  | Exclude<FetchResult, { kind: "ok" }>;

interface MtopNetworkBudget {
  remaining: number;
}

export class PublicPageFetcher implements PageFetcher {
  private readonly fetchFn: FetchFunction;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly minimumIntervalMs: number;
  private readonly maximumBytes: number;
  private readonly lastAttemptBySource = new Map<SourceId, number>();

  constructor(options: PublicPageFetcherOptions = {}) {
    this.fetchFn = options.fetchFn ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
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

  async fetchPage(
    request: SourceRequest,
    source: SourceId
  ): Promise<FetchResult> {
    const { url, options } = request;
    if (
      options?.anonymousMtop !== undefined ||
      targetsJiaoyimaoMtopHost(url)
    ) {
      if (!isApprovedJiaoyimaoMtopRequest(request)) {
        return { kind: "failed", url, error: "unapproved_mtop_request" };
      }
      return this.fetchAnonymousMtop(request, source);
    }

    let lastError = "request_failed";

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await this.throttle(source);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await this.fetchFn(url, {
          method: options?.method ?? "GET",
          signal: controller.signal,
          headers: {
            Accept:
              options?.accept ?? "text/html,application/xhtml+xml",
            ...(options?.contentType
              ? { "Content-Type": options.contentType }
              : {}),
            ...(options?.origin ? { Origin: options.origin } : {}),
            ...(options?.referer ? { Referer: options.referer } : {}),
            "User-Agent": USER_AGENT
          },
          ...(options?.method === "POST" && options.body !== undefined
            ? { body: options.body }
            : {}),
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

  private async fetchAnonymousMtop(
    request: SourceRequest,
    source: SourceId
  ): Promise<FetchResult> {
    const { url, options } = request;
    const anonymousMtop = options?.anonymousMtop;
    const data = options?.body;
    if (anonymousMtop === undefined || data === undefined) {
      return { kind: "failed", url, error: "unapproved_mtop_request" };
    }
    const budget: MtopNetworkBudget = { remaining: 3 };

    const handshake = await this.sendMtopRequest(
      url,
      anonymousMtop,
      data,
      "",
      undefined,
      source,
      budget,
      true
    );
    if (handshake.kind !== "ok") return handshake;
    const handshakePayload = parseMtopPayload(handshake.html);
    if (handshakePayload === null) {
      return { kind: "failed", url, error: "invalid_mtop_response" };
    }
    if (
      !hasMtopCode(
        handshakePayload.ret,
        "FAIL_SYS_TOKEN_EMPTY"
      )
    ) {
      return { kind: "failed", url, error: "mtop_handshake_failed" };
    }

    const session = extractAnonymousMtopSession(handshake.headers);
    if (session === null) {
      return { kind: "failed", url, error: "mtop_session_missing" };
    }

    const signed = await this.sendMtopRequest(
      url,
      anonymousMtop,
      data,
      session.token,
      session.cookieHeader,
      source,
      budget,
      true
    );
    if (signed.kind !== "ok") return signed;
    const signedPayload = parseMtopPayload(signed.html);
    if (signedPayload === null) {
      return { kind: "failed", url, error: "invalid_mtop_response" };
    }
    if (signedPayload.ret.includes("SUCCESS::调用成功")) {
      if (!isApprovedMtopSuccess(signedPayload)) {
        return { kind: "failed", url, error: "invalid_mtop_response" };
      }
      return {
        kind: "ok",
        url,
        status: signed.status,
        html: signed.html
      };
    }
    if (
      !hasMtopCode(
        signedPayload.ret,
        "FAIL_SYS_TOKEN_EXPIRED"
      )
    ) {
      return { kind: "failed", url, error: "mtop_request_failed" };
    }

    const replacement = extractAnonymousMtopSession(signed.headers);
    if (replacement === null) {
      return {
        kind: "failed",
        url,
        error: "mtop_token_expired_without_replacement"
      };
    }
    const finalAttempt = await this.sendMtopRequest(
      url,
      anonymousMtop,
      data,
      replacement.token,
      replacement.cookieHeader,
      source,
      budget,
      false
    );
    if (finalAttempt.kind !== "ok") return finalAttempt;
    const finalPayload = parseMtopPayload(finalAttempt.html);
    if (finalPayload === null) {
      return { kind: "failed", url, error: "invalid_mtop_response" };
    }
    if (!finalPayload.ret.includes("SUCCESS::调用成功")) {
      return { kind: "failed", url, error: "mtop_request_failed" };
    }
    if (!isApprovedMtopSuccess(finalPayload)) {
      return { kind: "failed", url, error: "invalid_mtop_response" };
    }
    return {
      kind: "ok",
      url,
      status: finalAttempt.status,
      html: finalAttempt.html
    };
  }

  private async sendMtopRequest(
    resultUrl: string,
    options: AnonymousMtopRequestOptions,
    data: string,
    token: string,
    cookieHeader: string | undefined,
    source: SourceId,
    budget: MtopNetworkBudget,
    allowTransientRetry: boolean
  ): Promise<MtopHttpResult> {
    if (budget.remaining === 0) {
      return {
        kind: "failed",
        url: resultUrl,
        error: "mtop_request_budget_exhausted"
      };
    }
    await this.throttle(source);
    const timestamp = this.now();
    const signedUrl = buildMtopUrl(
      resultUrl,
      options,
      timestamp,
      signMtop(token, timestamp, options.appKey, data)
    );
    const body = new URLSearchParams({ data }).toString();
    const requestHeaders = {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "https://www.jiaoyimao.com",
      Referer: APPROVED_JIAOYIMAO_REFERER,
      "User-Agent": USER_AGENT,
      "jym-meta-h5": buildJymMeta(timestamp, this.random()),
      "x-ua": USER_AGENT,
      ...(cookieHeader === undefined ? {} : { Cookie: cookieHeader })
    };
    let lastError = "request_failed";
    const maximumAttempts = Math.min(
      allowTransientRetry ? 2 : 1,
      budget.remaining
    );

    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      if (attempt > 0) await this.throttle(source);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        budget.remaining -= 1;
        const response = await this.fetchFn(signedUrl, {
          method: "POST",
          signal: controller.signal,
          headers: requestHeaders,
          body,
          redirect: "follow"
        });
        const declaredLength = Number(
          response.headers.get("content-length") ?? "0"
        );
        if (
          Number.isFinite(declaredLength) &&
          declaredLength > this.maximumBytes
        ) {
          return {
            kind: "failed",
            url: resultUrl,
            error: "response_too_large"
          };
        }

        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > this.maximumBytes) {
          return {
            kind: "failed",
            url: resultUrl,
            error: "response_too_large"
          };
        }
        const html = new TextDecoder().decode(bytes);
        if (BLOCKED_PATTERN.test(html)) {
          return {
            kind: "blocked",
            url: resultUrl,
            reason: "captcha_required"
          };
        }
        if (!response.ok) {
          lastError = `http_${response.status}`;
          continue;
        }
        return {
          kind: "ok",
          status: response.status,
          html,
          headers: response.headers
        };
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

    return { kind: "failed", url: resultUrl, error: lastError };
  }
}

interface ParsedMtopPayload {
  readonly ret: string[];
  readonly raw: Record<string, unknown>;
}

function parseMtopPayload(html: string): ParsedMtopPayload | null {
  try {
    const parsed: unknown = JSON.parse(html);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("ret" in parsed) ||
      !Array.isArray(parsed.ret) ||
      !parsed.ret.every((entry) => typeof entry === "string")
    ) {
      return null;
    }
    return { ret: parsed.ret, raw: parsed };
  } catch {
    return null;
  }
}

function isApprovedMtopSuccess(payload: ParsedMtopPayload): boolean {
  const data = payload.raw.data;
  if (!isRecord(data)) return false;
  const result = data.result;
  if (!isRecord(result) || !Array.isArray(result.deliverComps)) {
    return false;
  }
  return (
    typeof result.hasNextPage === "boolean" ||
    result.hasNextPage === "true" ||
    result.hasNextPage === "false"
  );
}

function hasMtopCode(ret: readonly string[], code: string): boolean {
  return ret.some((entry) => entry.split("::", 1)[0] === code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function targetsJiaoyimaoMtopHost(url: string): boolean {
  try {
    return new URL(url).hostname === "mtop.jiaoyimao.com";
  } catch {
    return false;
  }
}
