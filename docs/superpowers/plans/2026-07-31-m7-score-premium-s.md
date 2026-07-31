# M7 Score Rebalance and Premium S Eligibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce M7's share of account value from 35 to 20 points, admit only evidence-backed M7 优品 S alongside all 极品 grades, and make all three collectors and existing stored data follow the new rules.

**Architecture:** Extend the existing evidence parser so premium status retains an adjacent grade, then pass both status and grade through the existing hard classifier. Rebalance the five value components without changing the 100-point value scale or overall score weights. Expand each marketplace's approved search/filter contract to include 优品 S, and add an idempotent repository rederivation pass at server startup so persisted listings are immediately reclassified and rescored without fabricating a scan.

**Tech Stack:** TypeScript, Zod, React 19, Express, Node SQLite, Cheerio, Vitest, Testing Library.

---

## File Map

- `src/domain/evidence.ts` — retain grades for both 极品 and 优品 M7 evidence.
- `src/domain/classify.ts` — encode premium-S-only eligibility.
- `src/server/collector/buildListing.ts` — pass parsed M7 grade into classification.
- `src/domain/score.ts` — implement the new 20/25/20/25/10 value allocation.
- `src/domain/listing.ts` — enforce the new score-part maxima.
- `src/server/collector/adapters/panzhi.ts` — add an independent 优品 S search term.
- `src/server/collector/adapters/pxb7.ts` — add an independent 优品 S API query.
- `src/server/collector/mtop.ts` — approve the five-condition 交易猫 request and exact referer.
- `src/server/collector/adapters/jiaoyimao.ts` — send the five-condition request and preserve premium-S card evidence.
- `src/server/browserRefresh/contracts.ts` — require at least five filter labels.
- `src/server/browserRefresh/completeness.ts` — require exactly 极品 S/A/B/C plus 优品 S.
- `scripts/jiaoyimao-browser-bridge.mjs` — reject incomplete proofs before submission.
- `src/server/repository.ts` — transactionally reparse, reclassify, deduplicate, and rescore stored listings.
- `src/server/index.ts` — run the rederivation once at startup.
- `src/client/App.tsx` — update fixed-filter and empty-state copy.
- `src/client/components/ListingTable.tsx` — show `M7 · 优品S`.
- `src/client/components/ListingDetail.tsx` — distinguish premium/peak and show new score maxima.
- `README.md` and `docs/jiaoyimao-browser-refresh-runbook.md` — document the new rules and browser proof.
- Existing domain, server, script, and client tests — lock each behavior before implementation.

### Task 1: Preserve Premium Grade and Classify Premium S

**Files:**
- Modify: `tests/domain/evidence.test.ts`
- Modify: `tests/domain/classify.test.ts`
- Modify: `tests/server/coordinator.test.ts`
- Modify: `src/domain/evidence.ts`
- Modify: `src/domain/classify.ts`
- Modify: `src/server/collector/buildListing.ts`

- [ ] **Step 1: Write failing evidence-parser tests**

Add table cases asserting:

```ts
expect(parseM7(toEvidenceRecords([
  "M7战斗步枪-棱镜攻势S2(优品S)"
]))).toMatchObject({ status: "premium", quality: "S" });

expect(parseM7(toEvidenceRecords([
  "M7棱镜攻势(优品A)"
]))).toMatchObject({ status: "premium", quality: "A" });
```

Also cover premium without grade, consistent repeated premium S, premium S plus premium A yielding `quality: undefined`, and premium/peak conflict yielding `conflicting + undefined`.

- [ ] **Step 2: Run the parser tests and verify RED**

Run:

```bash
npx vitest run tests/domain/evidence.test.ts
```

Expected: failures show premium grades are currently discarded.

- [ ] **Step 3: Implement status-aware grade retention**

In `parseM7`:

- return the adjacent grade when a standard match resolves to either `peak` or `premium`;
- collect qualities for the final explicit status rather than only `peak`;
- keep a grade only when every explicit match for that status has the same defined grade;
- return no grade for `conflicting`, `unknown`, or `absent`.

- [ ] **Step 4: Re-run parser tests and verify GREEN**

Run:

```bash
npx vitest run tests/domain/evidence.test.ts
```

Expected: all parser tests pass.

- [ ] **Step 5: Write failing classifier tests**

Update the classifier factory to supply `m7PrismQuality`. Add assertions:

