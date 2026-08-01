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
    candidate.priceCny >= 1_900,
    `${poolName}: candidate is below the configured price floor`
  );
  assert.ok(
    candidate.priceCny <= 4_000,
    `${poolName}: candidate exceeds budget`
  );
  assert.equal(
    candidate.requiredRedSkinStatus,
    "complete",
    `${poolName}: required operator skins are not fully proven`
  );
  assert.deepEqual(
    [...candidate.requiredRedSkins].sort(),
    ["露娜-黑天际线", "骇爪-维什戴尔"].sort(),
    `${poolName}: required operator skin set is incomplete`
  );
  assert.ok(candidate.score, `${poolName}: candidate is missing a score`);
  for (const field of ["total", "value", "safety", "dataQuality"]) {
    assert.equal(
      typeof candidate.score[field],
      "number",
      `${poolName}: score.${field} is missing`
    );
    assert.ok(
      candidate.score[field] >= 0 && candidate.score[field] <= 100,
      `${poolName}: score.${field} is outside 0..100`
    );
  }
  assert.ok(
    ["low", "medium", "high", "unknown"].includes(
      candidate.score.riskLevel
    ),
    `${poolName}: invalid risk level`
  );
  const baseTotal = Math.round(
    candidate.score.value * 0.55 +
      candidate.score.safety * 0.35 +
      candidate.score.dataQuality * 0.1
  );
  assert.ok(
    Number.isInteger(candidate.score.preferenceAdjustment) &&
      candidate.score.preferenceAdjustment >= -8 &&
      candidate.score.preferenceAdjustment <= 0,
    `${poolName}: invalid preference adjustment`
  );
  assert.equal(
    candidate.score.total,
    Math.max(0, baseTotal + candidate.score.preferenceAdjustment),
    `${poolName}: overall score formula mismatch`
  );
  for (const [part, maximum] of Object.entries({
    m7: 15,
    redSkins: 30,
    julang: 20,
    price: 25,
    assets: 10
  })) {
    assert.equal(
      typeof candidate.score.parts[part],
      "number",
      `${poolName}: score.parts.${part} is missing`
    );
    assert.ok(
      candidate.score.parts[part] >= 0 &&
        candidate.score.parts[part] <= maximum,
      `${poolName}: score.parts.${part} exceeds ${maximum}`
    );
  }
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
    assert.ok(
      status.anomaly &&
        ["clear", "suspect"].includes(status.anomaly.state),
      `${mode}: ${status.source} anomaly status is missing`
    );
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
for (const source of currentRun.sources) {
  assert.equal(
    typeof source.published,
    "boolean",
    `${source.source}: scan history published flag is missing`
  );
  assert.equal(
    typeof source.anomalyState,
    "string",
    `${source.source}: scan history anomaly state is missing`
  );
}

const historyCandidate = global[0] ?? balanced[0] ?? null;
let listingHistory = null;
if (historyCandidate) {
  listingHistory = await getJson(
    `/api/listings/${encodeURIComponent(historyCandidate.key)}/history?limit=20`
  );
  assert.equal(
    listingHistory.key,
    historyCandidate.key,
    "listing history key mismatch"
  );
  assert.ok(
    ["active", "removed", "unknown"].includes(listingHistory.availability),
    "listing history availability is invalid"
  );
  assert.ok(
    Array.isArray(listingHistory.observations),
    "listing history observations must be an array"
  );
}

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
        state: currentRun.state,
        sources: currentRun.sources.map((source) => ({
          source: source.source,
          state: source.state,
          observed: source.observedItemCount,
          pages: source.pagesScanned,
          anomaly: source.anomalyState,
          published: source.published
        }))
      },
      history: listingHistory
        ? {
            key: listingHistory.key,
            availability: listingHistory.availability,
            observations: listingHistory.observations.length
          }
        : null
    },
    null,
    2
  )
);
console.log("acceptance ok");
