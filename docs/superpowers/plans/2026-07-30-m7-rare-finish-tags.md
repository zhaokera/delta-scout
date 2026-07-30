# M7 Rare Finish Tags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect trustworthy 珠光、炫彩、糖果 M7 finish evidence, persist and display the tags, and fold one non-stacking 8-point bonus into the existing M7 value score before refreshing all three marketplaces.

**Architecture:** Add backward-compatible fields to the existing Listing JSON model and a pure evidence parser that assigns each keyword to its nearest weapon/item subject inside one bounded clause. The collector populates those fields only from fresh source evidence, scoring keeps the existing `parts.m7 / 35` contract by combining quality `/27` and finish `/8`, and history/fingerprints normalize legacy empty values. React list/detail components render the structured tags and supporting evidence without treating them as purchase-safety signals.

**Tech Stack:** TypeScript 7, Zod 4, Vitest 4, React 19, Testing Library, Express, SQLite, Vite

---

## File map

- `src/domain/listing.ts` — M7 rare-finish enum and backward-compatible Listing fields.
- `src/domain/evidence.ts` — pure nearest-subject/negation-aware rare-finish parser.
- `src/domain/score.ts` — quality `/27` plus one `/8` finish bonus inside existing `parts.m7`.
- `src/domain/listingHistory.ts` — normalized history snapshot field and legacy snapshot migration.
- `src/domain/listingFingerprint.ts` — material hash that includes only non-empty rare-finish tags.
- `src/server/collector/coordinator.ts` — invokes parser after merged summary/detail evidence.
- `src/server/repository.ts` — normalizes old `snapshot_json` before comparison and API output.
- `src/client/components/ListingTable.tsx` — compact high-value M7 tags in each row.
- `src/client/components/ListingDetail.tsx` — tags, bounded source evidence, and `M7 综合价值 /35`.
- `src/client/styles.css` — accessible tags and detail evidence styling.
- `tests/domain/listingFactory.ts` — canonical defaults for new Listing fields.
- `tests/domain/listing.test.ts` — schema acceptance and legacy defaults.
- `tests/domain/evidence.test.ts` — positive, nearest-subject, boundary, distance, and negation cases.
- `tests/domain/score.test.ts` — 27+8 scoring, non-stacking, unchanged safety.
- `tests/domain/listingHistory.test.ts` — history labels, ordering, and old empty snapshot compatibility.
- `tests/domain/listingFingerprint.test.ts` — no global false change for empty tags; intended non-empty change.
- `tests/server/coordinator.test.ts` — end-to-end extraction from combined collector evidence.
- `tests/server/repository.test.ts` — legacy history JSON normalization at persistence boundaries.
- `tests/client/ListingTable.test.tsx` — visible list tags and no fabricated tag.
- `tests/client/ListingDetail.test.tsx` — detail tags/evidence and combined score label.

## Task 1: Add the backward-compatible model and pure parser

**Files:**
- Modify: `tests/domain/listingFactory.ts`
- Modify: `tests/domain/listing.test.ts`
- Modify: `tests/domain/evidence.test.ts`
- Modify: `src/domain/listing.ts`
- Modify: `src/domain/evidence.ts`
- Modify: `src/server/collector/coordinator.ts`

- [ ] **Step 1: Write schema tests before changing production code**

Add `m7RareFinishes` and `m7RareFinishEvidence` to `validListing`, then add assertions that:

```ts
expect(ListingSchema.parse({
  ...validListing,
  m7RareFinishes: ["pearl", "iridescent", "candy"],
  m7RareFinishEvidence: [{ text: "珠光粉M7", truncated: false }]
})).toMatchObject({
  m7RareFinishes: ["pearl", "iridescent", "candy"]
});

const {
  m7RareFinishes: _legacyFinishes,
  m7RareFinishEvidence: _legacyFinishEvidence,
  ...legacy
} = validListing;
expect(ListingSchema.parse(legacy)).toMatchObject({
  m7RareFinishes: [],
  m7RareFinishEvidence: []
});
```

- [ ] **Step 2: Run the schema test and observe the expected RED failure**

Run:

```bash
pnpm vitest run tests/domain/listing.test.ts
```

Expected: FAIL because `ListingSchema` strips or does not define the new fields.

- [ ] **Step 3: Add the minimal Listing schema**

In `src/domain/listing.ts` export:

