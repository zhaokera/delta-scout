# Panzhi Chrome Auto Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Panzhi scheduler's manual-attention dead end with a recoverable Chrome-extension job that automatically applies filters, collects a quick or deep snapshot, and pauses only for user verification.

**Architecture:** Keep `refresh_schedule` authoritative for cadence and add a separate single-active-job repository for Panzhi browser work. A shared publisher owns snapshot validation and listing publication; its automation path completes the scan, job, and schedule inside one SQLite transaction. A Manifest V3 service worker polls localhost, deterministically reuses one Panzhi tab, and injects a pure DOM runner whose behavior is fixture-tested independently of Chrome.

**Tech Stack:** TypeScript 7, Express 5, SQLite (`node:sqlite`), Zod 4, Vitest 4, React 19, Chrome Manifest V3, esbuild.

---

## Working-copy constraint

This repository already contains uncommitted Panzhi quick-snapshot and scoring work that this feature depends on. Do not reset, stash, overwrite, or mechanically reformat those edits. Implement in the current worktree, inspect `git diff -- <file>` before modifying an already-dirty file, and stage only files or hunks owned by this plan. For every commit: stage new files normally, use `git add -p -- <dirty-existing-file>` for existing dirty files, inspect the complete `git diff --cached`, and unstage any hunk that is not solely owned by this plan. Never use a whole-file `git add` command on a path that was dirty before this plan.

## Task 1: Persist Panzhi automation jobs and extension heartbeat

**Files:**

- Modify: `src/server/db.ts`
- Create: `src/server/panzhiAutomation/contracts.ts`
- Create: `src/server/panzhiAutomation/repository.ts`
- Test: `tests/server/panzhiAutomationRepository.test.ts`

- [ ] **Step 1: Write failing repository tests**

Cover these cases with an in-memory database:

- only one nonterminal job may exist;
- a queued `quick` job upgrades in place to `deep`;
- `deep` requested after `collecting`, `awaiting_user_verification`, or `submitting` leaves the current mode unchanged and leaves `refresh_schedule.next_deep_at` due as the single persisted source of truth;
- same/lower-priority requests return the existing job ID;
- extension heartbeat is connected for 120 seconds and disconnected afterward;
- expired leases requeue the same persisted job without creating another;
- persisted rows never contain the plaintext execution token.

Run: `pnpm vitest run tests/server/panzhiAutomationRepository.test.ts`

Expected: FAIL because the schema and repository do not exist.

- [ ] **Step 2: Add strict contracts and schema**

In `contracts.ts`, define Zod schemas and inferred types for:

- modes `quick | deep`;
- states `queued | opening_page | applying_filters | collecting | awaiting_user_verification | submitting | success | failed | cancelled`;
- public job/status views;
- claim, heartbeat, stage-update, and cancellation responses;
- terminal-state and transition helpers.

In `db.ts`, add:

- `panzhi_browser_jobs`, including UUID ID, mode, state, lease owner/token digest/expiry, verification deadline/notified timestamp, normalized request digest, result JSON, error, scan run ID, and timestamps;
- a partial unique index allowing only one nonterminal job;
- `panzhi_extension_status` as a one-row heartbeat table;
- checks and foreign keys that prevent successful jobs without a published scan result.

- [ ] **Step 3: Implement the transactional repository**

Implement explicit methods for:

- `enqueue(mode, now)` with the coalescing/upgrade rules;
- `recordExtensionHeartbeat(now)` and `getStatus(now)`;
- `claim(now)` and `resume(jobId, token, now)` with a random 256-bit token and SHA-256 digest storage;
- `heartbeat`, `transition`, `cancel`, `requeueExpiredLease`, and `failExpiredVerification`;
- constant-time bearer verification;
- `getAuthorizedJobForSnapshot` and idempotent result lookup;
- transaction-scoped completion methods used later by the publisher, including exact-body idempotent replay lookup.

Use a 2-minute normal lease, a 30-second extension heartbeat cadence, a 2-minute connected window, and a 24-hour verification deadline.

- [ ] **Step 4: Run focused tests**

