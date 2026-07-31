# Manual Listing Exclusions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user exclude a reviewed account with a structured reason so it stays out of every candidate view across scans and restarts, while remaining visible and reversible in the rejected view.

**Architecture:** Preserve collector-owned `Listing` data unchanged and store user feedback as append-only SQLite events keyed by stable listing key. Decorate listings at the API read boundary with the latest active review, filter active manual exclusions before building eligible views and candidate pools, and expose idempotent exclude/restore endpoints consumed by one shared desktop/mobile React flow.

**Tech Stack:** TypeScript 7, React 19, Express 5, Node `node:sqlite`, Zod 4, Vitest, Testing Library, Supertest.

**Specification:** `docs/superpowers/specs/2026-07-31-manual-listing-exclusions-design.md`

---

## File map

**Create**

- `src/domain/manualReview.ts` — reason enum, labels, review schemas, request normalization, and `ReviewedListing` type.
- `src/client/components/ManualReviewDialog.tsx` — accessible reason/notes form shared by desktop and mobile detail surfaces.
- `tests/domain/manualReview.test.ts` — reason and note normalization contract.
- `tests/client/ManualReviewDialog.test.tsx` — form validation, submit, cancel, and retry behavior.

**Modify**

- `src/server/db.ts` — idempotent append-only `manual_listing_reviews` table and index.
- `src/server/repository.ts` — batch latest-review reads plus idempotent exclude/restore transactions.
- `src/server/app.ts` — reviewed snapshot filtering, rejected-view union, source counts, and two mutation routes.
- `src/client/api.ts` — reviewed listing responses and exclude/restore methods.
- `src/client/App.tsx` — modal state, review mutations, reload/broadcast behavior, and notices.
- `src/client/components/ListingDetail.tsx` — active review summary and exclude/restore actions.
- `src/client/components/DetailDrawer.tsx` — pass the same review actions into the mobile detail surface.
- `src/client/components/ListingTable.tsx` — show the manual-exclusion reason badge in rejected results.
- `src/client/styles.css` — review badge, action, modal, form, feedback, and responsive styles.
- `README.md` — document manual exclusions, persistence, restore semantics, and no automatic score learning.
- `tests/server/repository.test.ts` — migration, history, idempotency, restart, and source replacement persistence.
- `tests/server/api.test.ts` — API validation, view semantics, candidate refill, and source-count behavior.
- `tests/client/App.test.tsx` — end-to-end component behavior and multi-tab reload.
- `tests/client/ListingDetail.test.tsx` — reviewed detail and action accessibility.

## Task 1: Define and validate the manual-review contract

**Files:**

- Create: `src/domain/manualReview.ts`
- Create: `tests/domain/manualReview.test.ts`

- [ ] **Step 1: Write failing domain tests**

Cover every reason, whitespace normalization, optional note, maximum length, and the special `other` requirement:

```ts
expect(parseManualExclusionInput({
  reason: "price_overvalued",
  note: "  同价位有更安全的号  "
})).toEqual({
  reason: "price_overvalued",
  note: "同价位有更安全的号"
});

expect(() => parseManualExclusionInput({
  reason: "other",
  note: "   "
})).toThrow();

expect(() => parseManualExclusionInput({
  reason: "assets_low",
  note: "x".repeat(501)
})).toThrow();
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
pnpm vitest run tests/domain/manualReview.test.ts
```

Expected: FAIL because `src/domain/manualReview.ts` does not exist.

- [ ] **Step 3: Implement the minimal domain module**

Export:

```ts
export const ManualReviewReasonSchema = z.enum([
  "price_overvalued",
  "m7_low_value",
  "red_skins_mismatch",
  "safety_risk",
  "assets_low",
  "seller_concern",
  "other"
]);

export const MANUAL_REVIEW_REASON_LABELS = {
  price_overvalued: "价格虚高",
  m7_low_value: "M7 不值",
  red_skins_mismatch: "红皮不合适",
  safety_risk: "安全风险",
  assets_low: "资产不足",
  seller_concern: "卖家问题",
  other: "其他"
} as const;

export function parseManualExclusionInput(value: unknown) {
  const parsed = z.strictObject({
    reason: ManualReviewReasonSchema,
    note: z.string().max(500).optional()
  }).parse(value);
  const note = parsed.note?.trim() || null;
  if (parsed.reason === "other" && note === null) {
    throw new z.ZodError([
      {
        code: "custom",
        path: ["note"],
        message: "选择其他时请填写说明"
      }
    ]);
  }
  return { reason: parsed.reason, note };
}
```