```ts
expect(classifyListing(valid({
  m7PrismStatus: "premium",
  m7PrismQuality: "S"
}))).toBe("eligible");

for (const quality of ["A", "B", "C"] as const) {
  expect(classifyListing(valid({
    m7PrismStatus: "premium",
    m7PrismQuality: quality
  }))).toBe("rejected");
}

expect(classifyListing(valid({
  m7PrismStatus: "premium",
  m7PrismQuality: null
}))).toBe("needs_verification");
```

Retain tests proving any known QQ/service/price failure still rejects.

- [ ] **Step 6: Run classifier tests and verify RED**

Run:

```bash
npx vitest run tests/domain/classify.test.ts
```

Expected: input type and premium-S assertions fail.

- [ ] **Step 7: Implement the minimal classifier rule**

Extend `EligibilityInput` with:

```ts
m7PrismQuality: M7PrismQuality | null;
```

Treat premium A/B/C as known failures, premium with `null` as unresolved, and `(peak) OR (premium && S)` as the proven M7 condition.

Pass `m7.quality ?? null` from `buildListing`.

- [ ] **Step 8: Add an integration test and verify GREEN**

In `tests/server/coordinator.test.ts`, build a QQ official ¥6,000-or-less listing whose single M7 evidence is `优品S` and assert the committed listing is eligible with `m7PrismStatus: "premium"` and `m7PrismQuality: "S"`.

Run:

```bash
npx vitest run tests/domain/classify.test.ts tests/server/coordinator.test.ts
```

Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add src/domain/evidence.ts src/domain/classify.ts src/server/collector/buildListing.ts tests/domain/evidence.test.ts tests/domain/classify.test.ts tests/server/coordinator.test.ts
git commit -m "feat: admit evidence-backed M7 premium S"
```

### Task 2: Rebalance the Account Value Score

**Files:**
- Modify: `tests/domain/score.test.ts`
- Modify: `tests/domain/listing.test.ts`
- Modify: `src/domain/score.ts`
- Modify: `src/domain/listing.ts`

- [ ] **Step 1: Write failing score tests**

Lock the new values:

```ts
expect(scoreOf({ m7PrismStatus: "peak", m7PrismQuality: "S" }).parts.m7)
  .toBe(16);
expect(scoreOf({ m7PrismStatus: "peak", m7PrismQuality: "A" }).parts.m7)
  .toBe(13);
expect(scoreOf({ m7PrismStatus: "peak", m7PrismQuality: "B" }).parts.m7)
  .toBe(10);
expect(scoreOf({ m7PrismStatus: "peak", m7PrismQuality: "C" }).parts.m7)
  .toBe(8);
expect(scoreOf({ m7PrismStatus: "premium", m7PrismQuality: "S" }).parts.m7)
  .toBe(6);
