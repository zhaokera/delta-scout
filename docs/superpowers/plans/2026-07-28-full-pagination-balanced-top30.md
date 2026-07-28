# Full Pagination and Balanced Top 30 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Traverse every currently accessible page from Jiaoyimao, Panzhi, and PXB7, score all fresh eligible QQ/M7-peak/≤¥6000 listings together, and expose a balanced candidate pool containing at most the top 10 listings from each source.

**Architecture:** Keep source-specific pagination inside adapters, add a narrowly scoped anonymous MTop transport to the existing fetcher, and let `CollectionCoordinator` own universal deduplication, stop conditions, safety limits, freshness, and scan metadata. Extract recommendation ordering and balanced-pool selection into pure domain functions so the API, source metrics, and UI all consume one definition.

**Tech Stack:** TypeScript 7, React 19, Vite 8, Express 5, Node `node:sqlite`, Cheerio, Zod, Vitest, Testing Library, Supertest.

**Specifications:** `docs/superpowers/specs/2026-07-28-full-pagination-balanced-top30-design.md`, plus the non-overridden requirements in the two earlier design documents referenced there.

---

## File map

**Create**

- `src/domain/candidatePool.ts` — one authoritative recommendation comparator and balanced per-source selection.
- `src/server/collector/mtop.ts` — pure MTop signing, URL, metadata, and anonymous-cookie helpers.
- `tests/domain/candidatePool.test.ts` — balanced selection and deterministic ordering tests.
- `tests/server/mtop.test.ts` — signing/encoding/cookie helper tests.
- `tests/fixtures/jiaoyimao-list-page-2.json` — minimal, redacted MTop response containing products plus `hasNextPage`.
- `tests/fixtures/jiaoyimao-list-page-last.json` — minimal terminal MTop response.

**Modify**

- `src/server/collector/types.ts` — anonymous MTop request descriptor.
- `src/server/collector/fetcher.ts` — two-step anonymous token handshake while preserving existing GET/POST behavior.
- `src/server/collector/adapters/jiaoyimao.ts` — broad S/A/B/C filter, MTop page requests, JSON parsing.
- `src/server/collector/adapters/panzhi.ts` — deterministic `page=N+1` requests.
- `src/server/collector/coordinator.ts` — natural-end traversal, injected safety limits, scan metadata, fresh-only scoring.
- `src/server/db.ts` — idempotent legacy migration for `pages_scanned` and `stop_reason`.
- `src/server/repository.ts` — persist scan metadata and expose current status.
- `src/domain/score.ts` — reuse the exported comparator without changing score weights.
- `src/server/app.ts` — `pool|all` listing views and derived source counts.
- `src/client/api.ts` — listing view contract and richer source status.
- `src/client/App.tsx` — default pool, four views, contribution summary.
- `src/client/components/FilterBar.tsx` — four view tabs.
- `src/client/components/SourceStrip.tsx` — pages/items/eligible/candidate/completeness metrics.
- `src/client/components/ListingTable.tsx` — balanced pool heading and source contribution counts.
- `src/client/styles.css` — compact source metric and warning styles.
- `tests/server/fetcher.test.ts`, `tests/server/adapters.test.ts`, `tests/server/coordinator.test.ts`, `tests/server/repository.test.ts`, `tests/server/api.test.ts`, `tests/client/App.test.tsx` — contract and regression coverage.

## Task 1: Extract one recommendation order and balanced pool selector

**Files:**

- Create: `src/domain/candidatePool.ts`
- Create: `tests/domain/candidatePool.test.ts`
- Modify: `src/domain/score.ts`
- Test: `tests/domain/score.test.ts`

- [ ] **Step 1: Write failing balanced-pool tests**

Create listings with 12 eligible scored items per source, plus rejected, unscored, and duplicate-key records. Assert that the result contains exactly 10 per source, 30 total, is globally ordered, and does not backfill an eleventh listing when another source only has three:

```ts
const pool = selectBalancedCandidatePool(listings);
expect(pool).toHaveLength(23);
const sourceCounts = pool.reduce<Record<string, number>>((counts, listing) => {
  counts[listing.source] = (counts[listing.source] ?? 0) + 1;
  return counts;
}, {});
expect(sourceCounts).toEqual({
  jiaoyimao: 10,
  panzhi: 3,
  pxb7: 10
});
expect(pool.filter(({ source }) => source === "jiaoyimao")).toHaveLength(10);
expect(pool.filter(({ source }) => source === "panzhi")).toHaveLength(3);
expect(pool.filter(({ source }) => source === "pxb7")).toHaveLength(10);
expect(new Set(pool.map(({ key }) => key)).size).toBe(pool.length);
```