Also export `ManualListingReview` and `ReviewedListing = Listing & { manualReview: ManualListingReview | null }`.

- [ ] **Step 4: Run the domain test and verify GREEN**

Run:

```bash
pnpm vitest run tests/domain/manualReview.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/manualReview.ts tests/domain/manualReview.test.ts
git commit -m "feat: define manual listing review contract"
```

## Task 2: Persist append-only review history

**Files:**

- Modify: `src/server/db.ts`
- Modify: `src/server/repository.ts`
- Modify: `tests/server/repository.test.ts`

- [ ] **Step 1: Write failing repository tests**

Add tests that:

1. exclude an eligible listing and read the active reason;
2. repeat the same request without adding a duplicate event;
3. submit a changed reason and append a new event;
4. restore twice and remain idempotently restored;
5. replace the source snapshot and preserve the review;
6. close/reopen the file-backed database and preserve the review;
7. reject exclusion of a non-eligible or missing listing.

Use direct SQL only to assert the audit count:

```ts
expect(repository.excludeListing(key, input, now).manualReview)
  .toMatchObject({
    excluded: true,
    reason: "price_overvalued",
    note: "同价位更安全",
    reviewedAt: now.toISOString()
  });

expect(
  database.prepare(
    "SELECT COUNT(*) AS count FROM manual_listing_reviews"
  ).get()
).toEqual({ count: 1 });
```

- [ ] **Step 2: Run repository tests and verify RED**

Run:

```bash
pnpm vitest run tests/server/repository.test.ts
```

Expected: FAIL because the table and repository methods do not exist.

- [ ] **Step 3: Add the idempotent database schema**

Add the approved table and index exactly as specified in the design document. Do not add a foreign key to `listings`.

- [ ] **Step 4: Implement batch decoration and transactions**

Add repository methods:

```ts
getReviewedListings(eligibility?: Eligibility): ReviewedListing[];
getReviewedListing(key: string): ReviewedListing | null;
excludeListing(
  key: string,
  input: ManualExclusionInput,
  now?: Date
): ReviewedListing;
restoreListing(key: string, now?: Date): ReviewedListing;
```

Use one latest-event query for all current keys:

```sql
SELECT review.listing_key, review.action, review.reason_code,
       review.note, review.created_at
FROM manual_listing_reviews AS review
JOIN (
  SELECT listing_key, MAX(id) AS id
  FROM manual_listing_reviews
  GROUP BY listing_key
) AS latest ON latest.id = review.id
```

`excludeListing` and `restoreListing` must call the existing nested-safe `runTransaction`. They must read the current listing inside the transaction, enforce eligibility, compare the latest event for idempotency, append only when state changes, and return a freshly decorated listing.

- [ ] **Step 5: Run repository tests and verify GREEN**

Run:

```bash
pnpm vitest run tests/server/repository.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/db.ts src/server/repository.ts tests/server/repository.test.ts
git commit -m "feat: persist manual listing reviews"
```

## Task 3: Apply manual decisions to API views and candidate pools

**Files:**

- Modify: `src/server/app.ts`
- Modify: `tests/server/api.test.ts`

- [ ] **Step 1: Write failing API behavior tests**

Create 11 eligible Jiaoyimao listings plus eligible Panzhi/PXB7 records. Assert:

- excluding the current Jiaoyimao rank 1 removes it from balanced and global pools;
- Jiaoyimao rank 11 fills the vacated balanced slot;
- all eligible excludes the reviewed account;
- rejected includes it once with `manualReview`;
- source `eligibleCount` and candidate counts match the visible collections;
- restoring removes it from rejected and makes it eligible again;
- refresh/repository snapshot replacement does not clear the exclusion.

Add endpoint validation cases:

```ts
await request(app)
  .put(`/api/listings/${encodeURIComponent(key)}/manual-exclusion`)
  .send({ reason: "other", note: "" })
  .expect(400, {
    error: "invalid_manual_review",
    message: "人工淘汰信息无效"
  });
```