Run: `pnpm vitest run tests/server/panzhiAutomationRepository.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the persistence slice**

Stage new files normally; stage only this task's `src/server/db.ts` hunks with `git add -p`, then inspect `git diff --cached` before committing `feat: persist Panzhi browser automation jobs`.

## Task 2: Make scan publication composable and atomic

**Files:**

- Modify: `src/server/repository.ts`
- Modify: `tests/server/repository.test.ts`
- Create: `src/server/panzhiAutomation/publisher.ts`
- Create: `tests/server/panzhiAutomationPublisher.test.ts`

- [ ] **Step 1: Write rollback and idempotency-facing publisher tests**

Test that:

- manual quick and deep payloads produce the same counts and merge behavior as the current route;
- a quick snapshot without a prior Panzhi baseline returns `panzhi_complete_snapshot_required`;
- a thrown automation completion hook rolls back listings, observations, refresh events, scan result, the single scan run, job state, and schedule changes;
- a successful hook sees the final `runId`, scan state, publication flag, and response payload before commit.

Run: `pnpm vitest run tests/server/panzhiAutomationPublisher.test.ts tests/server/repository.test.ts`

Expected: FAIL because there is no shared publisher or transaction hook.

- [ ] **Step 2: Refactor repository publication onto nested-safe transactions**

Change `ListingRepository.commitScanRefresh` to use its existing `runTransaction` helper instead of owning `BEGIN/COMMIT` directly. Add a narrowly typed optional `beforeCommit(result)` hook that executes after listings, source status, observations, events, and the scan row have been written but before the surrounding transaction commits.

Add a public `runInTransaction<T>(operation)` wrapper and ensure `startScopedScan` plus `commitScanRefresh` use savepoints when called inside it. Keep all existing call sites source-compatible. The outer transaction, not the publisher's caller, creates exactly one scoped scan by invoking the publisher once.

- [ ] **Step 3: Extract the shared Panzhi snapshot publisher**

Move the existing route logic from `src/server/app.ts` into `PanzhiSnapshotPublisher.publish(snapshot, capturedAt, beforeCommit?)`. The publisher owns one `repository.runInTransaction` call and creates exactly one scoped scan inside it:

- parse/build using `PanzhiBrowserSnapshotSchema` and `buildPanzhiBrowserListings`;
- quick-baseline check and `mergePanzhiQuickListings`;
- observed/preserved/page counts;
- scoped scan creation and `commitScanRefresh`;
- anomaly/quarantine result derivation;
- expose `published` in its result; if anomaly protection quarantines the snapshot, invoke the hook with `published: false`, keep the prior listings, and finish the new scan as partial/quarantined inside the same transaction;
- for errors before the transaction commits, roll back the newly created scan instead of issuing a second `failScan` write.

Return one stable result object used by both HTTP routes.

- [ ] **Step 4: Run focused and existing snapshot tests**

Run: `pnpm vitest run tests/server/panzhiAutomationPublisher.test.ts tests/server/panzhiBrowserSnapshot.test.ts tests/server/repository.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the publication slice**

Stage new files normally; use `git add -p` for the already-dirty repository and test files, inspect `git diff --cached`, then commit `refactor: share atomic Panzhi snapshot publishing`.

## Task 3: Expose authenticated automation endpoints

**Files:**

- Create: `src/server/panzhiAutomation/service.ts`
- Modify: `src/server/app.ts`
- Modify: `src/server/index.ts`
- Modify: `tests/server/api.test.ts`
- Create: `tests/server/panzhiAutomationApi.test.ts`

- [ ] **Step 1: Write failing API lifecycle tests**

Exercise the real Express app with an in-memory database:

- `GET /api/sources/panzhi/automation/status` exposes connection/current stage but no token or token digest;
- `POST /heartbeat` accepts only `{}`;
- `POST /jobs/claim` claims or resumes the current job and returns a bearer token;
- job heartbeat and allowed state changes require the correct token;
- invalid token is `401`, absent/expired job is `404`, illegal transition is `409`, malformed bodies are `400`;
- entering verification sends only one notification marker, leaving it clears that marker, and 24-hour expiry fails with `captcha_required`;
- snapshot success atomically marks the job and schedule;
- a quarantined snapshot atomically marks the job failed/partial, applies backoff without advancing either due timestamp, and retains the prior trusted snapshot;
- retrying the same successful snapshot returns the identical result with `deduplicated: true` and no second scan run/event;
- after success, the old token is rejected for heartbeat/state/cancel/different snapshots but an exact same-body snapshot replay returns the stored response;
- cancellation invalidates the token.

Run: `pnpm vitest run tests/server/panzhiAutomationApi.test.ts`

Expected: FAIL with 404 routes.

- [ ] **Step 2: Implement the application service**

Create `PanzhiAutomationService` as the only layer allowed to combine job repository, schedule repository, snapshot publisher, admission controller, and tracker. It must:

- recover expired leases before status/claim operations;
- upgrade an enqueued `quick` request to `deep` before claim when no complete trusted Panzhi baseline exists;
- authorize every job mutation;
- keep verification leases renewable while enforcing the independent deadline;
- publish under `admission.withAllSourcesLease`;
- call the publisher once; its transaction hook atomically completes the job and updates the schedule using the publisher-created `runId`;
- mark a published snapshot `success` and advance only the effective mode's cadence; mark an unpublished quarantine as failed/partial with backoff and no cadence advance;
- after success, clear lease ownership but retain a snapshot-only replay digest; return the stored result only when job ID, completed bearer digest, and canonical body digest all match, without treating that replay as authorization for any other endpoint;
- retain a collected payload in the extension for bounded retries when publication receives `refresh_conflict`.

- [ ] **Step 3: Wire all routes and preserve the manual route**

Add the seven `/api/sources/panzhi/automation` routes from the design. Rework the existing `/api/sources/panzhi/browser-snapshot` route to call `PanzhiSnapshotPublisher` without job authentication. Add a dedicated error mapper so Panzhi automation errors do not reuse Trading Cat messages.

Construct and recover the repository/service in `src/server/index.ts`; run expired-lease and verification-deadline maintenance from the existing 60-second maintenance interval.

- [ ] **Step 4: Run focused API regression tests**