```

Add cases proving any non-empty rare-finish set adds exactly 4, the M7 component caps at 20, five red skins score 25, owned 巨浪 scores 20, price caps at 25, and the value total never exceeds 100.

Update reason assertions so the quality contribution is described against the shared `/16` quality ceiling and the rare finish against `/4`, while the rendered combined M7 component remains `/20`.

- [ ] **Step 2: Run score/schema tests and verify RED**

Run:

```bash
npx vitest run tests/domain/score.test.ts tests/domain/listing.test.ts
```

Expected: old 35/20/15/20 maxima and old quality values fail.

- [ ] **Step 3: Implement the explicit 100-point allocation**

In `score.ts`:

```ts
const PEAK_QUALITY_POINTS = { S: 16, A: 13, B: 10, C: 8 } as const;
const PREMIUM_S_POINTS = 6;
```

Compute premium S separately from peak grades, set rare finish to 4, cap M7 at 20, make red skins 5 each up to 25, 巨浪 20, and multiply price percentile value by 25. Keep assets and the overall `55/35/10` formula unchanged.

Update reason labels so premium S reads `M7 优品S`, peak reads `M7 极品X`, and all denominators match the new maxima.

In `ListingSchema`, change score part maximums to M7 20, red skins 25, 巨浪 20, price 25, assets 10.

- [ ] **Step 4: Run score/schema tests and verify GREEN**

Run:

```bash
npx vitest run tests/domain/score.test.ts tests/domain/listing.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/domain/score.ts src/domain/listing.ts tests/domain/score.test.ts tests/domain/listing.test.ts
git commit -m "feat: rebalance M7 account value score"
```

### Task 3: Expand All Three Marketplace Search Contracts

**Files:**
- Modify: `tests/server/adapters.test.ts`
- Modify: `tests/server/mtop.test.ts`
- Modify: `tests/server/fetcher.test.ts`
- Modify: `tests/server/pxb7-collection.test.ts`
- Modify: `src/server/collector/adapters/panzhi.ts`
- Modify: `src/server/collector/adapters/pxb7.ts`
- Modify: `src/server/collector/mtop.ts`
- Modify: `src/server/collector/adapters/jiaoyimao.ts`

- [ ] **Step 1: Write failing single-select collector tests**

Extend existing request-sequence tests to require:

- 盼之 runs `极品 S`, `极品 A`, `极品 B`, `极品 C`, `优品 S`, then the existing broad M7 fallback, one search term at a time;
- 螃蟹 runs the same five explicit qualities, one query per request, and does not combine them in a body.

Add a 螃蟹 fixture/product with `M7战斗步枪-棱镜攻势S2(优品S)` and assert the embedded detail preserves premium S.

- [ ] **Step 2: Run adapter tests and verify RED**

Run:

```bash
npx vitest run tests/server/adapters.test.ts tests/server/pxb7-collection.test.ts
```

Expected: the fifth explicit search is absent.

- [ ] **Step 3: Add the two single-select searches**

Insert `"M7战斗步枪-棱镜攻势S2 优品 S"` after the four peak entries in both adapters. Preserve each adapter's existing page exhaustion and deduplication behavior.

- [ ] **Step 4: Write failing 交易猫 request tests**

Update the approved search-condition helper to include:

```ts
"优品|S": ["M7战斗步枪-棱镜攻势S2"]
```

Assert:

- the exact referer decodes to five quality keys;
- the approved MTop body requires all five exact keys;
- removing, changing, duplicating, or adding an unapproved key is rejected;
- list-card text `M7 · 优品 S` becomes traceable `M7棱镜攻势(优品S)` evidence.

- [ ] **Step 5: Run 交易猫 tests and verify RED**

Run:

```bash
npx vitest run tests/server/mtop.test.ts tests/server/fetcher.test.ts tests/server/adapters.test.ts
```

Expected: exact-key validation and premium evidence tests fail.

- [ ] **Step 6: Implement the five-condition approved request**

Update:

- `APPROVED_JIAOYIMAO_REFERER`;
- `APPROVED_QUALITY_KEYS`;
- `BROAD_SEARCH_CONDITION`;
- `normalizedM7Evidence` so it captures either `极品` or `优品`, retaining the letter and label.

Keep the request allowlist exact; do not broaden endpoints, methods, origins, categories, page sizes, or transaction capabilities.

- [ ] **Step 7: Run marketplace tests and verify GREEN**

Run:

```bash
npx vitest run tests/server/adapters.test.ts tests/server/mtop.test.ts tests/server/fetcher.test.ts tests/server/pxb7-collection.test.ts
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/server/collector/adapters/panzhi.ts src/server/collector/adapters/pxb7.ts src/server/collector/adapters/jiaoyimao.ts src/server/collector/mtop.ts tests/server/adapters.test.ts tests/server/mtop.test.ts tests/server/fetcher.test.ts tests/server/pxb7-collection.test.ts
git commit -m "feat: scan M7 premium S on every marketplace"
```

### Task 4: Require Premium S in Browser Filter Proof

**Files:**
- Modify: `tests/server/browserRefreshCompleteness.test.ts`
- Modify: `tests/server/browserRefreshContracts.test.ts`
- Modify: `tests/server/browserRefreshService.test.ts`
- Modify: `tests/server/browserRefreshRepository.test.ts`
- Modify: `tests/server/api.test.ts`
- Modify: `tests/scripts/jiaoyimao-browser-bridge.test.ts`
- Modify: `src/server/browserRefresh/contracts.ts`
- Modify: `src/server/browserRefresh/completeness.ts`
- Modify: `scripts/jiaoyimao-browser-bridge.mjs`
- Modify: `docs/jiaoyimao-browser-refresh-runbook.md`

- [ ] **Step 1: Update valid proof fixtures and add failing negative cases**

Every valid proof should include five labels:

```ts
m7FilterLabels: [
  "M7棱镜攻势极品S",
  "M7棱镜攻势极品A",
  "M7棱镜攻势极品B",
  "M7棱镜攻势极品C",
  "M7棱镜攻势优品S"
]
```

Add negative tests for missing premium S, premium A substituted for premium S, duplicate premium S, combined labels, and labels missing M7/棱镜攻势.

- [ ] **Step 2: Run browser-proof tests and verify RED**

Run:

```bash
npx vitest run tests/server/browserRefreshCompleteness.test.ts tests/server/browserRefreshContracts.test.ts tests/server/browserRefreshService.test.ts tests/server/browserRefreshRepository.test.ts tests/server/api.test.ts tests/scripts/jiaoyimao-browser-bridge.test.ts
```

Expected: four-label proofs still pass current validation or valid five-label proofs fail exact grade parsing.

- [ ] **Step 3: Implement exact five-signature validation**

Normalize each label, require M7 and 棱镜攻势, then extract exactly one signature:

```ts
"极品S" | "极品A" | "极品B" | "极品C" | "优品S"
```

Require five labels and equality with the complete expected signature set. Raise the Zod/bridge minimum from four to five while retaining the existing safe maximum of eight and all text-safety limits.

- [ ] **Step 4: Update the runbook**

Document visible confirmation of all five filters and explain that login/captcha remains a manual user step. Do not introduce cookie, storage, or hidden network-state inspection.

- [ ] **Step 5: Run browser-proof tests and verify GREEN**

Run the command from Step 2.

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/server/browserRefresh/contracts.ts src/server/browserRefresh/completeness.ts scripts/jiaoyimao-browser-bridge.mjs docs/jiaoyimao-browser-refresh-runbook.md tests/server/browserRefreshCompleteness.test.ts tests/server/browserRefreshContracts.test.ts tests/server/browserRefreshService.test.ts tests/server/browserRefreshRepository.test.ts tests/server/api.test.ts tests/scripts/jiaoyimao-browser-bridge.test.ts
git commit -m "feat: prove premium S in browser refresh filters"
```