Also cover unknown key, hard-rejected listing, 501-character note, unknown fields, and idempotent DELETE.

- [ ] **Step 2: Run API tests and verify RED**

Run:

```bash
pnpm vitest run tests/server/api.test.ts
```

Expected: FAIL because reviewed views and mutation routes do not exist.

- [ ] **Step 3: Build reviewed snapshots**

Change `readCurrentListingSnapshot` to use `repository.getReviewedListings()`. Compute:

```ts
const activeEligibleListings = listings.filter(
  (listing) =>
    activeSources.has(listing.source) &&
    listing.eligibility === "eligible" &&
    listing.manualReview === null
);
```

For `view=all&status=rejected`, return the union of hard-rejected listings and all current `manualReview !== null` listings, de-duplicated by key and sorted with `compareRecommendations`.

For `status=eligible`, filter out manual reviews. Leave `needs_verification` unchanged unless a future feature permits reviewing that state.

- [ ] **Step 4: Add the two mutation routes**

Implement:

```ts
app.put("/api/listings/:key/manual-exclusion", ...);
app.delete("/api/listings/:key/manual-exclusion", ...);
```

Parse the PUT body with `parseManualExclusionInput`. Map repository errors to the stable error codes in the specification without exposing SQL text or payload content.

- [ ] **Step 5: Run API and candidate tests and verify GREEN**

Run:

```bash
pnpm vitest run tests/server/api.test.ts tests/domain/candidatePool.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/app.ts tests/server/api.test.ts
git commit -m "feat: exclude reviewed accounts from candidate pools"
```

## Task 4: Add the client API and accessible review form

**Files:**

- Modify: `src/client/api.ts`
- Create: `src/client/components/ManualReviewDialog.tsx`
- Create: `tests/client/ManualReviewDialog.test.tsx`
- Modify: `tests/client/App.test.tsx`

- [ ] **Step 1: Write failing dialog tests**

Assert:

- the dialog has `role=dialog`, a heading, radio group, textarea, cancel, and submit;
- no reason prevents submission;
- `other` without a trimmed note displays the approved error;
- a valid reason and note submit normalized input once;
- pending submission disables controls;
- a server error keeps the selections and displays the error.

- [ ] **Step 2: Run dialog tests and verify RED**

Run:

```bash
pnpm vitest run tests/client/ManualReviewDialog.test.tsx
```

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Extend the API contract**

Change listing responses to `ReviewedListing[]` / `ReviewedListing` and add:

```ts
excludeListing(
  key: string,
  input: ManualExclusionInput
): Promise<ReviewedListing>;
restoreListing(key: string): Promise<ReviewedListing>;
```

Use `PUT` and `DELETE` with `Content-Type: application/json` only where a body exists. Add safe messages for the four stable review error codes.

Extend the shared fake `ScoutApi` factory in `tests/client/App.test.tsx`
with default exclude/restore methods so the existing App suite remains
type-safe before Task 5 adds behavioral assertions.

- [ ] **Step 4: Implement the minimal dialog**

Keep form state inside the dialog, use the exported reason labels, enforce the same client validation for fast feedback, and still rely on server validation as authoritative. Do not close on error.

- [ ] **Step 5: Run dialog and API-client compilation tests**

Run:

```bash
pnpm vitest run tests/client/ManualReviewDialog.test.tsx
pnpm typecheck
```

Expected: dialog tests PASS and typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/client/api.ts src/client/components/ManualReviewDialog.tsx \
  tests/client/ManualReviewDialog.test.tsx tests/client/App.test.tsx