Run: `pnpm vitest run tests/server/panzhiAutomationApi.test.ts tests/server/api.test.ts tests/server/panzhiBrowserSnapshot.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the API slice**

Stage new files normally; use `git add -p` for `app.ts`, `index.ts`, and existing tests, inspect `git diff --cached`, then commit `feat: add authenticated Panzhi automation API`.

## Task 4: Queue browser work from the refresh scheduler

**Files:**

- Modify: `src/server/refreshScheduler.ts`
- Modify: `src/server/index.ts`
- Modify: `src/client/api.ts`
- Modify: `tests/server/refreshScheduler.test.ts`
- Modify: `tests/server/api.test.ts`

- [ ] **Step 1: Replace the manual-attention expectation with failing queue tests**

Test that:

- due and manual Panzhi quick/deep triggers return `{ kind: "queued", jobId, source: "panzhi", mode }`;
- scheduler ticks do not advance either due time merely by enqueuing;
- repeated ticks coalesce instead of creating more jobs;
- the first automatic `quick` trigger becomes one `deep` job when no complete trusted Panzhi baseline exists;
- a due deep request remains due while a quick job is already collecting;
- service restart preserves `refresh_schedule.last_state = running` when a nonterminal Panzhi job exists, so `nextDue` neither duplicates nor loses it;
- a successful job advances only the completed mode's schedule;
- failure applies existing backoff and keeps old snapshot data;
- other-source conflicts still use the existing admission behavior.

Run: `pnpm vitest run tests/server/refreshScheduler.test.ts tests/server/api.test.ts`

Expected: FAIL because Panzhi still returns `attention_required`.

- [ ] **Step 2: Inject the Panzhi job repository/service into the scheduler**

Update `RefreshTriggerResult` with the queued variant, remove the Panzhi `attention_required` branch, and enqueue the effective mode transactionally. Mark the schedule as running for display without changing `nextQuickAt` or `nextDeepAt`. Make `nextDue` exclude Panzhi while a nonterminal Panzhi job exists; because `next_deep_at` remains unchanged, a deep request that arrives during an active quick job becomes due immediately after that job reaches a terminal state. On startup, do not convert a Panzhi `running` schedule to failed when the persisted nonterminal job still exists; reconcile the displayed schedule state from that job. Do not add a second `pending_deep` flag.

- [ ] **Step 3: Update API/client types and run tests**

Update `src/client/api.ts` to understand the new result union.

Run: `pnpm vitest run tests/server/refreshScheduler.test.ts tests/server/api.test.ts`

Expected: PASS.

- [ ] **Step 4: Commit the scheduler slice**

Use `git add -p` for every already-dirty path in this task, inspect `git diff --cached`, then commit `feat: queue Panzhi scheduled refreshes`.

## Task 5: Show extension health and automatic stages in the existing card

**Files:**

- Modify: `src/client/api.ts`
- Modify: `src/client/App.tsx`
- Modify: `src/client/components/RefreshAutomationPanel.tsx`
- Modify: `src/client/styles.css`
- Modify: `tests/client/App.test.tsx`
- Modify: `tests/client/RefreshAutomationPanel.test.tsx`

- [ ] **Step 1: Write failing UI tests**

Cover:

- connected/disconnected extension heartbeat copy;
- queued, opening, filtering, collecting, verification, submitting, success, and failed labels;
- a verification callout that tells the user to finish the visible Chrome challenge;
- quick/deep buttons enqueue jobs and do not navigate to Panzhi;
- disconnected setup guidance points to the loadable `extensions/panzhi-auto-refresh/dist/` directory;
- no new top-level navigation item is rendered.

Run: `pnpm vitest run tests/client/App.test.tsx tests/client/RefreshAutomationPanel.test.tsx`

Expected: FAIL with the current manual snapshot link.

- [ ] **Step 2: Poll and render automation status**

Add a typed `getPanzhiAutomationStatus()` client method. Poll while the refresh panel is mounted using the panel's existing refresh cadence, show the public job stage and last update, and preserve current controls for other sources.

Replace the Panzhi external-action link with the same quick/deep enqueue controls used by scheduled work. Keep a small diagnostics link only if it does not imply manual refresh is required.

- [ ] **Step 3: Run focused client tests**

Run: `pnpm vitest run tests/client/App.test.tsx tests/client/RefreshAutomationPanel.test.tsx`

Expected: PASS.

- [ ] **Step 4: Commit the UI slice**

Use `git add -p` for every pre-existing dirty path, stage any new test file normally, inspect `git diff --cached`, then commit `feat: show Panzhi Chrome automation status`.

## Task 6: Implement and fixture-test the visible-page runner

**Files:**

- Create: `extensions/panzhi-auto-refresh/src/contracts.ts`
- Create: `extensions/panzhi-auto-refresh/src/pageRunner.ts`
- Create: `extensions/panzhi-auto-refresh/src/pageSelectors.ts`
- Create: `tests/fixtures/panzhi-filter-page.html`
- Create: `tests/fixtures/panzhi-captcha-page.html`
- Create: `tests/extension/panzhiPageRunner.test.ts`

- [ ] **Step 1: Capture minimal, sanitized DOM fixtures**

Use the current public Panzhi directory markup only to identify stable accessibility text, labels, selected-state attributes, card URLs, price text, and blocking-page markers. Store the smallest sanitized fixtures needed for tests; do not store cookies, scripts, request headers, user identifiers, or signed API data.

- [ ] **Step 2: Write failing pure DOM tests**

Test that the runner:

- finds and applies price `1900–4000`, QQ official platform, secondary real-name availability, both red-skin values, and `ALL / 全部都要有`;
- verifies every selected filter before extraction;
- returns a strict `filterProof` matching the server schema;
- extracts unique visible cards with listing ID, URL, title, raw text, and price;
- detects captcha, slider, login wall, missing controls, and structural drift;
- stops quick mode at 6 loads or 60 unique cards;
- stops deep mode after two no-growth observations or the 100-load/500-card cap;
- never returns a snapshot while blocked by verification.

Run: `pnpm vitest run tests/extension/panzhiPageRunner.test.ts`

Expected: FAIL because the runner does not exist.

- [ ] **Step 3: Implement observable DOM operations**

Use semantic labels and selected-state evidence first, with narrowly scoped selectors as fallbacks. Await DOM/state changes via `MutationObserver` plus bounded timeouts. Add human-paced randomized waits between mutating actions. Return typed failures instead of guessing when required controls are missing.

The runner must restart at `applying_filters` after verification and must not read browser storage, cookies, page scripts, or network traffic.

- [ ] **Step 4: Run fixture tests**

Run: `pnpm vitest run tests/extension/panzhiPageRunner.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the page-runner slice**