### Task 5: Rederive Persisted Listings at Startup

**Files:**
- Modify: `tests/server/repository.test.ts`
- Modify: `src/server/repository.ts`
- Modify: `src/server/index.ts`

- [ ] **Step 1: Write failing repository tests**

Create stored listings with deliberately stale derived fields:

- QQ official ¥5,000, evidence `M7...优品S`, persisted as `premium + null + rejected` with an old score;
- QQ official ¥5,000, evidence `M7...优品A`, persisted as rejected;
- peak listings containing old score-part maxima.

Save source status and an observation/history row before rederivation. Assert that `recomputeDerivedListings(now)`:

- reparses premium S and makes it eligible;
- leaves premium A rejected;
- recalculates all eligible scores with `parts.m7 <= 20`;
- recalculates duplicate keys across the stored set;
- does not change source status, scan history, observations, active state, or latest manual review;
- gives byte-equivalent derived payloads on a second call with the same `now`.

- [ ] **Step 2: Run repository tests and verify RED**

Run:

```bash
npx vitest run tests/server/repository.test.ts
```

Expected: `recomputeDerivedListings` does not exist.

- [ ] **Step 3: Implement transactional rederivation**

Add a public repository method that:

1. reads stored listings;
2. reparses `listing.m7Evidence` when non-empty, otherwise preserves existing M7 fields;
3. calls `classifyListing` with status and grade;
4. resets score and duplicate keys;
5. calls `markPossibleDuplicates` and `scoreEligibleListings`;
6. updates only `listings.eligibility` and `listings.payload` inside one immediate transaction.

Use the supplied `now` for deterministic score age calculations. Roll back on any parse or write failure.

- [ ] **Step 4: Call the method at startup**

In `src/server/index.ts`, create one `startupTime`, call:

```ts
repository.recomputeDerivedListings(startupTime);
```

before creating the refresh tracker and before browser-job recovery. Reuse that same timestamp for startup recovery/expiry.

- [ ] **Step 5: Run repository tests and verify GREEN**

Run:

```bash
npx vitest run tests/server/repository.test.ts tests/server/api.test.ts
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/server/repository.ts src/server/index.ts tests/server/repository.test.ts
git commit -m "feat: rederive listing ranks on startup"
```

### Task 6: Update Candidate UI and Documentation

