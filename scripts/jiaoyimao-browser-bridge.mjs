const DEFAULT_API_BASE = "http://127.0.0.1:4310";
const MAX_BATCH_BYTES = 131_072;
const MAX_LIST_ITEMS = 25;
const MAX_DETAIL_ITEMS = 5;
const MAX_UNIQUE_ITEMS = 2_000;
const MAX_LOAD_EVENTS = 100;
const TERMINAL_STATES = new Set([
  "success",
  "quarantined",
  "failed",
  "cancelled",
  "expired"
]);
const TERMINAL_ERROR_CODES = new Set([
  "bridge_unauthorized",
  "browser_job_not_found",
  "browser_job_expired"
]);
const PAUSE_REASONS = new Set([
  "login_required",
  "captcha_required",
  "rate_limited",
  "structure_changed",
  "no_progress",
  "safety_limit"
]);
const BLOCKING_STATES = new Set([
  "none",
  "login",
  "captcha",
  "rate_limited",
  "error"
]);
const FORBIDDEN_FIELD_NAMES = new Set([
  "cookie",
  "cookies",
  "setcookie",
  "localstorage",
  "sessionstorage",
  "authsession",
  "authsessionid",
  "password",
  "passwd",
  "captchaanswer",
  "captcharesponse",
  "authorization",
  "proxyauthorization",
  "networkauthorization",
  "networkauthheader",
  "networkauthheaders",
  "requestheaders"
]);
const FORBIDDEN_VISIBLE_TEXT = [
  /cookie\s*[:=]/i,
  /set-cookie/i,
  /authorization\s*[:=]/i,
  /bearer\s+\S+/i,
  /_m_h5_tk/i,
  /password\s*[:=]/i,
  /验证码答案\s*[:=]/i,
  /校验码\s*[:=]/i,
  /<script/i,
  /javascript:/i,
  /<\/?[A-Za-z][A-Za-z0-9:-]*[^>]*>/i
];
const FILTER_ORIGIN = "https://www.jiaoyimao.com";
const FILTER_PATH = "/jg2007840/f8845003-c8845004/o110/";
const DETAIL_PATH = /^\/jg2007840\/(\d+)\.html$/;

export class JiaoyimaoBrowserBridgeError extends Error {
  constructor(code, message, retryAt) {
    super(message);
    this.name = "JiaoyimaoBrowserBridgeError";
    this.code = code;
    if (retryAt !== undefined) this.retryAt = retryAt;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.retryAt ? { retryAt: this.retryAt } : {})
    };
  }
}

function bridgeError(
  code = "invalid_bridge_payload",
  message = "浏览器桥接请求格式无效"
) {
  return new JiaoyimaoBrowserBridgeError(code, message);
}

function normalizedFieldName(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertNoForbiddenFields(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) {
    throw bridgeError();
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertNoForbiddenFields(item, seen);
    return;
  }
  if (!isPlainObject(value)) throw bridgeError();
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_FIELD_NAMES.has(normalizedFieldName(key))) {
      throw bridgeError();
    }
    assertNoForbiddenFields(nested, seen);
  }
}

function assertExactObject(value, keys) {
  assertNoForbiddenFields(value);
  if (!isPlainObject(value)) throw bridgeError();
  const expected = new Set(keys);
  const actual = Object.keys(value);
  if (
    actual.length !== expected.size ||
    actual.some((key) => !expected.has(key))
  ) {
    throw bridgeError();
  }
  return value;
}

function assertOptionalExactObject(value, required, optional = []) {
  assertNoForbiddenFields(value);
  if (!isPlainObject(value)) throw bridgeError();
  const requiredKeys = new Set(required);
  const allowed = new Set([...required, ...optional]);
  const actual = Object.keys(value);
  if (
    [...requiredKeys].some((key) => !(key in value)) ||
    actual.some((key) => !allowed.has(key))
  ) {
    throw bridgeError();
  }
  return value;
}

function assertString(value, minimum, maximum) {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum
  ) {
    throw bridgeError();
  }
  return value;
}

function assertSafeText(value, minimum, maximum) {
  const text = assertString(value, minimum, maximum);
  if (FORBIDDEN_VISIBLE_TEXT.some((pattern) => pattern.test(text))) {
    throw bridgeError();
  }
  return text;
}

function assertInteger(value, minimum, maximum) {
  if (
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw bridgeError();
  }
  return value;
}

function assertIsoTimestamp(value) {
  const timestamp = assertString(value, 1, 64);
  if (
    !/^\d{4}-\d{2}-\d{2}T/.test(timestamp) ||
    !Number.isFinite(Date.parse(timestamp))
  ) {
    throw bridgeError();
  }
  return timestamp;
}