- [ ] **Step 2: Run the new test and verify RED**

Run:

```bash
pnpm vitest run tests/domain/candidatePool.test.ts
```

Expected: FAIL because `selectBalancedCandidatePool` does not exist.

- [ ] **Step 3: Implement the pure selector and shared comparator**

Move the complete tie-break order out of `scoreEligibleListings` and export it:

```ts
export function compareRecommendations(left: Listing, right: Listing): number {
  const scoreDifference =
    (right.score?.total ?? -1) - (left.score?.total ?? -1);
  if (scoreDifference !== 0) return scoreDifference;
  if (right.confidence !== left.confidence) {
    return right.confidence - left.confidence;
  }
  const priceDifference =
    (left.priceCny ?? Infinity) - (right.priceCny ?? Infinity);
  if (priceDifference !== 0) return priceDifference;
  const capturedDifference =
    Date.parse(right.capturedAt) - Date.parse(left.capturedAt);
  if (capturedDifference !== 0) return capturedDifference;
  return left.url.localeCompare(right.url);
}
```

Implement the selector without recomputing scores:

```ts
export function selectBalancedCandidatePool(
  listings: Listing[],
  perSourceLimit = 10
): Listing[] {
  const counts = new Map<SourceId, number>();
  const keys = new Set<string>();
  return listings
    .filter((listing) =>
      listing.eligibility === "eligible" && listing.score !== null
    )
    .sort(compareRecommendations)
    .filter((listing) => {
      if (keys.has(listing.key)) return false;
      const count = counts.get(listing.source) ?? 0;
      if (count >= perSourceLimit) return false;
      keys.add(listing.key);
      counts.set(listing.source, count + 1);
      return true;
    });
}
```

Update `scoreEligibleListings` to sort with the same comparator.

- [ ] **Step 4: Run domain tests and verify GREEN**

Run:

```bash
pnpm vitest run tests/domain/candidatePool.test.ts tests/domain/score.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/candidatePool.ts src/domain/score.ts tests/domain/candidatePool.test.ts tests/domain/score.test.ts
git commit -m "feat: select balanced cross-platform candidate pool"
```

## Task 2: Persist scan progress without destroying legacy snapshots

**Files:**

- Modify: `src/server/db.ts`
- Modify: `src/server/repository.ts`
- Modify: `tests/server/repository.test.ts`

- [ ] **Step 1: Write failing migration and status tests**

Create a legacy in-memory `source_status` table without new columns, call `createDatabase` through a temporary file-backed database, and assert the migration preserves rows while adding:

```ts
expect(status).toMatchObject({
  pagesScanned: 0,
  stopReason: null
});
```

Add snapshot/failure assertions:

```ts
repository.replaceSourceSnapshot(
  "panzhi",
  listings,
  "partial",
  now,
  { pagesScanned: 5, stopReason: "request_timeout" }
);
expect(status).toMatchObject({
  itemCount: listings.length,
  pagesScanned: 5,
  stopReason: "request_timeout"
});

repository.markSourceFailure("panzhi", "captcha_required", later, "blocked");
expect(status).toMatchObject({
  itemCount: listings.length,
  pagesScanned: 0,
  stopReason: "captcha_required"
});
```

- [ ] **Step 2: Run repository tests and verify RED**

Run:

```bash
pnpm vitest run tests/server/repository.test.ts
```

Expected: FAIL because the columns and metadata arguments do not exist.

- [ ] **Step 3: Add an idempotent SQLite migration**

After `CREATE TABLE IF NOT EXISTS`, inspect `PRAGMA table_info(source_status)` and execute only missing alterations:

```ts
const columns = new Set(
  database.prepare("PRAGMA table_info(source_status)").all()
    .map((row) => String((row as { name: unknown }).name))
);
if (!columns.has("pages_scanned")) {
  database.exec(
    "ALTER TABLE source_status ADD COLUMN pages_scanned INTEGER NOT NULL DEFAULT 0"
  );
}
if (!columns.has("stop_reason")) {
  database.exec(
    "ALTER TABLE source_status ADD COLUMN stop_reason TEXT"
  );
}
```