```ts
export const M7RareFinishSchema = z.enum([
  "pearl",
  "iridescent",
  "candy"
]);
export type M7RareFinish = z.infer<typeof M7RareFinishSchema>;
```

Add these defaults directly after `m7Evidence`:

```ts
m7RareFinishes: z.array(M7RareFinishSchema).default([]),
m7RareFinishEvidence: z.array(EvidenceRecordSchema).default([]),
```

Update `makeListing()` with explicit empty arrays so new test fixtures represent fresh normalized data.

Because Zod defaults are optional only at the input boundary while the
`Listing` output type remains explicit, also add the following compile-safe
placeholder to `buildListing()` in `src/server/collector/coordinator.ts`:

```ts
m7RareFinishes: [],
m7RareFinishEvidence: [],
```

Task 2 replaces those fresh-Listing placeholders with parsed values. This
keeps every intermediate commit type-safe without assigning tags to retained
blocked-source snapshots.

- [ ] **Step 4: Re-run the schema test and observe GREEN**

Run:

```bash
pnpm vitest run tests/domain/listing.test.ts && pnpm typecheck
```

Expected: schema test and both TypeScript projects PASS.

- [ ] **Step 5: Write parser tests before the parser**

Import the wished-for `parseM7RareFinishes` and cover:

```ts
it.each([
  ["市场价5万+三角券的珠光粉M7", ["pearl"]],
  ["极品炫彩镭射M7", ["iridescent"]],
  ["M7的局内表现效果很好炫彩渐变", ["iridescent"]],
  ["M7极品A 400发AWM子弹 7000点券 全炫彩", ["iridescent"]],
  ["M7战斗步枪-棱镜攻势S2极品A 全炫彩", ["iridescent"]],
  ["棱镜攻势M7—极品B糖果纸", ["candy"]],
  ["白灯糖果纸m7，珠光粉M7，全炫彩M7", ["pearl", "iridescent", "candy"]]
])("extracts rare M7 finishes from %s", (text, finishes) => {
  expect(parseM7RareFinishes(toEvidenceRecords([text])).finishes)
    .toEqual(finishes);
});
```

Add conservative negatives:

```ts
it.each([
  "XM7炫彩",
  "M7无炫彩",
  "M7不带珠光",
  "不是糖果纸M7",
  "极品M7说明文字炫彩MP7",
  "M7说明文字巨浪是蓝紫粉炫彩",
  "M7说明文字AUG珠光",
  "有三个赛季的炫彩3×3",
  "炫彩挂饰",
  `M7${"普通说明".repeat(10)}珠光`,
  "M7普通说明，珠光挂饰"
])("does not misassign %s", (text) => {
  expect(parseM7RareFinishes(toEvidenceRecords([text])).finishes)
    .toEqual([]);
});
```

Also assert:

- keyword before and after M7 both work;
- duplicated tags are de-duplicated in fixed `pearl → iridescent → candy` order;
- evidence contains only records that support at least one returned tag;
- a tie between M7 and another subject is skipped;
- slash/comma/newline clause boundaries prevent cross-clause pairing.
- a malformed record whose `text` getter throws returns no finishes/evidence,
  leaves the caller-owned input array intact, and does not throw through the
  collector.

- [ ] **Step 6: Run the parser tests and observe the expected RED failure**

Run:

```bash
pnpm vitest run tests/domain/evidence.test.ts
```

Expected: FAIL at module/type checking because `parseM7RareFinishes` does not exist.

- [ ] **Step 7: Implement the smallest pure parser that satisfies the cases**

Keep clause splitting in `src/domain/evidence.ts` as the common boundary. Add:

```ts
const M7_RARE_FINISHES = [
  { finish: "pearl", pattern: /珠光/g },
  { finish: "iridescent", pattern: /炫彩/g },
  { finish: "candy", pattern: /糖果(?:纸)?/g }
] as const;
const M7_TOKEN = /(?<![A-Za-z0-9])M7(?![A-Za-z0-9])/gi;
const NAMED_OTHER_SUBJECT =
  /巨浪|MP7|AUG|KC17|K416|M250|腾龙|挂饰|3[×xX*]3|(?<!\d)33(?!\d)|收藏品|手办/gi;
const GENERIC_MODEL = /(?<![A-Za-z0-9])(?=[A-Z0-9-]{2,12}(?![A-Za-z0-9]))(?=[A-Z0-9-]*[A-Z])(?=[A-Z0-9-]*\d)[A-Z][A-Z0-9-]{1,11}(?![A-Za-z0-9])/gi;
const NEGATION = /无|非|不是|不带|没有|未有|不含/;
```