function parseApprovedUrl(value, expectedPath) {
  const text = assertString(value, 1, 2_048);
  let url;
  try {
    url = new URL(text);
  } catch {
    throw bridgeError();
  }
  if (
    url.origin !== FILTER_ORIGIN ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.hash !== "" ||
    url.toString() !== text ||
    (expectedPath && url.pathname !== expectedPath)
  ) {
    throw bridgeError();
  }
  return url;
}

function validateFilterProof(value) {
  const proof = assertExactObject(value, [
    "currentUrl",
    "gameLabel",
    "platformLabel",
    "categoryLabel",
    "m7FilterLabels",
    "observedAt"
  ]);
  parseApprovedUrl(proof.currentUrl, FILTER_PATH);
  assertSafeText(proof.gameLabel, 1, 100);
  assertSafeText(proof.platformLabel, 1, 100);
  assertSafeText(proof.categoryLabel, 1, 100);
  if (
    !Array.isArray(proof.m7FilterLabels) ||
    proof.m7FilterLabels.length < 4 ||
    proof.m7FilterLabels.length > 8
  ) {
    throw bridgeError();
  }
  for (const label of proof.m7FilterLabels) {
    assertSafeText(label, 1, 100);
  }
  assertIsoTimestamp(proof.observedAt);
  return proof;
}

function validateListItem(value) {
  const item = assertExactObject(value, [
    "sourceListingId",
    "url",
    "title",
    "rawText",
    "priceCny"
  ]);
  const id = assertString(item.sourceListingId, 1, 100);
  if (!/^\d+$/.test(id)) throw bridgeError();
  const url = parseApprovedUrl(item.url);
  if (url.pathname.match(DETAIL_PATH)?.[1] !== id) {
    throw bridgeError();
  }
  assertSafeText(item.title, 1, 500);
  assertSafeText(item.rawText, 0, 4_000);
  if (
    item.priceCny !== null &&
    (
      typeof item.priceCny !== "number" ||
      !Number.isFinite(item.priceCny) ||
      item.priceCny < 0
    )
  ) {
    throw bridgeError();
  }
  return item;
}

function validateListBatch(value) {
  const batch = assertExactObject(value, [
    "sequence",
    "observedAt",
    "items"
  ]);
  assertInteger(batch.sequence, 1, MAX_UNIQUE_ITEMS);
  assertIsoTimestamp(batch.observedAt);
  if (
    !Array.isArray(batch.items) ||
    batch.items.length < 1 ||
    batch.items.length > MAX_LIST_ITEMS
  ) {
    throw bridgeError();
  }
  for (const item of batch.items) validateListItem(item);
  assertBatchSize(batch);
  return batch;
}

function validateLoadEvent(value) {
  const event = assertExactObject(value, [
    "sequence",
    "observedUniqueCount",
    "newItemCount",
    "visibleTotalCount",
    "endMarkerVisible",
    "loadingVisible",
    "blockingState",
    "observedAt"
  ]);
  assertInteger(event.sequence, 1, MAX_LOAD_EVENTS);
  assertInteger(event.observedUniqueCount, 0, MAX_UNIQUE_ITEMS);
  assertInteger(event.newItemCount, 0, MAX_UNIQUE_ITEMS);
  if (event.visibleTotalCount !== null) {
    assertInteger(event.visibleTotalCount, 0, MAX_UNIQUE_ITEMS);
  }
  if (
    typeof event.endMarkerVisible !== "boolean" ||
    typeof event.loadingVisible !== "boolean" ||
    !BLOCKING_STATES.has(event.blockingState)
  ) {
    throw bridgeError();
  }
  assertIsoTimestamp(event.observedAt);
  return event;
}

function validateDetailItem(value) {
  const item = assertExactObject(value, [
    "sourceListingId",
    "url",
    "observedAt",
    "sections"
  ]);
  const id = assertString(item.sourceListingId, 1, 100);
  if (!/^\d+$/.test(id)) throw bridgeError();
  const url = parseApprovedUrl(item.url);
  if (url.pathname.match(DETAIL_PATH)?.[1] !== id) {
    throw bridgeError();
  }
  assertIsoTimestamp(item.observedAt);
  const sections = assertExactObject(item.sections, [
    "head",
    "report",
    "safety",
    "description"
  ]);
  let combined = 0;
  for (const section of Object.values(sections)) {
    combined += assertSafeText(section, 0, 12_000).length;
  }
  if (combined > 32_000) throw bridgeError();
  return item;
}

function validateDetailBatch(value) {
  const batch = assertExactObject(value, ["sequence", "items"]);
  assertInteger(batch.sequence, 1, MAX_UNIQUE_ITEMS);
  if (
    !Array.isArray(batch.items) ||
    batch.items.length < 1 ||
    batch.items.length > MAX_DETAIL_ITEMS
  ) {
    throw bridgeError();
  }
  for (const item of batch.items) validateDetailItem(item);
  assertBatchSize(batch);
  return batch;
}