**Files:**
- Modify: `tests/client/App.test.tsx`
- Modify: `tests/client/ListingTable.test.tsx`
- Modify: `tests/client/ListingDetail.test.tsx`
- Modify: `src/client/App.tsx`
- Modify: `src/client/components/ListingTable.tsx`
- Modify: `src/client/components/ListingDetail.tsx`
- Modify: `README.md`

- [ ] **Step 1: Write failing UI tests**

Assert:

- fixed condition says `M7 棱镜攻势 · 极品 / 优品S`;
- empty state mentions both 极品 and 优品 S;
- a premium-S row says `M7 · 优品S`;
- detail says `M7 棱镜攻势 · 优品S`;
- premium with unknown grade says `优品品质待核验`;
- score rows display `M7 综合价值 … / 20`, red skins `/25`, 巨浪 `/20`, price `/25`, and assets `/10`;
- value reasons display the new `/4` rare-finish scale.

- [ ] **Step 2: Run client tests and verify RED**

Run:

```bash
npx vitest run tests/client/App.test.tsx tests/client/ListingTable.test.tsx tests/client/ListingDetail.test.tsx
```

Expected: old eligibility copy and old `/35`, `/20`, `/15`, `/20` denominators fail.

- [ ] **Step 3: Implement UI labels**

Update status helpers to include `m7PrismQuality` for premium listings. Keep unknown and conflicting warnings explicit and do not claim absent rare finishes when evidence is missing.

Update all fixed-filter, empty-state, score-row, and reason copy to the new rules.

- [ ] **Step 4: Update README**

Document:

- hard eligibility as 极品 or 优品 S;
- single-select scan sets on 盼之/螃蟹;
- five-filter 交易猫 behavior;
- exact value allocation and startup rederivation;
- purchase-time manual verification remains mandatory.

- [ ] **Step 5: Run client tests and verify GREEN**

Run the command from Step 2.

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/client/App.tsx src/client/components/ListingTable.tsx src/client/components/ListingDetail.tsx README.md tests/client/App.test.tsx tests/client/ListingTable.test.tsx tests/client/ListingDetail.test.tsx
git commit -m "feat: show premium S and balanced value score"
```

### Task 7: Full Verification, Live Rerank, and Integration

**Files:**
- Verify all modified files.
- No new product scope.

- [ ] **Step 1: Run focused rule suites**

```bash
npx vitest run tests/domain/evidence.test.ts tests/domain/classify.test.ts tests/domain/score.test.ts tests/server/adapters.test.ts tests/server/mtop.test.ts tests/server/browserRefreshCompleteness.test.ts tests/server/repository.test.ts tests/client/App.test.tsx tests/client/ListingTable.test.tsx tests/client/ListingDetail.test.tsx
```

Expected: all pass.

- [ ] **Step 2: Run complete verification**

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: 0 failures, no type errors, production build succeeds, no whitespace errors.

- [ ] **Step 3: Review the complete diff**

Confirm no endpoint allowlist was broadened, no captcha bypass was added, all score maxima total exactly 100, and every classifier call supplies a grade.

- [ ] **Step 4: Restart the live service against the current database**

Preserve the existing SQLite file and restart the current `screen` development service from the integrated master worktree so startup rederivation updates only stored listing payloads.

Query the API/database before and after to record:

- total/eligible/rejected counts;
- count by `m7PrismStatus + m7PrismQuality`;
- Top 30 source mix;
- every eligible score has M7 `<= 20`;
- no premium A/B/C is eligible.

- [ ] **Step 5: Refresh live sources where possible**

Run the public refresh so 盼之 and 螃蟹 execute all five independent searches. For 交易猫, start the browser refresh task and reuse the logged-in visible filtered page; if verification is shown, stop for the user to solve it rather than bypassing it.

Do not claim a platform was refreshed unless its source status and item counts prove a newly accepted scan.

- [ ] **Step 6: Browser acceptance**

Use the Codex in-app browser at `http://127.0.0.1:4311/` to verify the fixed condition, reranked candidate pool, premium-S label when data exists, `/20` M7 detail, and working manual exclusion.

- [ ] **Step 7: Merge and push**

After verification, merge `codex/m7-score-premium-s` into `master` without discarding unrelated work, rerun the full verification on `master`, and push `origin/master`.

Expected: local `master` and `origin/master` point to the same verified commit.
