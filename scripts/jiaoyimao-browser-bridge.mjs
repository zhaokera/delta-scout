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
const JOB_STATES = new Set([
  "awaiting_codex",
  "collecting_list",
  "collecting_details",
  "awaiting_user_verification",
  "cooling_down",
  "validating",
  "committing",
  "success",
  "quarantined",
  "paused",
  "failed",
  "cancelled",
  "expired"
]);
const TERMINAL_ERROR_CODES = new Set([
  "bridge_unauthorized",
  "browser_job_not_found",
  "browser_job_expired"
]);
const INVALID_PERMIT_ERROR_CODES = new Set([
  "action_permit_invalid"
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
  "requestheaders",
  "actionpermit",
  "claimcode",
  "bridgetoken",
  "credential",
  "credentials",
  "secret",
  "secrets"
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
  /<\/?[A-Za-z][A-Za-z0-9:-]*[^>]*>/i,
  /<!(?:--|doctype\b|\[CDATA\[)/i
];
const FILTER_ORIGIN = "https://www.jiaoyimao.com";
const FILTER_PATHS = new Set([
  "/jg2007840/f8845003-c8845004/o110/",
  "/jg2007840/f8845003-c8845004/o1687157900084320/"
]);
const DETAIL_PATH = /^\/jg2007840\/(\d+)\.html$/;
const ISO_OFFSET_DATETIME =
  /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))$/;

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
  try {
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype === null) return true;
    if (Reflect.getPrototypeOf(prototype) !== null) return false;
    const constructor = Reflect.getOwnPropertyDescriptor(
      prototype,
      "constructor"
    )?.value;
    return (
      typeof constructor === "function" &&
      constructor.prototype === prototype &&
      Function.prototype.toString.call(constructor) ===
        Function.prototype.toString.call(Object)
    );
  } catch {
    return false;
  }
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