function validatePause(value) {
  const pause = assertOptionalExactObject(
    value,
    ["reason"],
    ["message"]
  );
  if (!PAUSE_REASONS.has(pause.reason)) throw bridgeError();
  if (pause.message !== undefined) {
    assertSafeText(pause.message, 0, 500);
  }
  return pause;
}

function assertBatchSize(value) {
  if (
    new TextEncoder().encode(JSON.stringify(value)).length >
    MAX_BATCH_BYTES
  ) {
    throw bridgeError();
  }
}

function validateEmptyArgument(value) {
  if (value === undefined) return;
  assertExactObject(value, []);
}

function safeServerCode(value, fallback) {
  return typeof value === "string" &&
    /^[a-z][a-z0-9_]{0,63}$/.test(value)
    ? value
    : fallback;
}

function safeServerMessage(value, secrets) {
  const fallback = "浏览器桥接请求失败";
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 500 ||
    /bearer\s/i.test(value) ||
    FORBIDDEN_VISIBLE_TEXT.some((pattern) => pattern.test(value)) ||
    secrets.some((secret) => secret && value.includes(secret))
  ) {
    return fallback;
  }
  return value;
}

function safeRetryAt(value) {
  return typeof value === "string" &&
    value.length <= 64 &&
    Number.isFinite(Date.parse(value))
    ? value
    : undefined;
}