git commit -m "feat: add manual review client contract"
```

## Task 5: Integrate exclusion and restore into the candidate UI

**Files:**

- Modify: `src/client/App.tsx`
- Modify: `src/client/components/ListingDetail.tsx`
- Modify: `src/client/components/DetailDrawer.tsx`
- Modify: `src/client/components/ListingTable.tsx`
- Modify: `tests/client/App.test.tsx`
- Modify: `tests/client/ListingDetail.test.tsx`

- [ ] **Step 1: Write failing detail tests**

For an unreviewed eligible listing, expect exactly one “人工淘汰” button. For a manually excluded listing, expect reason, note, time, and exactly one “恢复参与排名” button. Assert the mobile drawer passes identical callbacks.

- [ ] **Step 2: Write failing App flow tests**

Exercise:

1. open a candidate;
2. click “人工淘汰”;
3. select “价格虚高” and enter a note;
4. submit;
5. assert `api.excludeListing` receives the stable key and normalized input;
6. assert sources/current view reload, detail closes, success notice appears, and a broadcast event is posted;
7. switch to rejected, open the reviewed listing, restore it, and verify reload/notice.

Add failure cases proving the candidate and form remain visible. Add a received `listing-review-changed` broadcast test proving another tab reloads without clearing current data first.

- [ ] **Step 3: Run client tests and verify RED**

Run:

```bash
pnpm vitest run tests/client/ListingDetail.test.tsx tests/client/App.test.tsx
```

Expected: FAIL because the callbacks and App state do not exist.

- [ ] **Step 4: Add shared detail actions**

Extend `ListingDetail` and `DetailDrawer` with:

```ts
onExclude?: (listing: ReviewedListing) => void;
onRestore?: (listing: ReviewedListing) => void;
reviewPending?: boolean;
reviewError?: string | null;
```

Show the exclusion action only for unreviewed eligible listings. Show the review summary and restore action only when `manualReview !== null`. Add the reason badge to `ListingTable` only when present.

- [ ] **Step 5: Add App mutation state and synchronization**

Maintain selected review target, dialog visibility, pending/error state, and a non-destructive success notice. On success:

```ts
await Promise.all([
  api.getSources(activePoolMode.current),
  api.getListings(activeView.current, activePoolMode.current)
]);
broadcastRef.current?.postMessage({
  type: "listing-review-changed",
  key
});
```

Use the existing sequence guards to ignore stale reloads. Close the detail/drawer only after the mutation succeeds. Received broadcasts call the existing preserve-on-error load path.

- [ ] **Step 6: Run client tests and verify GREEN**

Run:

```bash
pnpm vitest run \
  tests/client/ManualReviewDialog.test.tsx \
  tests/client/ListingDetail.test.tsx \
  tests/client/App.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/client/App.tsx src/client/components/ListingDetail.tsx \
  src/client/components/DetailDrawer.tsx \
  src/client/components/ListingTable.tsx \
  tests/client/App.test.tsx tests/client/ListingDetail.test.tsx
git commit -m "feat: manage manual exclusions in the candidate UI"
```

## Task 6: Style, document, and verify the complete feature

**Files:**

- Modify: `src/client/styles.css`
- Modify: `README.md`
- Test: all test files

- [ ] **Step 1: Add focused responsive styles**

Style the manual-review badge, detail summary, destructive action, modal backdrop/card, radio choices, note counter, validation message, pending state, and mobile layout. Reuse existing colors and spacing variables; preserve visible focus rings and reduced-motion behavior.

- [ ] **Step 2: Update README**

Document:

- how to mark and restore an account;
- that decisions survive refreshes/restarts and future reappearance;
- that feedback currently excludes only the exact listing;
- that reasons are stored locally for future scoring analysis;
- that this version does not automatically learn weights.

- [ ] **Step 3: Run focused and full verification**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

Expected: all commands exit 0 with no failed tests.

- [ ] **Step 4: Run browser acceptance on a temporary database**

Copy the current trusted database to a temporary file, start the API/UI on isolated ports, and verify the eight browser scenarios in the design. After acceptance:

```bash
sqlite3 /path/to/temp.sqlite "PRAGMA integrity_check;"
```

Expected: `ok`. Remove only the explicitly created temporary database and stop the isolated test processes. Do not write test feedback to the user’s trusted database.

- [ ] **Step 5: Review branch scope**

Run:

```bash
git status --short --branch
git diff --stat master...HEAD
git log --oneline master..HEAD
```

Expected: only the approved manual-review feature, tests, spec, plan, and README changes.

- [ ] **Step 6: Commit**

```bash
git add src/client/styles.css README.md
git commit -m "docs: explain persistent manual exclusions"
```

- [ ] **Step 7: Finish the branch**

Use `superpowers:verification-before-completion` and `superpowers:finishing-a-development-branch`. The user already selected direct execution; keep the feature worktree until the verified branch is integrated.
