# Panzhi Strict Empty Results Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a strictly proven empty Panzhi result complete safely without treating missing or ambiguous page structure as success.

**Architecture:** The content selector recognizes one exact live virtual-list empty fingerprint and exposes it through `ResultState`. The runner emits an explicit `empty_result` zero snapshot only after all visible filters are strictly verified. The background and server accept zero items only for that exact contract; quick publish preserves the complete baseline and deep publish remains protected by the existing anomaly guard.

**Tech Stack:** TypeScript, Chrome Manifest V3, DOM selectors, Zod, SQLite, Vitest, esbuild.

---

### Task 1: Strict live empty-result selector

**Files:**
- Modify: `tests/fixtures/panzhi-live-filter-page.html`
- Modify: `tests/extension/panzhiPageRunner.test.ts`
- Modify: `extensions/panzhi-auto-refresh/src/pageSelectors.ts`

- [ ] **Step 1: Write the failing selector tests**

Add a fixture branch with one visible `.goods-list-with-game > .virtual-list` containing one phantom, one container and one visible `.empty` marker, with no goods anchors. Assert `readResultState()` returns:

```ts
{
  kind: "result-state",
  signature: "empty",
  visibleIds: [],
  loadingVisible: false,
  endMarkerVisible: true,
  emptyResultVisible: true
}
```