Extend `SourceStatus`, row mapping, `replaceSourceSnapshot`, and `markSourceFailure`. A first-page failure sets `pages_scanned=0` and the stop reason but preserves `item_count` and listings.

- [ ] **Step 4: Run repository tests and verify GREEN**

Run:

```bash
pnpm vitest run tests/server/repository.test.ts
```

Expected: PASS, including the existing rollback and stale-snapshot tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/db.ts src/server/repository.ts tests/server/repository.test.ts
git commit -m "feat: persist source scan completeness"
```

## Task 3: Add the narrowly scoped anonymous MTop transport

**Files:**

- Create: `src/server/collector/mtop.ts`
- Create: `tests/server/mtop.test.ts`
- Modify: `src/server/collector/types.ts`
- Modify: `src/server/collector/fetcher.ts`
- Modify: `tests/server/fetcher.test.ts`

- [ ] **Step 1: Write pure helper tests**

Use fixed values from the approved spec:

```ts
expect(signMtop("", "1785230000000", "12574478", data))
  .toBe(createHash("md5")
    .update(`&1785230000000&12574478&${data}`)
    .digest("hex"));

expect(extractAnonymousMtopSession(headers)).toEqual({
  token: "abc123",
  cookieHeader: "_m_h5_tk=abc123_1785239999; _m_h5_tk_enc=encoded"
});
```

Assert that missing either approved Cookie, a non-MTop Cookie, or a malformed token returns `null`.

- [ ] **Step 2: Write a failing fetcher handshake test**

Describe a request with `options.anonymousMtop`, return `FAIL_SYS_TOKEN_EMPTY` plus two `Set-Cookie` headers from the first fake response, then success from the second. Assert:

- the first call has no `Cookie`;
- the second call has only `_m_h5_tk` and `_m_h5_tk_enc`;
- `data` is form encoded but the MD5 used the unencoded outer JSON;
- both calls target the exact MTop host/path;
- no Cookie value appears in the fetch result.

Add separate RED cases proving the runtime rejects `anonymousMtop` when any approved value differs:

- host/path is not the exact Jiaoyimao MTop endpoint;
- API, version, or `appKey` differs;
- `Origin` is not `https://www.jiaoyimao.com`;
- `Referer` is not the adapter’s complete approved entry URL.

Add a token-expired sequence: empty-token handshake → signed request returns `FAIL_SYS_TOKEN_EXPIRED` with a replacement session → one fresh signed retry succeeds. Assert no fourth request is allowed. On every signed call assert the complete `Referer`, exact `jym-meta-h5` JSON shape, and `x-ua` value.

- [ ] **Step 3: Run the MTop and fetcher tests and verify RED**

Run:

```bash
pnpm vitest run tests/server/mtop.test.ts tests/server/fetcher.test.ts
```

Expected: FAIL because the descriptor and helpers do not exist.

- [ ] **Step 4: Implement pure MTop helpers**

Add:

```ts
export interface AnonymousMtopSession {
  token: string;
  cookieHeader: string;
}

export function signMtop(
  token: string,
  timestamp: string,
  appKey: string,
  data: string
): string;

export function buildMtopUrl(
  endpoint: string,
  options: AnonymousMtopRequestOptions,
  timestamp: string,
  sign: string
): string;

export function buildJymMeta(timestamp: number, random: number): string;
export function extractAnonymousMtopSession(
  headers: Headers
): AnonymousMtopSession | null;
export function isApprovedJiaoyimaoMtopRequest(
  request: SourceRequest
): boolean;
```

Do not export or log raw cookies outside these helpers.

- [ ] **Step 5: Extend the request descriptor and fetcher**

Use `options.body` as the exact, unencoded outer `data` JSON so request fingerprints remain stable. Add:

```ts
export interface AnonymousMtopRequestOptions {
  readonly api: string;
  readonly version: string;
  readonly appKey: string;
}

export interface PublicRequestOptions {
  // existing fields
  readonly anonymousMtop?: AnonymousMtopRequestOptions;
}
```