Implementation rules:

1. Keep the original clause text and character offsets for all matching. Never
   remove whitespace before subject recognition: `A 400发` must not become a
   fabricated model token `A400`. Use a helper that counts non-whitespace
   characters only when calculating visible edge-to-edge distance.
2. Collect M7 and other-subject ranges; de-duplicate equal generic/named ranges.
   If `GENERIC_MODEL` matches exact token `M7`, discard that generic match
   because the dedicated M7 token owns the range. For any other identical
   range, merge it once and preserve the explicitly named subject type.
   Also discard a generic `S2` match when the immediately preceding local
   context identifies the same M7 skin name (`棱镜攻势S2` or
   `M7战斗步枪-棱镜攻势S2`); season suffixes are attributes, not competing
   weapon subjects.
3. For each keyword, consider subjects with edge-to-edge distance at most 24.
4. Compute the nearest distance on both sides. Skip no-subject, non-M7, or tied-subject cases.
5. Check the four visible characters before the keyword and the span between the chosen M7 and keyword for `NEGATION`.
6. Record the finish and original `EvidenceRecord`; sort finishes by the fixed enum order and de-duplicate evidence by text.
7. Do not consult M7 status, price, title metadata, score, or any other listing.

Put the record/clause loop behind a narrow public safety wrapper:

```ts
export function parseM7RareFinishes(records: EvidenceRecord[]) {
  try {
    return parseM7RareFinishesUnsafe(records);
  } catch {
    return { finishes: [], evidence: [] };
  }
}
```

This is the required single-Listing isolation boundary: unexpected parser
input cannot fail the source refresh. The collector's existing
`Listing.evidence` still preserves the original record for manual inspection;
`m7RareFinishEvidence` remains empty because it must contain only supporting
evidence.

- [ ] **Step 8: Run parser and schema tests and observe GREEN**

Run:

```bash
pnpm vitest run tests/domain/evidence.test.ts tests/domain/listing.test.ts \
  tests/server/coordinator.test.ts && pnpm typecheck
```

Expected: tests and both TypeScript projects PASS.

- [ ] **Step 9: Commit the model and parser**

```bash
git add src/domain/listing.ts src/domain/evidence.ts \
  src/server/collector/coordinator.ts \
  tests/domain/listingFactory.ts tests/domain/listing.test.ts \
  tests/domain/evidence.test.ts
git commit -m "feat: parse high-value M7 finishes"
```

## Task 2: Populate tags from fresh collector evidence

**Files:**
- Modify: `tests/server/coordinator.test.ts`
- Modify: `src/server/collector/coordinator.ts`

- [ ] **Step 1: Add a failing collector integration test**

Use the existing fake adapter/fetcher harness. Return one summary/detail whose merged evidence includes:

```text
M7战斗步枪-棱镜攻势S2(极品A)
市场价5万+三角券的珠光粉M7
极品M7说明文字炫彩MP7
```

Assert the stored listing has:

```ts
expect(listing).toMatchObject({
  m7RareFinishes: ["pearl"],
  m7RareFinishEvidence: [
    expect.objectContaining({ text: expect.stringContaining("珠光粉M7") })
  ]
});
```

Also assert the MP7 false positive is not present.

- [ ] **Step 2: Run the coordinator test and observe RED**

Run:

```bash
pnpm vitest run tests/server/coordinator.test.ts -t "M7 rare finish"
```

Expected: FAIL because `buildListing()` still returns empty/default fields.

- [ ] **Step 3: Wire the parser into `buildListing()`**

Import `parseM7RareFinishes`, call it after merged `evidence` is formed, and assign:

```ts
m7RareFinishes: rareM7.finishes,
m7RareFinishEvidence: rareM7.evidence,
```

Do not add tags while retaining a blocked source: blocked sources reuse already stored Listings and never call `buildListing()`.
The parser's public safety wrapper from Task 1 returns empty tags plus original
evidence on unexpected input, so no parser exception can fail the source.

- [ ] **Step 4: Re-run coordinator and domain tests and observe GREEN**

Run:

```bash
pnpm vitest run tests/server/coordinator.test.ts \
  tests/domain/evidence.test.ts tests/domain/listing.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit collector integration**

```bash
git add src/server/collector/coordinator.ts tests/server/coordinator.test.ts
git commit -m "feat: collect M7 rare finish evidence"
```

## Task 3: Rebalance the existing M7 score to 27 plus 8

**Files:**
- Modify: `tests/domain/score.test.ts`
- Modify: `src/domain/score.ts`

- [ ] **Step 1: Change score expectations first**

Update the quality table to `S=27`, `A=23`, `B=18`, `C=14`, unknown `0`.

Add tests that one finish adds exactly 8, multiple finishes still add exactly 8, and safety/risk are identical between otherwise equal listings:

```ts
expect(scoreOf({ m7PrismQuality: "A", m7RareFinishes: [] }).parts.m7)
  .toBe(23);
expect(scoreOf({ m7PrismQuality: "A", m7RareFinishes: ["pearl"] }).parts.m7)
  .toBe(31);
expect(scoreOf({
  m7PrismQuality: "S",
  m7RareFinishes: ["pearl", "iridescent", "candy"]
}).parts.m7).toBe(35);
```

Assert value reasons contain separate `/27` and `/8` explanations and no `parts.m7RareFinish` property exists.

- [ ] **Step 2: Run the score test and observe RED**

Run:

```bash
pnpm vitest run tests/domain/score.test.ts
```

Expected: FAIL with old 35/29/23/17 values and no finish bonus/reason.

- [ ] **Step 3: Implement minimal combined scoring**

Change:

```ts
const QUALITY_POINTS = { S: 27, A: 23, B: 18, C: 14 } as const;
```

Calculate:

```ts
const m7Quality = listing.m7PrismQuality === null
  ? 0
  : QUALITY_POINTS[listing.m7PrismQuality];
const m7RareFinish = listing.m7RareFinishes.length > 0 ? 8 : 0;
const m7 = Math.min(35, m7Quality + m7RareFinish);
```

Keep `parts.m7 = m7`. Add two value reasons:

```text
M7 极品A，品质价值 23.0/27
M7 稀有模板：珠光 · 糖果，价值 8.0/8
```

For no tag, use `M7 稀有模板待核验，价值 0.0/8`; never claim the account has no rare finish.

- [ ] **Step 4: Re-run score tests and observe GREEN**

Run:

```bash
pnpm vitest run tests/domain/score.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit scoring**

```bash
git add src/domain/score.ts tests/domain/score.test.ts
git commit -m "feat: value rare M7 finishes"
```

## Task 4: Preserve tags in history without fake legacy changes

**Files:**
- Modify: `tests/domain/listingHistory.test.ts`
- Modify: `tests/domain/listingFingerprint.test.ts`
- Modify: `tests/server/repository.test.ts`
- Modify: `tests/client/ListingDetail.test.tsx`
- Modify: `src/domain/listingHistory.ts`
- Modify: `src/domain/listingFingerprint.ts`
- Modify: `src/server/repository.ts`

- [ ] **Step 1: Write history and fingerprint regression tests**

Add assertions that:

- snapshots store finishes in fixed order;
- a legacy snapshot object missing `m7RareFinishes` compares equal to a new empty snapshot;
- a change from empty to `["pearl"]` yields label `M7 稀有模板`, before `待核验`, after `珠光`;
- hash of an old-equivalent empty Listing is unchanged by the new model;
- a non-empty rare-finish list changes the hash;
- finish array order/duplicates do not change the hash.

Export and test a normalization API:

```ts
normalizeListingHistorySnapshot(
  JSON.parse(oldSnapshotJson)
).m7RareFinishes
```

Expected result: `[]`.

- [ ] **Step 2: Add a repository test with legacy `snapshot_json`**

Insert a trusted observation whose JSON lacks `m7RareFinishes`, then:

1. run a trusted scan with an otherwise identical Listing whose finish list is empty;
2. assert no `M7 稀有模板` change appears;
3. query history and assert returned snapshots contain `m7RareFinishes: []`.

- [ ] **Step 3: Run focused tests and observe RED**

Run:

```bash
pnpm vitest run tests/domain/listingHistory.test.ts \
  tests/domain/listingFingerprint.test.ts tests/server/repository.test.ts
```

Expected: FAIL because snapshots and hashes do not yet know the field and repository returns raw legacy JSON.