function sensitiveValues(value, seen = new WeakSet(), found = []) {
  if (value === null || typeof value !== "object") return found;
  if (seen.has(value)) return found;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) sensitiveValues(item, seen, found);
    return found;
  }
  if (!isPlainObject(value)) return found;
  for (const [key, nested] of Object.entries(value)) {
    if (
      FORBIDDEN_FIELD_NAMES.has(normalizedFieldName(key)) &&
      typeof nested === "string" &&
      nested.length > 0
    ) {
      found.push(nested);
    }
    sensitiveValues(nested, seen, found);
  }
  return found;
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
  if (!ISO_OFFSET_DATETIME.test(timestamp)) {
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
  const filterUrl = parseApprovedUrl(proof.currentUrl);
  if (!FILTER_PATHS.has(filterUrl.pathname)) throw bridgeError();
  assertSafeText(proof.gameLabel, 1, 100);
  assertSafeText(proof.platformLabel, 1, 100);
  assertSafeText(proof.categoryLabel, 1, 100);
  if (
    !Array.isArray(proof.m7FilterLabels) ||
    proof.m7FilterLabels.length < 5 ||
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

function extractWorkPayload(value) {
  if (!isPlainObject(value)) throw invalidServerResponse();
  const actionPermit = value.actionPermit;
  delete value.actionPermit;
  const payload = assertSafeServerPayload(value);
  validateServerShape(() => {
    if (actionPermit !== undefined) {
      assertString(actionPermit, 1, 128);
    }
  });
  return { payload, actionPermit };
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
    url.protocol !== "http:" ||
    !new Set(["127.0.0.1", "localhost", "[::1]"]).has(
      url.hostname
    ) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw bridgeError();
  }
  return url.toString().replace(/\/$/, "");
}

function validateClaimOptions(options) {
  if (!isPlainObject(options)) throw bridgeError();
  const value = options;
  const allowed = new Set([
    "jobId",
    "claimCode",
    "baseUrl",
    "fetch"
  ]);
  if (
    !("jobId" in value) ||
    !("claimCode" in value) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw bridgeError();
  }
  for (const [key, nested] of Object.entries(value)) {
    if (key !== "claimCode") assertNoForbiddenFields(nested);
  }
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

function invalidServerResponse() {
  return bridgeError(
    "invalid_server_response",
    "浏览器桥接响应格式无效"
  );
}

function validateServerShape(check) {
  try {
    check();
  } catch {
    throw invalidServerResponse();
  }
}

function assertNullableIsoTimestamp(value) {
  if (value !== null) assertIsoTimestamp(value);
}

function validateWorkResponse(value, actionPermitAvailable) {
  if (!isPlainObject(value)) {
    throw invalidServerResponse();
  }
  validateServerShape(() => {
    if (!["list", "detail", "validating"].includes(value.kind)) {
      throw bridgeError();
    }
    assertNullableIsoTimestamp(value.nextActionAt);
    assertNullableIsoTimestamp(value.cooldownUntil);
    if (value.state !== undefined && !JOB_STATES.has(value.state)) {
      throw bridgeError();
    }
    if (value.kind === "list") {
      assertInteger(value.nextListBatchSequence, 1, MAX_UNIQUE_ITEMS);
      assertInteger(value.nextLoadSequence, 1, MAX_LOAD_EVENTS);
    } else if (value.kind === "detail") {
      assertString(value.sourceListingId, 1, 100);
      parseApprovedUrl(value.url);
      assertInteger(value.nextDetailSequence, 1, MAX_UNIQUE_ITEMS);
    }
  });
  return {
    kind: value.kind,
    nextActionAt: value.nextActionAt,
    cooldownUntil: value.cooldownUntil,
    actionPermitAvailable,
    ...(value.state === undefined ? {} : { state: value.state }),
    ...(value.kind === "list"
      ? {
          nextListBatchSequence: value.nextListBatchSequence,
          nextLoadSequence: value.nextLoadSequence
        }
      : value.kind === "detail"
        ? {
            sourceListingId: value.sourceListingId,
            url: value.url,
            nextDetailSequence: value.nextDetailSequence
          }
        : {})
  };
}

function validateJobResponse(value, expectedState) {
  validateServerShape(() => {
    if (
      !isPlainObject(value) ||
      !JOB_STATES.has(value.state) ||
      (expectedState !== undefined && value.state !== expectedState)
    ) {
      throw bridgeError();
    }
  });
  validateServerShape(() => {
    if (value.nextActionAt !== undefined) {
      assertNullableIsoTimestamp(value.nextActionAt);
    }
    if (value.cooldownUntil !== undefined) {
      assertNullableIsoTimestamp(value.cooldownUntil);
    }
  });
  return {
    state: value.state,
    ...(value.nextActionAt === undefined
      ? {}
      : { nextActionAt: value.nextActionAt }),
    ...(value.cooldownUntil === undefined
      ? {}
      : { cooldownUntil: value.cooldownUntil })
  };
}

function validateClaimResponse(value, expectedJobId) {
  validateServerShape(() => {
    if (
      !isPlainObject(value) ||
      value.id !== expectedJobId ||
      !JOB_STATES.has(value.state)
    ) {
      throw bridgeError();
    }
  });
  return value;
}

function validateListResponse(value) {
  validateServerShape(() => {
    if (!isPlainObject(value)) throw bridgeError();
    assertInteger(value.acceptedCount, 1, MAX_LIST_ITEMS);
    assertInteger(value.uniqueItemCount, 0, MAX_UNIQUE_ITEMS);
    assertInteger(
      value.nextSequence,
      1,
      MAX_UNIQUE_ITEMS + 1
    );
  });
  return {
    acceptedCount: value.acceptedCount,
    uniqueItemCount: value.uniqueItemCount,
    nextSequence: value.nextSequence
  };
}

function validateLoadResponse(value) {
  validateServerShape(() => {
    if (!isPlainObject(value) || value.acceptedCount !== 1) {
      throw bridgeError();
    }
    assertInteger(value.loadActionCount, 1, MAX_LOAD_EVENTS);
    assertInteger(value.nextSequence, 1, MAX_LOAD_EVENTS + 1);
  });
  return {
    acceptedCount: value.acceptedCount,
    loadActionCount: value.loadActionCount,
    nextSequence: value.nextSequence
  };
}

function validateDetailResponse(value) {
  validateServerShape(() => {
    if (!isPlainObject(value)) throw bridgeError();
    assertInteger(value.acceptedCount, 1, MAX_DETAIL_ITEMS);
    assertInteger(
      value.detailCompletedCount,
      0,
      MAX_UNIQUE_ITEMS
    );
    assertInteger(
      value.detailRequiredCount,
      0,
      MAX_UNIQUE_ITEMS
    );
    if (
      value.nextSourceListingId !== null &&
      (
        typeof value.nextSourceListingId !== "string" ||
        !/^\d+$/.test(value.nextSourceListingId)
      )
    ) {
      throw bridgeError();
    }
    assertInteger(
      value.nextSequence,
      1,
      MAX_UNIQUE_ITEMS + 1
    );
  });
  return {
    acceptedCount: value.acceptedCount,
    detailCompletedCount: value.detailCompletedCount,
    detailRequiredCount: value.detailRequiredCount,
    nextSourceListingId: value.nextSourceListingId,
    nextSequence: value.nextSequence
  };
}

function validateCompletionResponse(value) {
  validateServerShape(() => {
    if (
      !isPlainObject(value) ||
      !["success", "quarantined"].includes(value.state)
    ) {
      throw bridgeError();
    }
    assertInteger(value.scanRunId, 1, Number.MAX_SAFE_INTEGER);
    if (value.publishedRunId !== null) {
      assertInteger(
        value.publishedRunId,
        1,
        Number.MAX_SAFE_INTEGER
      );
    }
  });
  return {
    state: value.state,
    scanRunId: value.scanRunId,
    publishedRunId: value.publishedRunId
  };
}

function waitAbortError() {
  return bridgeError(
    "browser_wait_aborted",
    "浏览器等待已取消"
  );
}

function assertAbortSignal(value) {
  if (value === undefined) return;
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.aborted !== "boolean" ||
    typeof value.addEventListener !== "function" ||
    typeof value.removeEventListener !== "function"
  ) {
    throw bridgeError();
  }
}

function abortableDelay(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(waitAbortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    function onAbort() {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(waitAbortError());
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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
      safeServerMessage(claimPayload?.message, [
        claimed.claimCode,
        ...sensitiveValues(claimPayload)
      ]),
      safeRetryAt(claimPayload?.retryAt)
    );
  }
  const claimedToken = claimPayload?.bridgeToken;
  if (isPlainObject(claimPayload)) {
    delete claimPayload.bridgeToken;
  }
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
  assertSafeServerPayload(claimPayload);
  validateClaimResponse(claimPayload, claimed.jobId);

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
    authenticated = true,
    onConfirmedSuccess,
    responseKind = "standard"
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
      const responseSecrets = [
        claimed.claimCode,
        currentToken,
        pendingPermit?.value,
        ...sensitiveValues(payload)
      ];
      if (
        response.status === 401 ||
        TERMINAL_ERROR_CODES.has(code) ||
        isTerminalPayload(payload)
      ) {
        clearCredentials();
      }
      throw new JiaoyimaoBrowserBridgeError(
        code,
        safeServerMessage(payload?.message, responseSecrets),
        safeRetryAt(payload?.retryAt)
      );
    }
    onConfirmedSuccess?.();
    if (responseKind === "work") {
      return extractWorkPayload(payload);
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
    const internalWork = await request(
      "GET",
      bridgePath("work"),
      undefined,
      true,
      undefined,
      "work"
    );
    const work = validateWorkResponse(
      internalWork.payload,
      internalWork.actionPermit !== undefined
    );
    if (typeof internalWork.actionPermit === "string") {
      pendingPermit = work.kind === "list"
        ? { kind: "load", value: internalWork.actionPermit }
        : work.kind === "detail"
          ? { kind: "detail", value: internalWork.actionPermit }
          : null;
    } else {
      pendingPermit = null;
    }
    return work;
  }

  async function submitFilterProof(input) {
    const proof = validateFilterProof(input);
    return validateJobResponse(
      await request("POST", bridgePath("filter-proof"), proof)
    );
  }

  async function submitListBatch(input) {
    const batch = validateListBatch(input);
    return validateListResponse(
      await request("POST", bridgePath("list-batches"), batch)
    );
  }

  function matchingPermit(kind) {
    return pendingPermit?.kind === kind
      ? pendingPermit
      : null;
  }

  function clearMatchingPermit(permit) {
    if (permit !== null && pendingPermit === permit) {
      pendingPermit = null;
    }
  }

  async function submitOutcome(kind, path, payload) {
    const permit = matchingPermit(kind);
    try {
      return await request(
        "POST",
        path,
        {
          ...payload,
          ...(permit ? { actionPermit: permit.value } : {})
        },
        true,
        () => clearMatchingPermit(permit)
      );
    } catch (error) {
      if (INVALID_PERMIT_ERROR_CODES.has(error?.code)) {
        clearMatchingPermit(permit);
      }
      throw error;
    }
  }

  async function submitLoadEvent(input) {
    const event = validateLoadEvent(input);
    return validateLoadResponse(
      await submitOutcome(
        "load",
        bridgePath("load-events"),
        event
      )
    );
  }

  async function submitDetails(input) {
    const batch = validateDetailBatch(input);
    return validateDetailResponse(
      await submitOutcome(
        "detail",
        bridgePath("details"),
        batch
      )
    );
  }

  async function pause(input) {
    const value = validatePause(input);
    return validateJobResponse(
      await request(
        "POST",
        bridgePath("pause"),
        value,
        true,
        () => {
          pendingPermit = null;
        }
      )
    );
  }

  async function resume(input) {
    validateEmptyArgument(input);
    return validateJobResponse(
      await request(
        "POST",
        bridgePath("resume"),
        {},
        true,
        () => {
          pendingPermit = null;
        }
      )
    );
  }

  async function startCooldown(input) {
    validateEmptyArgument(input);
    return validateJobResponse(
      await request(
        "POST",
        bridgePath("cooldown"),
        { reason: "rate_limited" },
        true,
        () => {
          pendingPermit = null;
        }
      )
    );
  }

  async function complete(input) {
    validateEmptyArgument(input);
    return validateCompletionResponse(
      await request(
        "POST",
        bridgePath("complete"),
        {},
        true,
        clearCredentials
      )
    );
  }

  async function cancel(input) {
    validateEmptyArgument(input);
    return validateJobResponse(
      await request(
        "POST",
        `/api/sources/jiaoyimao/browser-refresh/` +
          `${encodedJobId}/cancel`,
        {},
        false,
        clearCredentials
      ),
      "cancelled"
    );
  }

  async function waitUntilAllowed(
    work,
    now = Date.now,
    wait = abortableDelay,
    signal
  ) {
    assertNoForbiddenFields(work);
    if (!isPlainObject(work)) throw bridgeError();
    if (typeof wait !== "function") throw bridgeError();
    assertAbortSignal(signal);
    if (signal?.aborted) throw waitAbortError();
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
    if (delay > 0) {
      try {
        await wait(delay, signal);
      } catch (error) {
        if (signal?.aborted) throw waitAbortError();
        throw error;
      }
    }
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