In `PublicPageFetcher`, branch only when `anonymousMtop` exists **and** `isApprovedJiaoyimaoMtopRequest` confirms the exact endpoint, API, version, `appKey`, Origin, and complete entry-URL Referer. Return `failed/unapproved_mtop_request` before any network call when the descriptor is outside the whitelist.

Perform the expected empty-token request and one signed retry, using local variables only. Reuse the existing timeout, maximum-byte check, captcha detection, and source throttle. A token-expired response may replace the local session and make exactly one final signed retry; all other requests retain the current no-Cookie behavior. Build and assert the complete `jym-meta-h5` and `x-ua` headers from the approved spec rather than accepting arbitrary caller-provided values.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
pnpm vitest run tests/server/mtop.test.ts tests/server/fetcher.test.ts
```

Expected: PASS; the existing PXB7 test still proves ordinary POST requests never send cookies.

- [ ] **Step 7: Commit**

```bash
git add src/server/collector/mtop.ts src/server/collector/types.ts src/server/collector/fetcher.ts tests/server/mtop.test.ts tests/server/fetcher.test.ts
git commit -m "feat: fetch anonymous signed MTop pages"
```

## Task 4: Make Jiaoyimao return every broad-filter page

**Files:**

- Modify: `src/server/collector/adapters/jiaoyimao.ts`
- Create: `tests/fixtures/jiaoyimao-list-page-2.json`
- Create: `tests/fixtures/jiaoyimao-list-page-last.json`
- Modify: `tests/server/adapters.test.ts`

- [ ] **Step 1: Add minimal redacted MTop fixtures**

Keep only the verified response fields:

```json
{
  "ret": ["SUCCESS::调用成功"],
  "data": {
    "result": {
      "hasNextPage": "true",
      "deliverComps": [
        {
          "type": "8",
          "subType": "10",
          "data": {
            "goodsId": "1784550994519222",
            "detailUrlSeo": "https://www.jiaoyimao.com/jg2007840/1784550994519222.html?isGray=true",
            "price": "2000.0",
            "title": "总资产33.3M 6干员外观",
            "publishName": "QQ双端",
            "serverName": "安卓QQ",
            "sellPoints": [{"desc": "威龙-凌霄戍卫"}],
            "tagMap": {
              "featureTag": [{"tagName": "不可二次实名"}],
              "safeServiceTag": [{"tagName": "赠永久包赔"}]
            }
          }
        }
      ]
    }
  }
}
```

The terminal fixture changes `hasNextPage` to `"false"` and contains one different goods ID.

- [ ] **Step 2: Write failing adapter tests**

Assert:

- `entryUrl` decodes to a search condition with no `is_second_real_name`;
- S/A/B/C peak filters are all present;
- first HTML page produces a page-2 MTop request;
- page-2 JSON parses product identity, price, QQ hints, M7 peak query evidence, tags, and detail URL;
- `hasNextPage=true` increments only the string page in `options.body`;
- terminal JSON returns `null`;
- malformed response returns `blocked/structure_changed`;
- decoration components without a numeric `goodsId` are ignored.
- existing HTML cards containing `M7棱镜攻势(极品B)` and `(极品C)` normalize to `M7棱镜攻势(极品B|C)` and trigger the same detail-fetch prefilter as S/A.

- [ ] **Step 3: Run adapter tests and verify RED**

Run:

```bash
pnpm vitest run tests/server/adapters.test.ts
```

Expected: FAIL because Jiaoyimao still returns no next page and cannot parse MTop JSON.

- [ ] **Step 4: Implement broad filtering and dual-format parsing**

Keep the fixed absolute URL and exact search JSON from the approved spec. Add a pure `makeMtopListRequest(page: number)` whose `options.body` serializes:

```ts
{
  searchCondition: JSON.stringify(BROAD_SEARCH_CONDITION),
  relateId: "10101",
  pageSize: 16,
  modelType: "h5",
  queryType: 1,
  goodsScene: "goods_search_new",
  gameCondition: JSON.stringify({
    gameId: 2007840,
    platformId: 2,
    clientId: 110
  }),
  categoryId: 8845004,
  parentId: 8845003,
  class:
    "com.jym.delivery.hsf.dto.unifiedgoodslist.GoodsListQueryParams",
  page: String(page)
}
```

`parseList` detects the strictly validated MTop root before falling back to existing HTML parsing. Expand the SSR `normalizedM7Evidence` quality suffix from `[SA]` to `[SABC]` and add B/C regression cards. Build MTop raw evidence from the verified product fields plus `M7战斗步枪-棱镜攻势S2(极品)` as query-match evidence; the subsequent detail request must still determine the exact quality and safety fields.

- [ ] **Step 5: Run adapter tests and verify GREEN**

Run:

```bash
pnpm vitest run tests/server/adapters.test.ts
```

Expected: PASS for old HTML/detail coverage and new MTop coverage.

- [ ] **Step 6: Commit**

```bash
git add src/server/collector/adapters/jiaoyimao.ts tests/server/adapters.test.ts tests/fixtures/jiaoyimao-list-page-2.json tests/fixtures/jiaoyimao-list-page-last.json
git commit -m "feat: paginate the broad Jiaoyimao catalog"
```

## Task 5: Make Panzhi page until the coordinator sees no new IDs or a known empty page

**Files:**

- Modify: `src/server/collector/adapters/panzhi.ts`
- Modify: `tests/server/adapters.test.ts`

- [ ] **Step 1: Replace the old next-link test with URL progression cases**

Cover:

```ts
expect(nextPage(listPage, { url: ".../goodsList/391/6" }))
  .toEqual({ url: ".../goodsList/391/6?page=2" });