Stage only the new files, inspect `git diff --cached`, then commit `feat: automate visible Panzhi page controls`.

## Task 7: Orchestrate one recoverable Chrome tab

**Files:**

- Create: `extensions/panzhi-auto-refresh/manifest.json`
- Create: `extensions/panzhi-auto-refresh/src/api.ts`
- Create: `extensions/panzhi-auto-refresh/src/tabSelection.ts`
- Create: `extensions/panzhi-auto-refresh/src/background.ts`
- Create: `extensions/panzhi-auto-refresh/src/content.ts`
- Create: `tests/extension/panzhiTabSelection.test.ts`
- Create: `tests/extension/panzhiBackground.test.ts`
- Create: `tests/extension/panzhiManifest.test.ts`
- Create: `tsconfig.extension.json`

- [ ] **Step 1: Write failing deterministic tab and lifecycle tests**

Mock the narrow `chrome.*` surface and test:

- canonical URL wins, then matching path, newest `lastAccessed`, then smallest tab ID;
- existing non-selected Panzhi tabs remain open;
- no candidate creates exactly one tab;
- overlapping alarms share one in-memory execution promise;
- active job ID/token/mode/tab ID survive in `chrome.storage.local`;
- restart resumes a valid lease, but a rejected/expired token clears state and reclaims;
- invalid tab ID triggers deterministic reselection;
- verification focuses the selected tab and emits one notification per continuous block;
- collected cards remain only in memory and are discarded on worker restart;
- submission conflicts retry the same payload with bounded exponential backoff and jitter.
- the tracked source manifest has exactly the approved permission/host allowlist and references the planned background/content entry points.

Run: `pnpm vitest run tests/extension/panzhiTabSelection.test.ts tests/extension/panzhiBackground.test.ts tests/extension/panzhiManifest.test.ts`

Expected: FAIL because the extension worker does not exist.

- [ ] **Step 2: Add least-privilege Manifest V3 configuration**

Declare only:

- host permissions for `https://www.pzds.com/*` and `http://127.0.0.1:4310/*`;
- permissions `alarms`, `tabs`, `scripting`, `storage`, and `notifications`;
- service worker and Panzhi-only content script entry points.

Do not request cookies, webRequest, history, downloads, clipboard, or broad `<all_urls>` access.

- [ ] **Step 3: Implement API, tab selection, and worker orchestration**

Poll localhost every 30–60 seconds, send the idle heartbeat, claim a queued job, persist ownership, and inject/start the content runner. Send job heartbeats every 30 seconds while active. On verification, pause page operations, update state, focus the selected tab, notify once, and periodically check only for the blocker disappearing before restarting filters.

On success or terminal failure, clear sensitive local job state. Do not close user tabs. Add a Chrome-typed extension TypeScript project that includes all `extensions/panzhi-auto-refresh/src/**/*.ts` files and is referenced by the root `typecheck` script.

- [ ] **Step 4: Run extension unit tests**