Add separate negative tests for duplicate virtual lists, hidden `.empty`, loading state and a generic empty div outside the approved branch.

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
pnpm vitest run tests/extension/panzhiPageRunner.test.ts --exclude '.worktrees/**'
```

Expected: the positive case fails with `Missing unique Panzhi result container`; all negative cases retain their existing failure behavior.

- [ ] **Step 3: Implement the minimal strict recognizer**

Add a helper that returns a container only when every approved structure count is exactly one, the marker is visible, there are zero visible cards and loading is absent. Add `emptyResultVisible` to `ResultState`; never infer empty solely from a class token or zero anchors.

- [ ] **Step 4: Run the selector tests and verify GREEN**

Run the Task 1 command and expect all selector tests to pass.

- [ ] **Step 5: Commit**

```bash
git add tests/fixtures/panzhi-live-filter-page.html tests/extension/panzhiPageRunner.test.ts extensions/panzhi-auto-refresh/src/pageSelectors.ts
git commit -m "fix: recognize strict Panzhi empty results"
```

### Task 2: Runner zero-snapshot behavior

**Files:**
- Modify: `extensions/panzhi-auto-refresh/src/contracts.ts`
- Modify: `extensions/panzhi-auto-refresh/src/pageRunner.ts`
- Modify: `tests/extension/panzhiPageRunner.test.ts`

- [ ] **Step 1: Write failing runner tests**

Assert a quick run over the strict empty fixture returns:

```ts
{
  kind: "snapshot",
  stage: "submitting",
  snapshot: expect.objectContaining({
    mode: "quick",
    loadActionCount: 1,
    observedUniqueCount: 0,
    stopReason: "empty_result",
    items: []
  })
}
```

Assert `loadMore` is never called, and add a verification-dialog variant that returns `awaiting_user_verification` instead.

- [ ] **Step 2: Run and verify RED**

Run the page-runner test file. Expected: empty result currently fails before snapshot creation.

- [ ] **Step 3: Implement minimal runner support**

Add `empty_result` to the snapshot contract. Permit a selected filter action to settle without result growth only when the initial state is strictly empty. After filter verification, short-circuit collection when `emptyResultVisible` is true and create the zero snapshot without scrolling.

- [ ] **Step 4: Run and verify GREEN**

Run the page-runner tests and expect all to pass.

- [ ] **Step 5: Commit**

```bash
git add extensions/panzhi-auto-refresh/src/contracts.ts extensions/panzhi-auto-refresh/src/pageRunner.ts tests/extension/panzhiPageRunner.test.ts
git commit -m "feat: emit proven empty Panzhi snapshots"
```

### Task 3: Strict background protocol parsing

**Files:**
- Modify: `extensions/panzhi-auto-refresh/src/background.ts`
- Modify: `tests/extension/panzhiBackground.test.ts`

- [ ] **Step 1: Write failing parser tests**

Accept only the exact zero combination with `empty_result`, count zero, empty items and one load action. Reject zero arrays with `quick_window`, nonzero arrays with `empty_result`, or load count other than one.

- [ ] **Step 2: Run and verify RED**

```bash
pnpm vitest run tests/extension/panzhiBackground.test.ts --exclude '.worktrees/**'
```

Expected: the strict parser rejects the valid zero snapshot before implementation.

- [ ] **Step 3: Implement the parser branch**

Keep all non-empty checks unchanged and add one explicit empty-result branch; do not weaken URL, proof, item or count validation.

- [ ] **Step 4: Run and verify GREEN**

Run the Task 3 command and expect all tests to pass.

- [ ] **Step 5: Commit**

```bash
git add extensions/panzhi-auto-refresh/src/background.ts tests/extension/panzhiBackground.test.ts
git commit -m "feat: parse proven empty Panzhi snapshots"
```

### Task 4: Server schema and publication safety

**Files:**
- Modify: `src/server/panzhiBrowserSnapshot.ts`
- Modify: `tests/server/panzhiBrowserSnapshot.test.ts`
- Modify: `tests/server/panzhiAutomationPublisher.test.ts`
- Modify: `tests/server/panzhiAutomationApi.test.ts`

- [ ] **Step 1: Write failing schema tests**

Test the valid empty-result payload and reject every inconsistent combination. Keep the existing in-range-item rule for all non-empty stop reasons.

- [ ] **Step 2: Write failing publisher tests**

Seed a complete baseline, publish quick `empty_result`, and assert all baseline listings remain with `observedItemCount: 0`. Seed a deep baseline, publish deep `empty_result`, and assert the anomaly guard quarantines it and retains trusted listings. Add an API completion test proving the job response remains atomic.

- [ ] **Step 3: Run and verify RED**

```bash
pnpm vitest run tests/server/panzhiBrowserSnapshot.test.ts tests/server/panzhiAutomationPublisher.test.ts tests/server/panzhiAutomationApi.test.ts --exclude '.worktrees/**'
```

Expected: Zod rejects zero items before implementation.

- [ ] **Step 4: Implement the schema refinement**

Change base count/array/load minima to permit zero/one, then use `superRefine` to allow them only for `empty_result`. Require exact zero items/count and load action one for empty; require at least one item/count, two loads and an in-range listing otherwise.

- [ ] **Step 5: Run and verify GREEN**

Run the Task 4 command and expect all tests to pass without weakening existing negative cases.

- [ ] **Step 6: Commit**

```bash
git add src/server/panzhiBrowserSnapshot.ts tests/server/panzhiBrowserSnapshot.test.ts tests/server/panzhiAutomationPublisher.test.ts tests/server/panzhiAutomationApi.test.ts
git commit -m "feat: publish safe empty Panzhi results"
```

### Task 5: Version, docs, build and regression

**Files:**
- Modify: `extensions/panzhi-auto-refresh/manifest.json`
- Modify: `extensions/panzhi-auto-refresh/README.md`
- Modify: `docs/panzhi-browser-snapshot-runbook.md`
- Modify: `tests/extension/panzhiManifest.test.ts`

- [ ] **Step 1: Bump and document version `0.2.1`**

Document the exact empty-result fingerprint, quick baseline preservation, deep anomaly isolation and unchanged verification behavior.

- [ ] **Step 2: Run focused tests and strict typecheck**

```bash
pnpm vitest run tests/extension tests/server/panzhiBrowserSnapshot.test.ts tests/server/panzhiAutomationPublisher.test.ts tests/server/panzhiAutomationApi.test.ts --exclude '.worktrees/**'
pnpm typecheck
```

Expected: all commands exit zero.

- [ ] **Step 3: Build and inspect the unpacked extension**

```bash
pnpm build:panzhi-extension
```

Verify `dist/manifest.json` is `0.2.1` and both bundles contain `empty_result`.

- [ ] **Step 4: Run the full suite**

```bash
pnpm vitest run --exclude '.worktrees/**'
```

Expected: every test file passes.

- [ ] **Step 5: Commit exact task files only**

Stage only the approved Panzhi files and documentation hunks; preserve every unrelated dirty file.

### Task 6: Real Chrome acceptance

**Files:** none.

- [ ] **Step 1: Reload extension `0.2.1`**

Confirm the Chrome extension card displays `0.2.1`.

- [ ] **Step 2: Run a quick job**

Queue `/api/refresh/source/panzhi` with `{"mode":"quick"}`. Expect `success`, `scanRunId` present, observed zero if still empty, and the current 48 baseline listings retained.

- [ ] **Step 3: Run deep safety acceptance**

Queue deep refresh. If the same strict empty state remains, expect anomaly isolation and no listing deletion. Do not redefine quarantined data as a successful full replacement.

- [ ] **Step 4: Verify human intervention and recovery**

When a real CAPTCHA/slider/login wall appears, leave it to the user and confirm automatic continuation after it disappears. Restart the Service Worker during a non-verification lease and confirm one recovery reload; verify no reload occurs while waiting for user verification.

- [ ] **Step 5: Final audit**

Compare every objective requirement with live API, database, build and test evidence before marking the goal complete.