expect(nextPage(listPage, { url: ".../goodsList/391/6?page=2&sort=price" }))
  .toEqual({ url: ".../goodsList/391/6?page=3&sort=price" });
```

Also reject a different host/path and malformed/zero/negative page values.

Add an inline or fixture page containing the verified Panzhi catalog marker `.goods-list-with-game` but no `/goodsDetails/` links. Assert `parseList` returns `{ kind: "ok", items: [] }`. Keep a negative test proving arbitrary HTML without the marker still returns `blocked/structure_changed`.

- [ ] **Step 2: Run the Panzhi adapter test and verify RED**

Run:

```bash
pnpm vitest run tests/server/adapters.test.ts -t "panzhi"
```

Expected: FAIL because the current adapter requires `rel=next` and treats a known empty result page as a structure error.

- [ ] **Step 3: Generate the next page request from the current request URL**

Validate `https://www.pzds.com/goodsList/391/6`, parse the current positive integer page with a default of 1, set only `page + 1`, and return an immutable GET request. When no goods links exist, return an empty successful list only if the verified `.goods-list-with-game` catalog marker is present; otherwise retain `blocked/structure_changed`. The adapter deliberately does not guess the terminal page; the coordinator’s empty/no-new-ID rule ends the scan successfully.

- [ ] **Step 4: Run adapter tests and verify GREEN**

Run:

```bash
pnpm vitest run tests/server/adapters.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/collector/adapters/panzhi.ts tests/server/adapters.test.ts
git commit -m "feat: advance Panzhi result pages"
```

## Task 6: Traverse to a natural end and score only fresh snapshots

**Files:**

- Modify: `src/server/collector/coordinator.ts`
- Modify: `tests/server/coordinator.test.ts`
- Modify: `src/server/repository.ts`
- Test: `tests/server/repository.test.ts`

- [ ] **Step 1: Write failing traversal and stop-reason tests**

Replace the obsolete 60/20 cap test. Inject small limits for deterministic tests:

```ts
new CollectionCoordinator({
  adapters: [adapter],
  fetcher,
  repository,
  limits: { maxPages: 5, maxSummaries: 8, maxDetails: 4 }
});
```

Cover:

- four pages and seven unique records complete successfully (proves old 3-page cap is gone);
- a page containing only previously seen IDs stops with `no_new_items`;
- a repeated request stops with `repeated_request`;
- page, summary, and detail limits each yield `partial/safety_limit`;
- a later-page fetch failure preserves collected items with the exact error stop reason;
- more than 20 potential matches receive details under production defaults;
- failed old source listings retain their payload but have `score=null` and do not affect fresh candidates;
- fresh `partial` snapshots still receive unified scores;
- two sources with different price ranges are normalized together.

- [ ] **Step 2: Run coordinator tests and verify RED**

Run:

```bash
pnpm vitest run tests/server/coordinator.test.ts
```

Expected: FAIL on old caps, missing metadata, and stale score behavior.

- [ ] **Step 3: Introduce production limits and a refresh result**

Use:

```ts
const DEFAULT_LIMITS = {
  maxPages: 100,
  maxSummaries: 2_000,
  maxDetails: 500
} as const;

interface RefreshSourceResult {
  source: SourceId;
  fresh: boolean;
}
```

Track `pagesScanned`, new IDs per page, request fingerprints, `stopReason`, and `partial` independently. Natural `nextPage=null`, repeated requests, and no-new pages are successful stops unless an earlier error occurred. Persist the metadata through `replaceSourceSnapshot`.

- [ ] **Step 4: Restrict unified scoring to this refresh’s fresh sources**

Capture one `refreshStartedAt`, collect the sources that replaced a snapshot as `success|partial`, and compute duplicates/scores only for records whose source is fresh and whose `capturedAt >= refreshStartedAt`. Update every retained listing so old failed-source scores become `null`.

- [ ] **Step 5: Run coordinator and repository tests and verify GREEN**

Run:

```bash
pnpm vitest run tests/server/coordinator.test.ts tests/server/repository.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/collector/coordinator.ts src/server/repository.ts tests/server/coordinator.test.ts tests/server/repository.test.ts
git commit -m "feat: collect complete fresh source snapshots"
```

## Task 7: Expose pool/all API views and derived source counts

**Files:**

- Modify: `src/server/app.ts`
- Modify: `tests/server/api.test.ts`

- [ ] **Step 1: Write failing API contract tests**

Seed 12 scored eligible listings per source and assert:

```ts
await request(app).get("/api/listings")
// balanced pool, max 10 per source

await request(app).get("/api/listings?view=all&status=eligible")
// every eligible listing, including score-null retained history
```

Cover default compatibility, explicit `pool&eligible`, `all&needs_verification`, `all&rejected`, and 400 `invalid_listing_view` for unknown values or `pool + non-eligible`.

For `/api/sources`, assert `pagesScanned`, `stopReason`, `completion`, `eligibleCount`, and `candidateCount`; a failed source with an old snapshot has `eligibleCount=0` and `candidateCount=0`.

- [ ] **Step 2: Run API tests and verify RED**

Run:

```bash
pnpm vitest run tests/server/api.test.ts
```

Expected: FAIL because the route ignores `view` and source counts do not exist.

- [ ] **Step 3: Parse the explicit view contract**

Use a Zod enum for `pool|all`. Default to `pool/eligible` when both are absent; when only `view` is absent, eligible defaults to pool while other statuses default to all. Reject all unknown/invalid combinations with:

```json
{
  "error": "invalid_listing_view",
  "message": "候选视图参数无效"
}
```

Use `selectBalancedCandidatePool` for the pool response and `compareRecommendations` for all responses.

- [ ] **Step 4: Derive source metrics from the same pool**

Compute `eligibleCount` only from eligible listings with a non-null current score, compute `candidateCount` from the selected pool, and map persistent state to `completion`. Do not add mutable count columns.

- [ ] **Step 5: Run API tests and verify GREEN**

Run:

```bash
pnpm vitest run tests/server/api.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/app.ts tests/server/api.test.ts
git commit -m "feat: expose balanced pool and complete listing views"
```

## Task 8: Add four UI views and transparent source completeness

**Files:**

- Modify: `src/client/api.ts`
- Modify: `src/client/App.tsx`
- Modify: `src/client/components/FilterBar.tsx`
- Modify: `src/client/components/SourceStrip.tsx`
- Modify: `src/client/components/ListingTable.tsx`
- Modify: `src/client/styles.css`
- Modify: `tests/client/App.test.tsx`

- [ ] **Step 1: Write failing client tests**

Change the API fake to capture a `ListingView` and assert:

- initial load calls `getListings("pool")`;
- tabs show `推荐候选`, `全部合格`, `待人工核验`, `已淘汰`;
- selecting each tab issues the correct API request;
- the heading shows `推荐候选 23 / 30` and source contributions;
- source cards show `5 页`, `30 商品`, `3 合格`, `3 入选`;
- failed source shows `本轮 0 页`, `保留旧快照 16 条`, `不参与当前候选`;
- partial source displays an explicit partial warning.

- [ ] **Step 2: Run client tests and verify RED**

Run:

```bash
pnpm vitest run tests/client/App.test.tsx
```

Expected: FAIL because the client only models eligibility.

- [ ] **Step 3: Add the view-aware client API**

Define:

```ts
export type ListingView =
  | "pool"
  | "eligible"
  | "needs_verification"
  | "rejected";
```

Map it to explicit query strings:

```ts
const LISTING_QUERIES = {
  pool: "view=pool&status=eligible",
  eligible: "view=all&status=eligible",
  needs_verification: "view=all&status=needs_verification",
  rejected: "view=all&status=rejected"
} as const;
```

Extend `SourceStatusView` with the approved metrics and completion values.

- [ ] **Step 4: Update view state, tabs, table heading, and source cards**

Default `App` state to `pool`. Preserve advanced filtering only within the loaded view. Pass the selected view and the three contribution counts to `ListingTable`. Render source metrics in a compact grid and use explicit old-snapshot wording on blocked/failed sources.

- [ ] **Step 5: Run client tests and verify GREEN**

Run:

```bash
pnpm vitest run tests/client/App.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/client/api.ts src/client/App.tsx src/client/components/FilterBar.tsx src/client/components/SourceStrip.tsx src/client/components/ListingTable.tsx src/client/styles.css tests/client/App.test.tsx
git commit -m "feat: show balanced candidates and source completeness"
```

## Task 9: Run full verification and live three-source acceptance

**Files:**

- Modify only if a failing requirement exposes a real defect.

- [ ] **Step 1: Run focused regression tests**

Run:

```bash
pnpm vitest run tests/server/mtop.test.ts tests/server/fetcher.test.ts tests/server/adapters.test.ts tests/server/coordinator.test.ts tests/server/repository.test.ts tests/server/api.test.ts tests/domain/candidatePool.test.ts tests/domain/score.test.ts tests/client/App.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run the complete automated verification**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
git diff --check
git status --short
```

Expected: all tests pass, type checking and production build succeed, and only intentional changes remain.

- [ ] **Step 3: Run a real refresh against an isolated database**

Start the worktree API on a non-conflicting port with a fresh database:

```bash
SCOUT_DATABASE_PATH=data/full-pagination-acceptance.sqlite PORT=4320 pnpm tsx src/server/index.ts
```

Then:

```bash
curl -fsS -X POST http://127.0.0.1:4320/api/refresh
curl -fsS http://127.0.0.1:4320/api/sources
curl -fsS 'http://127.0.0.1:4320/api/listings?view=pool&status=eligible'
curl -fsS 'http://127.0.0.1:4320/api/listings?view=all&status=eligible'
```

Expected:

- each accessible source ends with `complete` or an honestly reported `partial/blocked/failed`;
- Jiaoyimao continues until `hasNextPage=false` or another documented stop;
- Panzhi continues until no new IDs;
- PXB7 continues until no new page Token;
- every pool listing is QQ official, ≤6000, and M7 peak;
- no source contributes more than 10 and pool size is at most 30;
- `all` contains every fresh eligible item, including eligible items outside a source Top 10.

- [ ] **Step 4: Perform a requirement-by-requirement data audit**

Use SQLite/API queries to record:

- pages, snapshot item count, eligible count, candidate count, state, and stop reason for every source;
- pool counts grouped by source;
- any pool record violating a hard condition (expected zero);
- duplicate pool keys (expected zero);
- score ordering violations (expected zero).

Do not treat a captcha or partial status as complete data; report it explicitly.

- [ ] **Step 5: Commit any acceptance-only fixture or defect fixes**

If no code changes were needed, skip this commit. Otherwise:

```bash
git add <only the intentional files>
git commit -m "fix: close full pagination acceptance gaps"
```

- [ ] **Step 6: Request code review**

Use `superpowers:requesting-code-review` against the full branch diff. Resolve every Critical/Important finding with focused tests and rerun Step 2.

- [ ] **Step 7: Finish and merge the branch**

Use `superpowers:finishing-a-development-branch`. Merge `codex/full-pagination-top30` into `main` only after automated and live acceptance pass.

- [ ] **Step 8: Restart and verify the main application in Codex Browser**

Restart the main-branch service at `http://127.0.0.1:4311/`, reload the existing Codex browser tab, and verify:

- the four view tabs are visible;
- default view is balanced Top 30;
- source cards match the API audit;
- switching to `全部合格` reveals valid non-pool items;
- at least one listing detail shows M7 quality, red skins, Julang, price, score, and original-platform link.

Keep the local application tab open as the final deliverable.
