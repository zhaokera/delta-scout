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
  deriveApprovedJiaoyimaoMtopPageOneData,
  extractAnonymousMtopSession,
  isApprovedJiaoyimaoMtopRequest,
  signMtop
} from "./mtop.js";
import type { AnonymousMtopSession } from "./mtop.js";

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
  /验证码|安全验证|_____tmd_____|\/punish|action\s*[:=]\s*["']captcha["']|请完成.{0,10}验证|访问过于频繁|aliyun_waf_(?:aa|bb)|aliyunCaptcha-sliding-slider/i;
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

interface JiaoyimaoSourceState {
  session: AnonymousMtopSession | null;
  readonly jymMeta: string;
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
  private jiaoyimaoSourceState: JiaoyimaoSourceState | null = null;

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

  beginSource(source: SourceId): void {
    if (source !== "jiaoyimao") return;
    this.clearJiaoyimaoSourceState();
    this.jiaoyimaoSourceState = this.createJiaoyimaoSourceState();
  }

  endSource(source: SourceId): void {
    if (source === "jiaoyimao") {
      this.clearJiaoyimaoSourceState();
    }
  }

  private createJiaoyimaoSourceState(): JiaoyimaoSourceState {
    return {
      session: null,
      jymMeta: buildJymMeta(this.now(), this.random())
    };
  }

  private clearJiaoyimaoSourceState(): void {
    if (this.jiaoyimaoSourceState !== null) {
      this.jiaoyimaoSourceState.session = null;
      this.jiaoyimaoSourceState = null;
    }
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
      if (
        source !== "jiaoyimao" ||
        !isApprovedJiaoyimaoMtopRequest(request)
      ) {
        return { kind: "failed", url, error: "unapproved_mtop_request" };
      }
      const lifecycleState = this.jiaoyimaoSourceState;
      const state = lifecycleState ?? this.createJiaoyimaoSourceState();
      try {
        return await this.fetchAnonymousMtop(request, source, state);
      } finally {
        if (lifecycleState === null) {
          state.session = null;
        }
      }
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

        const body = await readBoundedResponse(
          response,
          this.maximumBytes,
          controller
        );
        if (body.kind === "too_large") {
          return { kind: "failed", url, error: "response_too_large" };
        }
        const html = body.text;

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
    source: SourceId,
    state: JiaoyimaoSourceState
  ): Promise<FetchResult> {
    const { url, options } = request;
    const anonymousMtop = options?.anonymousMtop;
    const data = options?.body;
    if (anonymousMtop === undefined || data === undefined) {
      return { kind: "failed", url, error: "unapproved_mtop_request" };
    }
    if (state.session === null) {
      return this.bootstrapAnonymousMtop(
        url,
        anonymousMtop,
        data,
        source,
        state
      );
    }
    return this.fetchWithAnonymousMtopSession(
      url,
      anonymousMtop,
      data,
      source,
      state
    );
  }

  private async bootstrapAnonymousMtop(
    url: string,
    anonymousMtop: AnonymousMtopRequestOptions,
    requestedData: string,
    source: SourceId,
    state: JiaoyimaoSourceState
  ): Promise<FetchResult> {
    const pageOneData =
      deriveApprovedJiaoyimaoMtopPageOneData(requestedData);
    if (pageOneData === null) {
      return { kind: "failed", url, error: "unapproved_mtop_request" };
    }
    const budget: MtopNetworkBudget = { remaining: 3 };

    const handshake = await this.sendMtopRequest(
      url,
      anonymousMtop,
      pageOneData,
      "",
      undefined,
      source,
      budget,
      false,
      state.jymMeta
    );
    if (handshake.kind !== "ok") {
      state.session = null;
      return handshake;
    }
    const handshakePayload = parseMtopPayload(handshake.html);
    if (handshakePayload === null) {
      state.session = null;
      return { kind: "failed", url, error: "invalid_mtop_response" };
    }
    if (
      !hasMtopCode(
        handshakePayload.ret,
        "FAIL_SYS_TOKEN_EMPTY"
      )
    ) {
      state.session = null;
      return { kind: "failed", url, error: "mtop_handshake_failed" };
    }

    const session = extractAnonymousMtopSession(handshake.headers);
    if (session === null) {
      state.session = null;
      return { kind: "failed", url, error: "mtop_session_missing" };
    }

    const prime = await this.sendMtopRequest(
      url,
      anonymousMtop,
      pageOneData,
      session.token,
      session.cookieHeader,
      source,
      budget,
      false,
      state.jymMeta
    );
    if (prime.kind !== "ok") {
      state.session = null;
      return prime;
    }
    const primePayload = parseMtopPayload(prime.html);
    if (
      primePayload === null ||
      !primePayload.ret.includes("SUCCESS::调用成功") ||
      !isApprovedMtopSuccess(primePayload)
    ) {
      state.session = null;
      return {
        kind: "failed",
        url,
        error:
          primePayload === null ||
          primePayload.ret.includes("SUCCESS::调用成功")
            ? "invalid_mtop_response"
            : "mtop_request_failed"
      };
    }

    if (requestedData === pageOneData) {
      state.session = session;
      return {
        kind: "ok",
        url,
        status: prime.status,
        html: prime.html
      };
    }

    const requested = await this.sendMtopRequest(
      url,
      anonymousMtop,
      requestedData,
      session.token,
      session.cookieHeader,
      source,
      budget,
      false,
      state.jymMeta
    );
    if (requested.kind !== "ok") {
      state.session = null;
      return requested;
    }
    const requestedPayload = parseMtopPayload(requested.html);
    if (requestedPayload === null) {
      state.session = null;
      return { kind: "failed", url, error: "invalid_mtop_response" };
    }
    if (!requestedPayload.ret.includes("SUCCESS::调用成功")) {
      state.session = null;
      return { kind: "failed", url, error: "mtop_request_failed" };
    }
    if (!isApprovedMtopSuccess(requestedPayload)) {
      state.session = null;
      return { kind: "failed", url, error: "invalid_mtop_response" };
    }
    state.session = session;
    return {
      kind: "ok",
      url,
      status: requested.status,
      html: requested.html
    };
  }

  private async fetchWithAnonymousMtopSession(
    url: string,
    anonymousMtop: AnonymousMtopRequestOptions,
    data: string,
    source: SourceId,
    state: JiaoyimaoSourceState
  ): Promise<FetchResult> {
    const session = state.session;
    if (session === null) {
      return { kind: "failed", url, error: "mtop_session_missing" };
    }
    const budget: MtopNetworkBudget = { remaining: 3 };
    const signed = await this.sendMtopRequest(
      url,
      anonymousMtop,
      data,
      session.token,
      session.cookieHeader,
      source,
      budget,
      true,
      state.jymMeta
    );
    if (signed.kind !== "ok") {
      state.session = null;
      return signed;
    }
    const signedPayload = parseMtopPayload(signed.html);
    if (signedPayload === null) {
      state.session = null;
      return { kind: "failed", url, error: "invalid_mtop_response" };
    }
    if (signedPayload.ret.includes("SUCCESS::调用成功")) {
      if (!isApprovedMtopSuccess(signedPayload)) {
        state.session = null;
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
      state.session = null;
      return { kind: "failed", url, error: "mtop_request_failed" };
    }
    const replacement = extractAnonymousMtopSession(signed.headers);
    if (replacement === null) {
      state.session = null;
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
      false,
      state.jymMeta
    );
    if (finalAttempt.kind !== "ok") {
      state.session = null;
      return finalAttempt;
    }
    const finalPayload = parseMtopPayload(finalAttempt.html);
    if (finalPayload === null) {
      state.session = null;
      return { kind: "failed", url, error: "invalid_mtop_response" };
    }
    if (!finalPayload.ret.includes("SUCCESS::调用成功")) {
      state.session = null;
      return { kind: "failed", url, error: "mtop_request_failed" };
    }
    if (!isApprovedMtopSuccess(finalPayload)) {
      state.session = null;
      return { kind: "failed", url, error: "invalid_mtop_response" };
    }
    state.session = replacement;
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
    allowTransientRetry: boolean,
    jymMeta: string
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
      "jym-meta-h5": jymMeta,
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
          redirect: "manual"
        });
        if (
          (response.status >= 300 && response.status < 400) ||
          response.headers.has("location")
        ) {
          await cancelResponseBody(response, controller);
          return {
            kind: "failed",
            url: resultUrl,
            error: "redirect_not_allowed"
          };
        }
        const responseBody = await readBoundedResponse(
          response,
          this.maximumBytes,
          controller
        );
        if (responseBody.kind === "too_large") {
          return {
            kind: "failed",
            url: resultUrl,
            error: "response_too_large"
          };
        }
        const html = responseBody.text;
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
            : "network_error";
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

type BoundedResponseRead =
  | { readonly kind: "ok"; readonly text: string }
  | { readonly kind: "too_large" };

async function readBoundedResponse(
  response: Response,
  maximumBytes: number,
  controller: AbortController
): Promise<BoundedResponseRead> {
  const declaredLengthHeader = response.headers.get("content-length");
  const declaredLength =
    declaredLengthHeader === null
      ? null
      : Number(declaredLengthHeader);
  if (
    declaredLength !== null &&
    Number.isFinite(declaredLength) &&
    declaredLength > maximumBytes
  ) {
    await cancelResponseBody(response, controller);
    return { kind: "too_large" };
  }

  if (response.body === null) {
    return { kind: "ok", text: "" };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      byteLength += next.value.byteLength;
      if (byteLength > maximumBytes) {
        await cancelResponseReader(reader, controller);
        return { kind: "too_large" };
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: "ok", text: new TextDecoder().decode(bytes) };
}

async function cancelResponseBody(
  response: Response,
  controller: AbortController
): Promise<void> {
  let cancellation: Promise<void> | undefined;
  try {
    cancellation = response.body?.cancel();
  } catch {
    // Abort still proceeds if initiating cancellation throws synchronously.
  }
  controller.abort();
  try {
    await cancellation;
  } catch {
    // The transport is already being aborted; cancellation errors are ignored.
  }
}

async function cancelResponseReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  controller: AbortController
): Promise<void> {
  let cancellation: Promise<void> | undefined;
  try {
    cancellation = reader.cancel();
  } catch {
    // Abort still proceeds if initiating cancellation throws synchronously.
  }
  controller.abort();
  try {
    await cancellation;
  } catch {
    // The transport is already being aborted; cancellation errors are ignored.
  }
}