- [ ] **Step 4: Implement history normalization**

In `listingHistory.ts`:

- add `m7RareFinishes: Listing["m7RareFinishes"]` to the interface;
- add a fixed-order `normalizeM7RareFinishes()` helper;
- include the normalized array in `buildListingHistorySnapshot()`;
- export `normalizeListingHistorySnapshot(value)` that overlays:

```ts
{
  ...(value as ListingHistorySnapshot),
  m7RareFinishes: normalizeM7RareFinishes(
    Array.isArray((value as Partial<ListingHistorySnapshot>).m7RareFinishes)
      ? (value as Partial<ListingHistorySnapshot>).m7RareFinishes!
      : []
  )
}
```

- normalize both `before` and `after` at the start of `diffListingSnapshots()`;
- add label `m7RareFinishes: "M7 稀有模板"` and format empty finish arrays as `待核验`, not `无`;
- map enum values to `珠光 / 炫彩 / 糖果`.

In `repository.ts`, call `normalizeListingHistorySnapshot(JSON.parse(...))` both before diffing and when mapping `getListingHistory()` rows.

Update every hand-written `ListingHistorySnapshot` fixture in
`tests/client/ListingDetail.test.tsx` with `m7RareFinishes: []`. These fixtures
represent normalized API output, so the client type stays explicit even though
the repository accepts old stored JSON without the field.

- [ ] **Step 5: Implement non-empty-only material hashing**

Build the normal existing material object first, then conditionally spread:

```ts
...(listing.m7RareFinishes.length > 0
  ? { m7RareFinishes: normalizeM7RareFinishes(listing.m7RareFinishes) }
  : {})
```

This preserves the exact old material JSON shape and hash when no tag exists, while making a newly discovered tag material.

- [ ] **Step 6: Re-run history/fingerprint/repository tests and observe GREEN**

Run:

```bash
pnpm vitest run tests/domain/listingHistory.test.ts \
  tests/domain/listingFingerprint.test.ts tests/server/repository.test.ts \
  tests/client/ListingDetail.test.tsx && pnpm typecheck
```

Expected: focused tests and both TypeScript projects PASS.

- [ ] **Step 7: Commit persistence compatibility**

```bash
git add src/domain/listingHistory.ts src/domain/listingFingerprint.ts \
  src/server/repository.ts tests/domain/listingHistory.test.ts \
  tests/domain/listingFingerprint.test.ts tests/server/repository.test.ts \
  tests/client/ListingDetail.test.tsx
git commit -m "feat: track M7 finish changes safely"
```

## Task 5: Render high-value tags and supporting evidence

**Files:**
- Modify: `tests/client/ListingTable.test.tsx`
- Modify: `tests/client/ListingDetail.test.tsx`
- Modify: `src/client/components/ListingTable.tsx`
- Modify: `src/client/components/ListingDetail.tsx`
- Modify: `src/client/styles.css`

- [ ] **Step 1: Write list component tests**

Render a listing with all three finishes and assert visible text:

```text
珠光 M7
炫彩 M7
糖果 M7
```

Render the default empty listing and assert none of those tags exists. Keep the existing M7 quality label.

- [ ] **Step 2: Write detail component tests**

For one listing with `["pearl", "candy"]` and matching evidence, assert:

- heading/label `高价值模板`;
- both tags;
- bounded evidence includes the original phrases and highlights `珠光`, `糖果`;
- score part label is `M7 综合价值 31 / 35`;
- the two value-reason rows remain visible.

For an empty finish list assert `稀有模板待核验`, not `没有稀有模板`.

- [ ] **Step 3: Run client tests and observe RED**

Run:

```bash
pnpm vitest run tests/client/ListingTable.test.tsx \
  tests/client/ListingDetail.test.tsx
```

Expected: FAIL because no rare-finish UI exists and the score part still says `M7 品质`.

- [ ] **Step 4: Add accessible UI mappings**

Use one local mapping in each component:

```ts
const M7_RARE_FINISH_LABELS = {
  pearl: "珠光 M7",
  iridescent: "炫彩 M7",
  candy: "糖果 M7"
} as const;
```

In the list row, render a `.m7-finish-tags` container directly below `m7Label()` only when non-empty.

In the detail M7 block:

- add a `高价值模板` sub-label;
- render tags or `稀有模板待核验`;
- render bounded excerpts for each unique supporting evidence record;
- highlight `M7`, `珠光`, `炫彩`, `糖果纸?` without injecting HTML;
- rename score row to `M7 综合价值`.

Do not use safety badge classes and do not claim a monetary value.

- [ ] **Step 5: Add styles**

Add compact, wrapping tag styles using the existing fluorescent palette:

```css
.m7-finish-tags { display: flex; flex-wrap: wrap; gap: .35rem; }
.m7-finish-tag { border: 1px solid var(--acid); /* existing token */ }
```

Use the actual existing CSS variable name after inspecting `:root`; retain readable text contrast and visible focus/selection states. Add detail evidence spacing without changing the four-column table layout.

- [ ] **Step 6: Re-run client tests and observe GREEN**

Run:

```bash
pnpm vitest run tests/client/ListingTable.test.tsx \
  tests/client/ListingDetail.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit UI**

```bash
git add src/client/components/ListingTable.tsx \
  src/client/components/ListingDetail.tsx src/client/styles.css \
  tests/client/ListingTable.test.tsx tests/client/ListingDetail.test.tsx
git commit -m "feat: highlight rare M7 finishes"
```

## Task 6: Verify, refresh all sources, and inspect the ranking

**Files:**
- Modify only if verification finds a tested defect.

- [ ] **Step 1: Run the full automated verification from a clean command**

Run:

```bash
pnpm test && pnpm typecheck && pnpm build
```

Expected: all Vitest suites pass, both TypeScript projects pass, and Vite/server builds exit 0.

- [ ] **Step 2: Restart the persistent local app from this worktree**

Stop only the existing Delta Scout dev session, then use the repository’s established persistent `screen` session pattern to run:

```bash
pnpm dev
```

Verify:

```bash
curl -fsS http://127.0.0.1:4310/api/health
```

Expected: HTTP 200 health JSON.

- [ ] **Step 3: Start one complete three-platform refresh**

Run:

```bash
curl -fsS -X POST http://127.0.0.1:4310/api/refresh
```

Poll `GET /api/refresh-status` until terminal state without starting a second refresh. Preserve and report CAPTCHA/login blocks; never bypass them.

- [ ] **Step 4: Produce source and tag counts from the fresh API**

Read:

```bash
curl -fsS http://127.0.0.1:4310/api/sources
curl -fsS 'http://127.0.0.1:4310/api/listings?view=all&status=eligible'
curl -fsS 'http://127.0.0.1:4310/api/listings?view=all&status=needs_verification'
curl -fsS 'http://127.0.0.1:4310/api/listings?view=all&status=rejected'
curl -fsS 'http://127.0.0.1:4310/api/listings?view=pool&mode=global'
```

Report for each platform:

- source state, pages/items scanned, and fresh/stale status;
- eligible count;
- accounts with any trusted M7 rare-finish tag;
- pearl/iridescent/candy counts;
- contribution to global Top 30.

Compute the raw keyword evidence count across eligible,
needs-verification, and rejected snapshots, then compare it with trusted
tagged-account counts. This keeps false-positive auditing representative instead
of looking only at accounts that already passed hard filters.

- [ ] **Step 5: Audit real positives and negatives**

Inspect at least one real positive for each available tag and three untagged negatives that mention another weapon/item. If a false positive or false negative is found, first add a failing regression test, observe RED, implement the smallest correction, and rerun the focused plus full suites.

- [ ] **Step 6: Inspect the local app with the browser skill**

Use `browser:control-in-app-browser` to open/reuse `http://127.0.0.1:4311/`, switch to global Top 30, and verify:

- list tags appear on the correct rows without breaking layout;
- selecting a tagged row shows matching source evidence;
- score reads `M7 综合价值 /35` and reasons explain `/27 + /8`;
- no-tag listings show `稀有模板待核验`;
- source blocked/stale warnings remain truthful.

Finalize the browser with the local app tab kept open.

- [ ] **Step 7: Run final verification after any live-data regression fixes**

Run:

```bash
pnpm test && pnpm typecheck && pnpm build && git diff --check
```

Expected: exit 0 for every command and no whitespace errors.

- [ ] **Step 8: Commit any final tested correction and push master**

If Task 6 produced code changes, commit them with a focused message. Then:

```bash
git status --short --branch
git push origin master
```

Expected: clean `master` synchronized with `origin/master`.