Run: `pnpm vitest run tests/extension/panzhiTabSelection.test.ts tests/extension/panzhiBackground.test.ts tests/extension/panzhiManifest.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the orchestration slice**

Stage only this task's new files, inspect `git diff --cached`, then commit `feat: orchestrate Panzhi refresh in Chrome`.

## Task 8: Build the unpacked extension and document setup

**Files:**

- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `scripts/build-panzhi-extension.mjs`
- Modify: `.gitignore`
- Modify: `README.md`
- Modify: `docs/panzhi-browser-snapshot-runbook.md`
- Create: `extensions/panzhi-auto-refresh/README.md`
- Create: `tests/extension/panzhiBuildConfig.test.ts`

- [ ] **Step 1: Write a failing build-wiring test**

Assert against tracked source files that `package.json` defines `build:panzhi-extension`, root `build` invokes it, root `typecheck` invokes `tsconfig.extension.json`, the build script has the expected background/content entry points and output directory, and `.gitignore` excludes only generated extension output. The unit test must not require ignored build output to exist.

Run: `pnpm vitest run tests/extension/panzhiBuildConfig.test.ts`

Expected: FAIL before package/build wiring exists.

- [ ] **Step 2: Add a deterministic extension build**

Add esbuild and `@types/chrome` as dev dependencies and scripts:

- `build:panzhi-extension` to bundle background/content entries into `extensions/panzhi-auto-refresh/dist/` and copy the manifest;
- include `tsc -p tsconfig.extension.json --noEmit` in `pnpm typecheck` and the extension bundle in `pnpm build`;
- keep generated `dist/` ignored, while leaving the source manifest and README tracked.

- [ ] **Step 3: Document one-time install and recovery**

Update docs with exact steps for `chrome://extensions`, Developer Mode, “Load unpacked,” selecting `extensions/panzhi-auto-refresh/dist/`, starting the localhost API, checking the existing refresh card, handling verification, and diagnosing a disconnected extension. Clearly retain the manual snapshot endpoint only as a diagnostic fallback.

- [ ] **Step 4: Build and test**

Run:

```bash
pnpm install
pnpm build:panzhi-extension
pnpm vitest run tests/extension/panzhiManifest.test.ts tests/extension/panzhiBuildConfig.test.ts
```

Expected: build succeeds and test passes.

- [ ] **Step 5: Commit build/docs**

Stage new files normally; use `git add -p` for every pre-existing dirty file, inspect `git diff --cached`, then commit `docs: package Panzhi Chrome automation`.

## Task 9: Full automated verification and real-Chrome handoff

**Files:**

- Modify only if failures reveal defects in files already owned by Tasks 1–8.

- [ ] **Step 1: Run all automated gates**

Run:

```bash
pnpm typecheck
pnpm vitest run --exclude '.worktrees/**'
pnpm build
git diff --check
```

Expected: all commands exit 0. If an unrelated pre-existing test fails, record the exact failure and prove it also occurs on the pre-feature baseline before classifying it as unrelated.

- [ ] **Step 2: Start the app persistently and verify localhost**

Run the API and client in a persistent session, then verify health, the refresh panel, extension heartbeat endpoint, job enqueue, and job claim without using real Panzhi credentials.

- [ ] **Step 3: Ask for the one-time Chrome installation confirmation**

Before opening `chrome://extensions` or installing/loading the unpacked extension, obtain the user's confirmation as required for browser extension installation. Point Chrome at the built `extensions/panzhi-auto-refresh/dist/` directory.

- [ ] **Step 4: Execute the real-browser acceptance checklist**

With the user's existing Chrome session:

1. run two quick refreshes and confirm one reused tab;
2. inspect the submitted proof/counts and published scan history;
3. run one deep refresh or a bounded deep-mode smoke test;
4. stop at a real or staged verification wall and confirm a single notification/no further actions;
5. after the user resolves it, confirm restart at filter application and successful publication;
6. restart Chrome and the local API separately and verify recovery;
7. confirm every failure keeps the previous trusted snapshot.

- [ ] **Step 5: Perform completion review**

Use `superpowers:verification-before-completion`, inspect `git status` and `git diff --stat`, and report separately:

- committed feature changes;
- pre-existing user changes left untouched;
- automated verification results;
- any real-Chrome steps that still require the user.
