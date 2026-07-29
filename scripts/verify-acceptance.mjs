import assert from "node:assert/strict";

const baseUrl = (process.argv[2] ?? "http://127.0.0.1:4410").replace(
  /\/+$/,
  ""
);

async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { accept: "application/json" }
  });
  const body = await response.json().catch(() => null);
  assert.equal(
    response.ok,
    true,
    `${path} returned ${response.status}: ${JSON.stringify(body)}`
  );
  return body;
}

function assertCandidate(candidate, poolName) {
  assert.equal(candidate.loginPlatform, "qq", `${poolName}: non-QQ candidate`);
  assert.equal(candidate.service, "official", `${poolName}: non-official candidate`);
  assert.equal(
    typeof candidate.priceCny,
    "number",
    `${poolName}: candidate price is unknown`
  );
  assert.ok(
    candidate.priceCny <= 6_000,
    `${poolName}: candidate exceeds budget`
  );
  assert.equal(
    candidate.m7PrismStatus,
    "peak",
    `${poolName}: candidate lacks peak M7 evidence`
  );
}

function assertUniqueKeys(listings, poolName) {
  const keys = listings.map(({ key }) => key);
  assert.equal(
    new Set(keys).size,
    keys.length,
    `${poolName}: duplicate listing keys`
  );
}

function contributionBySource(listings) {
  const counts = new Map([
    ["jiaoyimao", 0],
    ["panzhi", 0],
    ["pxb7", 0]
  ]);
  for (const listing of listings) {
    counts.set(listing.source, (counts.get(listing.source) ?? 0) + 1);
  }
  return counts;
}

function assertSourceCounts(statuses, listings, mode) {
  const contributions = contributionBySource(listings);
  assert.equal(statuses.length, 3, `${mode}: expected three source statuses`);
  for (const status of statuses) {
    assert.equal(
      status.candidateCount,
      contributions.get(status.source) ?? 0,
      `${mode}: ${status.source} candidateCount mismatch`
    );
  }
  return Object.fromEntries(contributions);
}

const [
  balanced,
  global,
  balancedSources,
  globalSources,
  history,
  refreshStatus
] = await Promise.all([
  getJson("/api/listings?mode=balanced"),
  getJson("/api/listings?mode=global"),
  getJson("/api/sources?mode=balanced"),
  getJson("/api/sources?mode=global"),
  getJson("/api/scan-history?limit=2"),
  getJson("/api/refresh-status")
]);

assert.ok(Array.isArray(balanced), "balanced response must be an array");
assert.ok(Array.isArray(global), "global response must be an array");
assert.ok(balanced.length <= 30, "balanced pool exceeds 30");
assert.ok(global.length <= 30, "global pool exceeds 30");
assertUniqueKeys(balanced, "balanced");
assertUniqueKeys(global, "global");
balanced.forEach((candidate) => assertCandidate(candidate, "balanced"));
global.forEach((candidate) => assertCandidate(candidate, "global"));

const balancedCounts = contributionBySource(balanced);
for (const [source, count] of balancedCounts) {
  assert.ok(count <= 10, `balanced: ${source} exceeds platform quota`);
}

const balancedContributions = assertSourceCounts(
  balancedSources,
  balanced,
  "balanced"
);
const globalContributions = assertSourceCounts(
  globalSources,
  global,
  "global"
);

assert.ok(
  ["success", "partial", "failed"].includes(refreshStatus.state),
  `refresh status is not terminal: ${refreshStatus.state}`
);
assert.ok(
  Array.isArray(history.runs) && history.runs.length > 0,
  "scan history does not include the acceptance run"
);
const currentRun = history.runs.find(({ id }) => id === refreshStatus.runId);
assert.ok(currentRun, "scan history does not contain refresh-status runId");
assert.equal(
  currentRun.state,
  refreshStatus.state,
  "history and refresh status disagree"
);

console.log(
  JSON.stringify(
    {
      balanced: {
        count: balanced.length,
        contributions: balancedContributions
      },
      global: {
        count: global.length,
        contributions: globalContributions
      },
      run: {
        id: currentRun.id,
        state: currentRun.state
      }
    },
    null,
    2
  )
);
console.log("acceptance ok");