async function readJson(response) {
  try {
    const value = await response.json();
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

function assertSafeServerPayload(value) {
  if (!isPlainObject(value)) {
    throw bridgeError(
      "invalid_server_response",
      "浏览器桥接响应格式无效"
    );
  }
  try {
    assertNoForbiddenFields(value);
  } catch {
    throw bridgeError(
      "invalid_server_response",
      "浏览器桥接响应格式无效"
    );
  }
  return value;
}

function normalizeBaseUrl(value) {
  const text = value ?? DEFAULT_API_BASE;
  if (typeof text !== "string") throw bridgeError();
  let url;
  try {
    url = new URL(text);
  } catch {
    throw bridgeError();
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw bridgeError();
  }
  return url.toString().replace(/\/$/, "");
}

function validateClaimOptions(options) {
  const value = assertOptionalExactObject(
    options,
    ["jobId", "claimCode"],
    ["baseUrl", "fetch"]
  );
  const id = assertString(value.jobId, 1, 128);
  if (!/^[A-Za-z0-9-]+$/.test(id)) throw bridgeError();
  assertString(value.claimCode, 1, 64);
  if (
    value.fetch !== undefined &&
    typeof value.fetch !== "function"
  ) {
    throw bridgeError();
  }
  return value;
}

function isTerminalPayload(value) {
  return TERMINAL_STATES.has(value?.state);
}

export async function claimJiaoyimaoBrowserJob(options) {
  const claimed = validateClaimOptions(options);
  const baseUrl = normalizeBaseUrl(claimed.baseUrl);
  const fetchImpl = claimed.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw bridgeError(
      "browser_bridge_unavailable",
      "当前运行时不支持 fetch"
    );
  }
  const encodedJobId = encodeURIComponent(claimed.jobId);
  const claimUrl =
    `${baseUrl}/api/browser-refresh/${encodedJobId}/claim`;
  let claimResponse;
  try {
    claimResponse = await fetchImpl(claimUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json"
      },
      body: JSON.stringify({ claimCode: claimed.claimCode })
    });
  } catch {
    throw bridgeError(
      "browser_bridge_network_error",
      "浏览器桥接请求失败"
    );
  }
  const claimPayload = await readJson(claimResponse);
  if (!claimResponse.ok) {
    const code = safeServerCode(
      claimPayload?.error,
      "browser_bridge_http_error"
    );
    throw new JiaoyimaoBrowserBridgeError(
      code,
      safeServerMessage(claimPayload?.message, [claimed.claimCode]),
      safeRetryAt(claimPayload?.retryAt)
    );
  }
  const claimedToken = claimPayload?.bridgeToken;
  if (
    typeof claimedToken !== "string" ||
    claimedToken.length < 1 ||
    claimedToken.length > 512
  ) {
    throw bridgeError(
      "invalid_server_response",
      "浏览器桥接响应格式无效"
    );
  }

  let token = claimedToken;
  let pendingPermit = null;

  function requireToken() {
    if (token === null) {
      throw bridgeError(
        "bridge_client_closed",
        "浏览器桥接客户端已关闭"
      );
    }
    return token;
  }

  function clearCredentials() {
    token = null;
    pendingPermit = null;
  }

  async function request(
    method,
    path,
    body,
    authenticated = true
  ) {
    const currentToken = requireToken();
    if (body !== undefined) assertBatchSize(body);
    const headers = {
      accept: "application/json",
      ...(body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...(authenticated
        ? { authorization: `Bearer ${currentToken}` }
        : {})
    };
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined
          ? {}
          : { body: JSON.stringify(body) })
      });
    } catch {
      throw bridgeError(
        "browser_bridge_network_error",
        "浏览器桥接请求失败"
      );
    }
    const payload = await readJson(response);
    if (!response.ok) {
      const code = safeServerCode(
        payload?.error,
        "browser_bridge_http_error"
      );
      if (
        response.status === 401 ||
        TERMINAL_ERROR_CODES.has(code)
      ) {
        clearCredentials();
      }
      throw new JiaoyimaoBrowserBridgeError(
        code,
        safeServerMessage(payload?.message, [
          currentToken
        ]),
        safeRetryAt(payload?.retryAt)
      );
    }
    const safePayload = assertSafeServerPayload(payload);
    if (isTerminalPayload(safePayload)) {
      clearCredentials();
    }
    return safePayload;
  }

  function bridgePath(suffix) {
    return `/api/browser-refresh/${encodedJobId}/${suffix}`;
  }

  async function getWork(input) {
    validateEmptyArgument(input);
    const work = await request("GET", bridgePath("work"));
    if (typeof work.actionPermit === "string") {
      pendingPermit = work.kind === "list"
        ? { kind: "load", value: work.actionPermit }
        : work.kind === "detail"
          ? { kind: "detail", value: work.actionPermit }
          : null;
    } else {
      pendingPermit = null;
    }
    return work;
  }

  async function submitFilterProof(input) {
    const proof = validateFilterProof(input);
    return request("POST", bridgePath("filter-proof"), proof);
  }

  async function submitListBatch(input) {
    const batch = validateListBatch(input);
    return request("POST", bridgePath("list-batches"), batch);
  }

  function takePermit(kind) {
    if (pendingPermit?.kind !== kind) return undefined;
    const value = pendingPermit.value;
    pendingPermit = null;
    return value;
  }

  async function submitLoadEvent(input) {
    const event = validateLoadEvent(input);
    const actionPermit = takePermit("load");
    return request("POST", bridgePath("load-events"), {
      ...event,
      ...(actionPermit ? { actionPermit } : {})
    });
  }

  async function submitDetails(input) {
    const batch = validateDetailBatch(input);
    const actionPermit = takePermit("detail");
    return request("POST", bridgePath("details"), {
      ...batch,
      ...(actionPermit ? { actionPermit } : {})
    });
  }

  async function pause(input) {
    const value = validatePause(input);
    pendingPermit = null;
    return request("POST", bridgePath("pause"), value);
  }

  async function resume(input) {
    validateEmptyArgument(input);
    pendingPermit = null;
    return request("POST", bridgePath("resume"), {});
  }

  async function startCooldown(input) {
    validateEmptyArgument(input);
    pendingPermit = null;
    return request(
      "POST",
      bridgePath("cooldown"),
      { reason: "rate_limited" }
    );
  }

  async function complete(input) {
    validateEmptyArgument(input);
    try {
      return await request(
        "POST",
        bridgePath("complete"),
        {}
      );
    } finally {
      clearCredentials();
    }
  }

  async function cancel(input) {
    validateEmptyArgument(input);
    try {
      return await request(
        "POST",
        `/api/sources/jiaoyimao/browser-refresh/` +
          `${encodedJobId}/cancel`,
        {},
        false
      );
    } finally {
      clearCredentials();
    }
  }

  async function waitUntilAllowed(
    work,
    now = Date.now,
    wait = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds))
  ) {
    assertNoForbiddenFields(work);
    if (!isPlainObject(work)) throw bridgeError();
    if (typeof wait !== "function") throw bridgeError();
    const current = typeof now === "function"
      ? now()
      : now instanceof Date
        ? now.getTime()
        : now;
    if (!Number.isFinite(current)) throw bridgeError();
    const deadlines = [
      work.nextActionAt,
      work.cooldownUntil
    ].filter((value) => value !== null && value !== undefined)
      .map((value) => Date.parse(assertIsoTimestamp(value)));
    const delay = Math.max(
      0,
      (deadlines.length > 0 ? Math.max(...deadlines) : current) -
        current
    );
    if (delay > 0) await wait(delay);
    return delay;
  }

  return Object.freeze({
    getWork,
    submitFilterProof,
    submitListBatch,
    submitLoadEvent,
    submitDetails,
    pause,
    resume,
    startCooldown,
    waitUntilAllowed,
    complete,
    cancel
  });
}
