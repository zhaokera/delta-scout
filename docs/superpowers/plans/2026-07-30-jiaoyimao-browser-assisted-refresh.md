# Jiaoyimao Browser-Assisted Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a durable Jiaoyimao-only refresh that lets Codex collect the complete filtered catalog and required detail evidence from the same user-verified in-app browser session, then safely publish it through the existing scoring and history system.

**Architecture:** A persisted browser-refresh job owns an authenticated localhost bridge, strictly validated staging tables, a restart-safe state machine, and a shared refresh-admission lease. Codex submits only visible text and page observations; the server parses and validates them, then a single-source publisher atomically replaces Jiaoyimao while preserving and re-scoring Panzhi and PXB7.

**Tech Stack:** TypeScript, Node.js, Express, Zod, SQLite, React, Vitest, Testing Library, Codex in-app Browser.

---

## File map

### Create

- `src/server/browserRefresh/contracts.ts` — stable job states, Zod bridge payloads, public views, and limits.
- `src/server/browserRefresh/visibleDetail.ts` — pure parser from bounded visible Jiaoyimao sections into `ListingDetail`.
- `src/server/browserRefresh/repository.ts` — browser job, credential hash, proof, event, staging, recovery, and cleanup persistence.
- `src/server/browserRefresh/completeness.ts` — filter-proof and natural-end validation.
- `src/server/browserRefresh/service.ts` — state machine, authenticated bridge commands, work queue, and completion orchestration.
- `src/server/refreshAdmission.ts` — shared atomic lease for all-sources and browser refreshes.
- `src/client/components/JiaoyimaoBrowserRefreshPanel.tsx` — dedicated button, claim code, progress, recovery, and cancellation UI.
- `scripts/jiaoyimao-browser-bridge.mjs` — reusable localhost client imported by future Codex browser runs.
- `tests/server/browserRefreshContracts.test.ts`
- `tests/server/browserRefreshVisibleDetail.test.ts`
- `tests/server/browserRefreshRepository.test.ts`
- `tests/server/browserRefreshCompleteness.test.ts`
- `tests/server/browserRefreshService.test.ts`
- `tests/server/refreshAdmission.test.ts`
- `tests/client/JiaoyimaoBrowserRefreshPanel.test.tsx`
- `tests/scripts/jiaoyimao-browser-bridge.test.ts`
- `docs/jiaoyimao-browser-refresh-runbook.md`

### Modify

- `src/server/collector/adapters/jiaoyimao.ts` — delegate visible-section parsing to the new pure parser.
- `src/server/db.ts` — idempotent browser-refresh tables, scan scope columns, indexes, and interrupted-job recovery.
- `src/server/repository.ts` — scoped scan creation and atomic single-source publish with all-source re-scoring.
- `src/server/app.ts` — browser-refresh routes and shared admission on both refresh entry points.
- `src/server/index.ts` — instantiate repository, service, publisher dependencies, and admission controller.
- `src/client/api.ts` — browser job request/response types and methods.
- `src/client/App.tsx` — panel integration, polling, cross-tab synchronization, and refresh conflict handling.
- `src/client/components/RefreshProgress.tsx` — keep all-source progress separate from browser job progress.
- `src/client/components/SourceStrip.tsx` — host the dedicated Jiaoyimao action without changing other source cards.
- `src/client/styles.css` — responsive panel and status styles.
- `tests/server/adapters.test.ts`
- `tests/server/repository.test.ts`
- `tests/server/api.test.ts`
- `tests/server/health.test.ts`
- `tests/client/App.test.tsx`
- `README.md`

## Task 1: Lock the bridge contracts and local visible-detail parsing

**Files:**

- Create: `src/server/browserRefresh/contracts.ts`
- Create: `src/server/browserRefresh/visibleDetail.ts`
- Test: `tests/server/browserRefreshContracts.test.ts`
- Test: `tests/server/browserRefreshVisibleDetail.test.ts`
- Modify: `src/server/collector/adapters/jiaoyimao.ts`
- Modify: `tests/server/adapters.test.ts`

- [ ] **Step 1: Write failing contract tests**

Cover:

```ts
expect(BrowserRefreshJobStateSchema.parse("awaiting_codex"))
  .toBe("awaiting_codex");
expect(BrowserRefreshJobStateSchema.parse("quarantined"))
  .toBe("quarantined");
expect(() =>
  BrowserDetailInputSchema.parse({
    sourceListingId: "1",
    url: "https://evil.example/1.html",
    observedAt: now,
    sections: { head: "x", report: "y", safety: "", description: "" }
  })
).toThrow();
expect(() =>
  BrowserDetailInputSchema.parse({
    sourceListingId: "1785384225212552",
    url: validUrl,
    observedAt: now,
    sections: {
      head: "x",
      report: "y",
      safety: "",
      description: "",
      cookie: "secret"
    }
  })
).toThrow();
```

Fix these limits in exported constants and tests:

```ts
export const BROWSER_REFRESH_LIMITS = {
  maxListItemsPerBatch: 25,
  maxDetailsPerBatch: 5,
  maxUniqueItems: 2_000,
  maxLoadEvents: 100,
  maxTitleChars: 500,
  maxCardTextChars: 4_000,
  maxSectionChars: 12_000,
  maxCombinedDetailTextChars: 32_000,
  maxFilterLabelChars: 100,
  maxClaimCodeChars: 64,
  maxPauseMessageChars: 500,
  maxBatchUtf8Bytes: 131_072
} as const;
```

Every list and detail batch schema must additionally run:

```ts
Buffer.byteLength(JSON.stringify(value), "utf8") <=
  BROWSER_REFRESH_LIMITS.maxBatchUtf8Bytes
```

as an aggregate refinement. This makes the contract byte-safe for Chinese text and leaves headroom below the existing 256 KiB Express JSON limit. Tests must use multibyte Chinese strings at, below, and above 128 KiB; a contract-valid request must reach Zod, while an oversized raw HTTP body returns 413.

- [ ] **Step 2: Run contract tests and verify RED**

Run:

```bash
pnpm test -- tests/server/browserRefreshContracts.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement strict Zod contracts**

Export:

```ts
export const BROWSER_REFRESH_SOURCE = "jiaoyimao" as const;
export const BrowserRefreshJobStateSchema = z.enum([
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
export const BrowserFilterProofSchema = z.strictObject({
  currentUrl: JiaoyimaoFilterUrlSchema,
  gameLabel: SafeFilterLabelSchema,
  platformLabel: SafeFilterLabelSchema,
  categoryLabel: SafeFilterLabelSchema,
  m7FilterLabels: z.array(SafeFilterLabelSchema).min(4).max(8),
  observedAt: IsoDateTimeSchema
});
export const BrowserListBatchSchema = z.strictObject({
  sequence: z.number().int().positive(),
  observedAt: IsoDateTimeSchema,
  items: z.array(BrowserListItemSchema)
    .min(1)
    .max(BROWSER_REFRESH_LIMITS.maxListItemsPerBatch)
});
export const BrowserLoadEventSchema = z.strictObject({
  sequence: z.number().int().positive(),
  observedUniqueCount: z.number().int().nonnegative().max(2_000),
  newItemCount: z.number().int().nonnegative().max(2_000),
  visibleTotalCount: z.number().int().nonnegative().max(2_000).nullable(),
  endMarkerVisible: z.boolean(),
  loadingVisible: z.boolean(),
  blockingState: z.enum(["none", "login", "captcha", "rate_limited", "error"]),
  observedAt: IsoDateTimeSchema,
  actionPermit: z.string().max(128).optional()
});
export const BrowserDetailBatchSchema = z.strictObject({
  sequence: z.number().int().positive(),
  items: z.array(BrowserDetailInputSchema)
    .min(1)
    .max(BROWSER_REFRESH_LIMITS.maxDetailsPerBatch),
  actionPermit: z.string().max(128).optional()
});
export const BrowserPauseSchema = z.strictObject({
  reason: BrowserPauseReasonSchema,
  message: SafePauseMessageSchema.optional()
});
export const BrowserCooldownSchema = z.strictObject({
  reason: z.literal("rate_limited")
});
```

Use strict objects throughout, exact Jiaoyimao origin/path checks, digit-only IDs, ISO timestamps, and non-negative finite prices. Every allowed visible-text field must pass `SafeVisibleTextSchema`, which rejects case-insensitive credential/script patterns including `cookie\s*[:=]`, `set-cookie`, `authorization\s*[:=]`, `bearer <value>`, `_m_h5_tk`, `password\s*[:=]`, `验证码答案\s*[:=]`, `校验码\s*[:=]`, `<script`, and `javascript:`. Plain platform UI such as “请完成验证码” remains allowed so blocking pages can be reported.

Add table-driven tests that place each forbidden pattern inside every allowed title, raw-text, section, label, and message field—not only in extra object keys.

Add list and detail batch aggregate UTF-8 tests and detail sequence tests.

- [ ] **Step 4: Write failing visible-detail parser tests**

Use the existing `tests/fixtures/jiaoyimao-detail.html` to derive the same four visible sections the adapter currently reads. Assert the new parser returns the same:

```ts
expect(detail.loginPlatform).toBe("qq");
expect(detail.service).toBe("official");
expect(detail.totalAssetsM).not.toBeNull();
expect(detail.evidence.some(({ text }) => text.includes("M7"))).toBe(true);
```

Add structure-failure and rare-finish text cases.

- [ ] **Step 5: Run parser tests and verify RED**

Run:

```bash
pnpm test -- tests/server/browserRefreshVisibleDetail.test.ts tests/server/adapters.test.ts
```

Expected: FAIL because `parseJiaoyimaoVisibleDetail` is absent.

- [ ] **Step 6: Extract the pure parser**

Implement:

```ts
export interface JiaoyimaoVisibleSections {
  head: string;
  report: string;
  safety: string;
  description: string;
}

export function parseJiaoyimaoVisibleDetail(
  sections: JiaoyimaoVisibleSections,
  summary: ListingSummary
): DetailParseResult;
```

Keep DOM selection in `jiaoyimao.ts`, move text-to-field parsing into the pure function, and make `parseDetail` delegate to it. The bridge never accepts pre-classified fields or full HTML.

- [ ] **Step 7: Run focused tests and commit**

Run:

```bash
pnpm test -- tests/server/browserRefreshContracts.test.ts tests/server/browserRefreshVisibleDetail.test.ts tests/server/adapters.test.ts
git add src/server/browserRefresh src/server/collector/adapters/jiaoyimao.ts tests/server/browserRefreshContracts.test.ts tests/server/browserRefreshVisibleDetail.test.ts tests/server/adapters.test.ts
git commit -m "feat: define Jiaoyimao browser bridge contracts"
```

Expected: focused tests PASS and commit succeeds.

## Task 2: Add restart-safe browser-refresh persistence

**Files:**

- Modify: `src/server/db.ts`
- Create: `src/server/browserRefresh/repository.ts`
- Test: `tests/server/browserRefreshRepository.test.ts`
- Modify: `tests/server/health.test.ts`

- [ ] **Step 1: Write failing migration and repository tests**

Test an in-memory database for:

- all required tables and indexes;
- idempotent second `createDatabase`;
- one non-terminal Jiaoyimao task;
- claim-code hash and bridge-token hash never returned from public reads;
- claim consumes the one-time code;
- list batch replay with the same hash is idempotent;
- detail batch replay with the same sequence/hash returns the original accepted progress even after its one-use action permit was consumed;
- sequence reuse with a different hash fails;
- details require an existing staged list item;
- interrupted `committing` becomes failed;
- other unfinished tasks become paused with their cursor intact;
- expired jobs become terminal and release admission.
- cleanup of a successful/quarantined job deletes list items, details, and batch payload hashes, but retains its filter proof, final two load events, counters, `scan_run_id`, and `published_run_id`;
- cleanup of failed/cancelled/expired jobs retains the lightweight job audit row and removes bulky staging.
- after creating 51 scan-linked successful/quarantined jobs, normal scan-history pruning removes the oldest scan, job, proof, and load evidence while retaining the newest 50.

- [ ] **Step 2: Run repository tests and verify RED**

Run:

```bash
pnpm test -- tests/server/browserRefreshRepository.test.ts
```

Expected: FAIL on missing tables/repository.

- [ ] **Step 3: Add idempotent schema migrations**

Create:

```text
browser_refresh_jobs
browser_refresh_filter_proofs
browser_refresh_load_events
browser_refresh_list_items
browser_refresh_details
browser_refresh_batches
```

Add `scope TEXT NOT NULL DEFAULT 'all_sources'` and nullable `requested_source` to `scan_runs`. Use a partial unique index so only one non-terminal Jiaoyimao task can exist. Store encoded salted hashes, never plaintext credentials.

- [ ] **Step 4: Implement `BrowserRefreshRepository`**

Methods:

```ts
createJob(now): CreatedBrowserRefreshJob;
getCurrentJob(now): BrowserRefreshJobView | null;
getJob(id, now): BrowserRefreshJobView | null;
claimJob(id, claimCode, now): ClaimedBrowserRefreshJob;
verifyBridgeToken(id, token, now): BrowserRefreshJobRecord;
saveFilterProof(
  id: string,
  proof: BrowserFilterProof,
  now: Date
): void;
acceptListBatch(
  id: string,
  batch: BrowserListBatch,
  now: Date
): AcceptedBatchView;
acceptLoadEvent(
  id: string,
  event: BrowserLoadEvent,
  now: Date
): AcceptedLoadEventView;
acceptDetailBatch(
  id: string,
  batch: BrowserDetailBatch,
  now: Date
): DetailProgressView;
transition(
  id: string,
  expected: readonly BrowserRefreshJobState[],
  next: BrowserRefreshJobState,
  patch: BrowserRefreshTransitionPatch,
  now: Date
): BrowserRefreshJobView;
recoverInterruptedJobs(now): void;
expireJobs(now): number;
cleanupTerminalStaging(now): number;
```

Generate opaque IDs and credentials with `node:crypto`; use `scryptSync` plus a random salt encoded into the stored hash. Compare with `timingSafeEqual`.

`expireJobs(now)` must run synchronously before `createJob`, `getCurrentJob`, `claimJob`, and every authenticated read/write. It atomically changes overdue non-terminal jobs to `expired` and clears credential hashes. Admission must not depend only on the returned expired-ID list: its `reconcile()` method re-reads the persisted state of its held browser job and releases the lease whenever that job is absent or terminal. In `index.ts`, schedule a 60-second maintenance tick that calls `admission.reconcile()` and `cleanupTerminalStaging`; call `.unref()` on the timer so it does not keep tests or shutdown alive.

`cleanupTerminalStaging` must:

1. retain the job row, filter proof, final two valid load events, counters, and scan linkage for `success` and `quarantined`;
2. remove `browser_refresh_list_items`, `browser_refresh_details`, and `browser_refresh_batches`;
3. retain only the lightweight job row for `failed`, `cancelled`, and `expired`;
4. run only after the formal publish/quarantine transaction is complete.

`browser_refresh_jobs.scan_run_id` must reference `scan_runs(id) ON DELETE CASCADE`; all proof/event/staging rows reference the job with `ON DELETE CASCADE`. Therefore existing 50-run pruning removes the corresponding completed browser job and retained audit evidence without orphans. Failed/cancelled/expired jobs with no scan link are pruned by age in the maintenance cleanup.

For authenticated detail submission, repository/service ordering is:

1. verify the bridge credential;
2. compute payload hash and look up `(job_id, kind = detail, sequence)`;
3. return the stored result immediately for an identical replay;
4. reject a different hash for the same sequence;
5. only for a new sequence, validate and consume the one-use action permit;
6. insert details and the batch audit atomically.

- [ ] **Step 5: Run focused tests and verify migration twice**

Run:

```bash
pnpm test -- tests/server/browserRefreshRepository.test.ts tests/server/health.test.ts
```

Expected: PASS, including a test opening an already-migrated database twice.

- [ ] **Step 6: Commit**

```bash
git add src/server/db.ts src/server/browserRefresh/repository.ts tests/server/browserRefreshRepository.test.ts tests/server/health.test.ts
git commit -m "feat: persist Jiaoyimao browser refresh jobs"
```

## Task 3: Implement completeness, staging, and work-queue rules

**Files:**

- Create: `src/server/browserRefresh/completeness.ts`
- Create: `src/server/browserRefresh/service.ts`
- Test: `tests/server/browserRefreshCompleteness.test.ts`
- Test: `tests/server/browserRefreshService.test.ts`
- Modify: `src/server/browserRefresh/repository.ts`

- [ ] **Step 1: Write failing completeness tests**

Cover:

```ts
expect(validateFilterProof(validProof)).toEqual({ kind: "ok" });
expect(validateFilterProof({ ...validProof, platformLabel: "微信" }))
  .toEqual({ kind: "invalid", reason: "filter_mismatch" });
expect(evaluateNaturalEnd([growth, zeroGrowth, zeroGrowth]))
  .toEqual({ kind: "complete", reason: "no_growth_twice" });
expect(evaluateNaturalEnd([growth, { ...zeroGrowth, loadingVisible: true }]))
  .toEqual({ kind: "incomplete", reason: "loading_visible" });
```

Also cover visible total count, CAPTCHA/login blocking state, non-consecutive sequences, decreasing unique counts, and safety limits.

- [ ] **Step 2: Run completeness tests and verify RED**

```bash
pnpm test -- tests/server/browserRefreshCompleteness.test.ts
```

Expected: FAIL because completeness functions do not exist.

- [ ] **Step 3: Implement pure completeness rules**

Export deterministic validators for:

- exact game/platform/category/M7 S/A/B/C proof;
- monotonic load events;
- explicit-total/end-marker completion;
- two consecutive normal zero-growth events;
- detail-required set: price unknown or `<= 6000`;
- publish readiness.

- [ ] **Step 4: Write failing service state-machine tests**

Test:

- only claim moves `awaiting_codex` to `collecting_list`;
- list batches require an accepted filter proof;
- completing list builds the detail work queue;
- `getWork` returns the next unfinished detail ID;
- pause/resume preserves sequence and cursor;
- CAPTCHA/login can only pause for user verification;
- cooldown schedule is 30s, 2m, 5m, 15m;
- requests before `cooldownUntil` fail with `cooldown_active` and the authoritative retry time;
- after cooldown, `getWork` issues exactly one short-lived action permit; only the next load event or detail batch may consume it;
- a used, expired, or mismatched action permit is rejected;
- a failed permitted action must either start the next cooldown or pause, and cannot silently request another permit;
- a successful page resets cooldown attempts;
- fifth rate-limit attempt pauses;
- normal list actions enforce a server-issued `nextActionAt` between 1,200–2,500 ms;
- normal detail actions enforce a server-issued `nextActionAt` between 2,000–3,500 ms;
- requests before `nextActionAt` fail with `action_too_early`;
- cancel is terminal and keeps formal snapshots untouched;
- completion refuses missing details or incomplete natural-end proof.

- [ ] **Step 5: Run service tests and verify RED**

```bash
pnpm test -- tests/server/browserRefreshService.test.ts
```

Expected: FAIL on missing service.

- [ ] **Step 6: Implement `JiaoyimaoBrowserTaskService`**

Keep all transitions in one table-driven guard. Persist every accepted command before returning. Return stable codes:

```text
browser_job_not_found
browser_job_conflict
browser_job_expired
bridge_unauthorized
invalid_transition
filter_mismatch
staging_invalid
list_incomplete
details_incomplete
safety_limit
cooldown_active
action_too_early
action_permit_required
action_permit_invalid
```

Inject `now` and `random` so delay and cooldown tests are deterministic. Persist `next_action_at`, `action_permit_hash`, `action_permit_expires_at`, and `action_permit_consumed_at` on the job. `getWork` must not return browser work before `nextActionAt` or `cooldownUntil`. When a cooldown expires, atomically issue one permit with a 60-second lifetime; consume it on the next outcome-bearing `load-events` or `details` request. A successful outcome clears `cooldown_attempt` and permit fields, then computes the next serial delay. A new rate-limit outcome increments the schedule and clears the permit.

Do not publish yet; inject a `completeJob(jobId)` callback so publisher integration stays isolated for Task 5.

- [ ] **Step 7: Run focused tests and commit**

```bash
pnpm test -- tests/server/browserRefreshCompleteness.test.ts tests/server/browserRefreshService.test.ts tests/server/browserRefreshRepository.test.ts
git add src/server/browserRefresh tests/server/browserRefreshCompleteness.test.ts tests/server/browserRefreshService.test.ts tests/server/browserRefreshRepository.test.ts
git commit -m "feat: stage complete browser refresh observations"
```

## Task 4: Add one atomic admission gate for both refresh paths

**Files:**

- Create: `src/server/refreshAdmission.ts`
- Test: `tests/server/refreshAdmission.test.ts`
- Modify: `src/server/app.ts`
- Modify: `tests/server/api.test.ts`

- [ ] **Step 1: Write failing admission tests**

Test:

```ts
const lease = controller.tryAcquire({ kind: "all_sources" });
expect(controller.tryAcquire({ kind: "browser", jobId: "job-1" }))
  .toEqual({ kind: "conflict", activeKind: "all_sources" });
lease.release();
expect(controller.tryAcquire({ kind: "browser", jobId: "job-1" }).kind)
  .toBe("acquired");
```

Add simultaneous Promise requests and persisted paused-job startup cases.

Also test both failure-cleanup paths:

- browser lease is released if `BEGIN IMMEDIATE`, the persisted conflict recheck, or job insert fails;
- all-source lease is released if `startScan` fails;
- two browser create calls cannot both commit a non-terminal job;
- an expired persisted browser job is expired and ignored before a new lease is granted.
- if `getCurrentJob` expires the held job before admission sees the returned ID, the next `reconcile`/`tryAcquire` still releases the lease by re-reading the held job as terminal.

- [ ] **Step 2: Run and verify RED**

```bash
pnpm test -- tests/server/refreshAdmission.test.ts
```

Expected: FAIL because controller does not exist.

- [ ] **Step 3: Implement `RefreshAdmissionController`**

Use one synchronous critical section in the single Node process. Initialize from the current `RefreshTracker` and `BrowserRefreshRepository`. Leases must be idempotently releasable and browser terminal transitions must release their lease.

Expose two construction helpers rather than letting routes separate acquisition from persistence:

```ts
withAllSourcesLease<T>(createScan: () => T): Acquired<T> | Conflict;
withBrowserLease<T>(createJobInImmediateTransaction: () => T):
  Acquired<T> | Conflict;
reconcile(): void;
```

`withBrowserLease` must:

1. call `reconcile()`, which runs expiry and re-reads the held browser job by ID;
2. reserve the in-process lease;
3. have `BrowserRefreshRepository.createJob` start `BEGIN IMMEDIATE`;
4. recheck that no non-terminal browser job exists;
5. insert and commit the job;
6. roll back and release the lease on every thrown path.

`withAllSourcesLease` reserves the same in-memory lease before `startScan` and releases it if scan creation fails. This single-process gate plus the SQLite immediate transaction is the required persistent boundary.

Every public admission check starts with `reconcile()`. Browser terminal transitions also call `releaseBrowser(jobId)` immediately, but correctness does not rely on receiving an expiry notification from repository methods.

- [ ] **Step 4: Put `/api/refresh` behind admission**

Acquire before `repository.startScan`. Release in both success and error continuations. On conflict return:

```json
{
  "error": "refresh_conflict",
  "message": "另一个刷新任务正在进行",
  "activeKind": "browser"
}
```

No failed request may create an orphan scan run.

- [ ] **Step 5: Run focused API tests and commit**

```bash
pnpm test -- tests/server/refreshAdmission.test.ts tests/server/api.test.ts
git add src/server/refreshAdmission.ts src/server/app.ts tests/server/refreshAdmission.test.ts tests/server/api.test.ts
git commit -m "feat: serialize all refresh entry points"
```

## Task 5: Publish one source without corrupting cross-platform ranking or history

**Files:**

- Modify: `src/server/repository.ts`
- Modify: `src/server/db.ts`
- Modify: `src/client/api.ts`
- Test: `tests/server/repository.test.ts`
- Test: `tests/server/api.test.ts`
- Test: `tests/server/browserRefreshService.test.ts`

- [ ] **Step 1: Write failing scoped-publish tests**

Seed JYM, Panzhi, and PXB7 with trusted observations. Publish only a new JYM snapshot and assert:

- Panzhi/PXB7 Listing keys and payload fields remain;
- all three active sources receive newly normalized scores and duplicate keys;
- only one JYM `scan_source_results` exists in the new run;
- only JYM receives new `listing_observations`;
- removed JYM items get trusted removed observations;
- Panzhi/PXB7 do not get fake unchanged observations;
- `scan_runs.scope = single_source`;
- `requested_source = jiaoyimao`.
- `getScanHistory` and `/api/scan-history` expose `scope` and `requestedSource`.
- Jiaoyimao `source_status` has the new attempt/success time, item count, pages, natural-end stop reason, and no stale error.

- [ ] **Step 2: Add failing quarantine tests**

For a first suspicious drop, assert:

```text
job.state = quarantined
scan_runs.state = partial
scan_source_results.state = partial
anomaly_state = suspect
published = 0
job.scan_run_id is set
job.published_run_id is null
formal listings remain byte-for-byte unchanged
source_status keeps prior success/count/pages and only updates attempt/state/anomaly text
```

For a matching second complete low result, assert it publishes and clears the guard.

Inject a failure immediately after formal Listing writes and assert the entire transaction rolls back: no scan row, source result, observation, formal Listing change, anomaly-guard change, or job terminal/run-link update survives.

At the service/API layer, assert the thrown publisher error triggers a second best-effort transaction that changes the still-`committing` job to `failed/commit_failed`, and admission is released in `finally`. A new refresh can start immediately. If even the failure transition throws, admission is still released; the persisted `committing` job is recovered as failed on process restart.

- [ ] **Step 3: Run and verify RED**

```bash
pnpm test -- tests/server/repository.test.ts -t "single-source|browser quarantine"
```

Expected: FAIL because scoped publish is absent.

- [ ] **Step 4: Add one transaction-owning browser publisher API**

Introduce:

```ts
interface CommitBrowserSourceRefreshInput {
  jobId: string;
  source: "jiaoyimao";
  listings: Listing[];
  attemptedAt: Date;
  pagesScanned: number;
  stopReason: "end_of_pages" | "no_growth_twice";
}

interface CommitBrowserSourceRefreshResult {
  state: "success" | "quarantined";
  scanRunId: number;
  publishedRunId: number | null;
}

commitBrowserSourceRefresh(
  input: CommitBrowserSourceRefreshInput
): CommitBrowserSourceRefreshResult;
```

This method—not the service—owns `BEGIN IMMEDIATE` and creates the scoped `scan_runs` row inside the same transaction as publish/quarantine. It must:

1. re-read and validate the job is `committing`;
2. insert `scan_runs(scope = single_source, requested_source = jiaoyimao)`;
3. run the existing anomaly decision;
4. for a quarantine, write the unpublished partial source result, preserve every formal Listing, update the anomaly guard, and finish the job as `quarantined` with only `scan_run_id`;
5. for a publish, read current formal listings and replace only JYM;
6. clear derived scores/duplicates for all current active-source Listings;
7. run cross-platform duplicate detection and scoring;
8. write source result and observations only for JYM;
9. preserve Panzhi/PXB7 statuses and observations;
10. finish the job as `success` with equal `scan_run_id` and `published_run_id`;
11. commit once, or roll back every change on error.

On success, update Jiaoyimao `source_status.state = success`, `last_attempt_at`, `last_success_at`, `item_count`, `pages_scanned`, `stop_reason`, and clear `error`. On quarantine, preserve previous `last_success_at`, `item_count`, `pages_scanned`, and formal Listing payloads; update only `last_attempt_at`, `state = partial`, `stop_reason = anomaly_guard`, anomaly guard fields, and the user-facing error.

Keep current `commitScanRefresh` all-source behavior intact; extract private helpers only where needed to avoid divergence.

- [ ] **Step 5: Connect service completion to parsing and scoped publish**

For every staged item:

- construct a `ListingSummary`;
- skip detail fetch only when list price is clearly over budget;
- parse visible sections locally;
- reuse existing `buildListing` logic through an extracted pure builder rather than duplicating classification;
- refuse completion if any required detail is missing;
- transition to `committing`;
- call `commitBrowserSourceRefresh` exactly once, without pre-creating a run ID;
- on success/quarantine, release admission after the transaction returns a terminal result;
- on throw, call `markCommitFailed(jobId, "commit_failed")` in a new best-effort transaction and release admission unconditionally in `finally`;
- never leave an in-memory lease held because a database write failed.

- [ ] **Step 6: Expose scan scope in history**

Extend `ScanHistoryRun`, `getScanHistory`, and client/API response types:

```ts
scope: "all_sources" | "single_source";
requestedSource: SourceId | null;
```

Add repository and API assertions for old rows defaulting to `all_sources/null` and browser rows returning `single_source/jiaoyimao`.

- [ ] **Step 7: Run repository, API, and service tests**

```bash
pnpm test -- tests/server/repository.test.ts tests/server/browserRefreshService.test.ts tests/server/api.test.ts tests/domain
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/server/repository.ts src/server/db.ts src/server/browserRefresh/service.ts src/client/api.ts tests/server/repository.test.ts tests/server/api.test.ts tests/server/browserRefreshService.test.ts
git commit -m "feat: publish trusted Jiaoyimao browser scans"
```

## Task 6: Expose the authenticated localhost bridge API

**Files:**

- Modify: `src/server/app.ts`
- Modify: `src/server/index.ts`
- Modify: `tests/server/api.test.ts`
- Modify: `tests/server/health.test.ts`

- [ ] **Step 1: Write failing route tests**

Cover all user and bridge endpoints from the spec. Assert:

- create returns 202, opaque job ID, one-time claim code, and expiry;
- current-job reads are redacted;
- claim returns a short-lived bridge token once;
- missing/wrong/expired bridge tokens return 401;
- invalid state or sequence returns 409;
- invalid URL/body returns 400;
- payload over configured limit returns 413;
- a Unicode-heavy batch just below 128 KiB is accepted and one just above is rejected deterministically;
- create conflicts with ordinary refresh before either record is created;
- cancel keeps existing formal listings;
- complete returns `success` or `quarantined` with scan linkage.
- after completion, the redacted current-job endpoint returns the terminal state and scan linkage without either credential hash.

- [ ] **Step 2: Run route tests and verify RED**

```bash
pnpm test -- tests/server/api.test.ts -t "browser refresh"
```

Expected: FAIL with 404 routes.

- [ ] **Step 3: Add routes and error mapping**

Implement:

```text
POST   /api/sources/jiaoyimao/browser-refresh
GET    /api/sources/jiaoyimao/browser-refresh/current
POST   /api/sources/jiaoyimao/browser-refresh/:id/cancel
POST   /api/sources/jiaoyimao/browser-refresh/:id/keep-waiting
POST   /api/browser-refresh/:id/claim
GET    /api/browser-refresh/:id/work
POST   /api/browser-refresh/:id/filter-proof
POST   /api/browser-refresh/:id/list-batches
POST   /api/browser-refresh/:id/load-events
POST   /api/browser-refresh/:id/details
POST   /api/browser-refresh/:id/pause
POST   /api/browser-refresh/:id/resume
POST   /api/browser-refresh/:id/cooldown
POST   /api/browser-refresh/:id/complete
```

Use `Authorization: Bearer <bridge-token>` only on bridge endpoints. Never log request bodies or credentials.

- [ ] **Step 4: Wire production dependencies**

In `index.ts`, create one database connection, `ListingRepository`, `BrowserRefreshRepository`, `RefreshAdmissionController`, and `JiaoyimaoBrowserTaskService`. Run interruption recovery and `expireJobs(now)` before constructing admission/listening. Start the 60-second unref'ed maintenance tick by calling `admission.reconcile()` followed by staging cleanup; reconciliation re-reads the held browser job so a stale lease is released even if another repository call performed the expiry first.

- [ ] **Step 5: Run API suite and commit**

```bash
pnpm test -- tests/server/api.test.ts tests/server/health.test.ts tests/server/refreshAdmission.test.ts
git add src/server/app.ts src/server/index.ts tests/server/api.test.ts tests/server/health.test.ts
git commit -m "feat: expose Jiaoyimao browser refresh API"
```

## Task 7: Add a reusable Codex bridge client

**Files:**

- Create: `scripts/jiaoyimao-browser-bridge.mjs`
- Create: `tests/scripts/jiaoyimao-browser-bridge.test.ts`
- Create: `docs/jiaoyimao-browser-refresh-runbook.md`

- [ ] **Step 1: Write failing client tests**

Mock `fetch` and assert:

- `claim(jobId, claimCode)` stores the bridge token only in the returned in-memory client;
- subsequent methods send the Bearer token and correct schema;
- HTTP failures expose stable server codes without response credential text;
- no method accepts or serializes cookie/local-storage/auth-session fields;
- `getWork` exposes authoritative `nextActionAt`, `cooldownUntil`, and one-use `actionPermit`;
- load-event/detail methods forward a permit only for the matching outcome and clear it locally after one submission;
- a helper `waitUntilAllowed(work, now, wait)` waits only until the server-provided time and never retries by itself;
- `complete`, `cancel`, and terminal errors clear the in-memory token.

- [ ] **Step 2: Run and verify RED**

```bash
pnpm test -- tests/scripts/jiaoyimao-browser-bridge.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the helper**

Export:

```js
export async function claimJiaoyimaoBrowserJob(options) {
  return {
    getWork,
    submitFilterProof,
    submitListBatch,
    submitLoadEvent,
    submitDetails,
    pause,
    resume,
    startCooldown,
    waitUntilAllowed,
    complete
  };
}
```

Default API base is `http://127.0.0.1:4310`. Keep the token in a closure only. Validate outgoing data shape before fetch.

The bridge must not invent its own retry loop. Before every page load or detail navigation it reads `getWork`, waits until the authoritative `nextActionAt`/`cooldownUntil`, performs one browser action, and submits one outcome. After a cooldown, it forwards the one-use `actionPermit` with that outcome. If the outcome is still rate-limited, it calls `startCooldown` once and returns control to the work loop.

- [ ] **Step 4: Write the runbook**

Document the exact future Codex workflow:

1. inspect the local panel for a waiting job and visible claim code;
2. import this helper in the browser-control runtime;
3. claim the job;
4. open/reuse the exact filter tab;
5. submit filter proof;
6. load and submit list batches/events;
7. pause for user login/CAPTCHA;
8. resume from `getWork`;
9. submit required detail sections;
10. complete and verify the app.

State explicitly: never inspect cookies, localStorage, passwords, CAPTCHA answers, or network authentication headers.

Use the server delay windows exactly: list 1,200–2,500 ms, detail 2,000–3,500 ms, and cooldown 30 seconds/2 minutes/5 minutes/15 minutes. The runbook must tell Codex to wait using the returned timestamp, not hard-coded loops.

- [ ] **Step 5: Run and commit**

```bash
pnpm test -- tests/scripts/jiaoyimao-browser-bridge.test.ts
git add scripts/jiaoyimao-browser-bridge.mjs tests/scripts/jiaoyimao-browser-bridge.test.ts docs/jiaoyimao-browser-refresh-runbook.md
git commit -m "feat: add reusable Codex browser bridge client"
```

## Task 8: Build the dedicated Jiaoyimao refresh panel

**Files:**

- Modify: `src/client/api.ts`
- Create: `src/client/components/JiaoyimaoBrowserRefreshPanel.tsx`
- Create: `tests/client/JiaoyimaoBrowserRefreshPanel.test.tsx`
- Modify: `src/client/styles.css`

- [ ] **Step 1: Write failing component tests**

Test:

- idle view shows “刷新交易猫”;
- create response shows “等待 Codex 接管” and the one-time code;
- polling after reload shows redacted progress without inventing a code;
- every state has the approved Chinese label;
- detail progress shows X/Y;
- cooldown displays remaining time;
- verification state tells the user to use the same Codex browser tab;
- cancel confirmation states existing candidates are preserved;
- quarantined state explains the old snapshot remains;
- mobile rendering keeps controls accessible.

- [ ] **Step 2: Run and verify RED**

```bash
pnpm test -- tests/client/JiaoyimaoBrowserRefreshPanel.test.tsx
```

Expected: FAIL because component/API types do not exist.

- [ ] **Step 3: Add typed API methods**

Extend `ScoutApi` with:

```ts
getCurrentJiaoyimaoBrowserRefresh()
startJiaoyimaoBrowserRefresh()
cancelJiaoyimaoBrowserRefresh(jobId)
keepWaitingForJiaoyimaoBrowserRefresh(jobId)
```

Map non-2xx JSON errors into existing user-facing `Error` handling without leaking response bodies.

- [ ] **Step 4: Implement the panel**

Make it a controlled component receiving job state, conflict state, and callbacks. Keep countdown display derived from `cooldownUntil`; the server remains authoritative.

- [ ] **Step 5: Add responsive styles and run tests**

```bash
pnpm test -- tests/client/JiaoyimaoBrowserRefreshPanel.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/client/api.ts src/client/components/JiaoyimaoBrowserRefreshPanel.tsx src/client/styles.css tests/client/JiaoyimaoBrowserRefreshPanel.test.tsx
git commit -m "feat: show Jiaoyimao browser refresh progress"
```

## Task 9: Integrate browser tasks with the full app and multi-tab refresh behavior

**Files:**

- Modify: `src/client/App.tsx`
- Modify: `src/client/components/SourceStrip.tsx`
- Modify: `src/client/components/RefreshProgress.tsx`
- Modify: `tests/client/App.test.tsx`

- [ ] **Step 1: Write failing app integration tests**

Cover:

- browser job is discovered on initial load, focus, 5-second sync, and `BroadcastChannel`;
- all-source refresh button is disabled for every non-terminal browser job;
- browser start is disabled during all-source refresh;
- 409 conflict discovers and displays the active job instead of clearing candidates;
- old candidate list and selected history stay visible while browser job runs;
- success reloads sources, current pool, scan history, and selected listing history;
- quarantine/failure/pause preserve the current list;
- terminal browser job restores ordinary refresh availability;
- source strip places the button only on Jiaoyimao.

- [ ] **Step 2: Run and verify RED**

```bash
pnpm test -- tests/client/App.test.tsx -t "browser refresh"
```

Expected: FAIL because App has no browser-job state.

- [ ] **Step 3: Add independent polling**

Keep existing all-source `RefreshTracker` polling unchanged. Add a browser-job poller that:

- polls every second while active and every five seconds when idle;
- broadcasts `jiaoyimao-browser-refresh-changed`;
- does not clear listings on transport errors;
- reloads formal data only when `publishedRunId` changes or state becomes success.

- [ ] **Step 4: Integrate source action and mutual disable state**

Pass the dedicated action into `SourceStrip`; render the panel near current refresh progress. Do not overload `RefreshStatusView` with browser-specific fields.

- [ ] **Step 5: Run client suites and commit**

```bash
pnpm test -- tests/client/JiaoyimaoBrowserRefreshPanel.test.tsx tests/client/App.test.tsx tests/client/ListingTable.test.tsx tests/client/ListingDetail.test.tsx
git add src/client/App.tsx src/client/components/SourceStrip.tsx src/client/components/RefreshProgress.tsx tests/client/App.test.tsx
git commit -m "feat: integrate Jiaoyimao browser refresh"
```

## Task 10: Complete automated verification and update product documentation

**Files:**

- Modify: `README.md`
- Modify: `docs/jiaoyimao-browser-refresh-runbook.md`
- Modify: any focused tests exposed by full verification

- [ ] **Step 1: Update README**

Document:

- difference between “刷新公开数据” and “刷新交易猫”;
- current Codex task requirement;
- user-only login/CAPTCHA step;
- no Cookie/session export;
- task states, 24-hour recovery, cancellation, and old-snapshot behavior;
- exact runbook link.

- [ ] **Step 2: Run complete automated checks**

```bash
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

Expected: all tests PASS, both TypeScript configs PASS, production build succeeds, and diff check is clean.

- [ ] **Step 3: Inspect migration and test coverage**

Run:

```bash
rg -n "browser_refresh|single_source|refresh_conflict|quarantined" src tests README.md docs/jiaoyimao-browser-refresh-runbook.md
git status --short
git diff --stat
```

Confirm every design completion criterion has code or test evidence.

- [ ] **Step 4: Commit documentation or verification fixes**

```bash
git add README.md docs/jiaoyimao-browser-refresh-runbook.md src tests
git commit -m "docs: explain Jiaoyimao browser refresh"
```

If there are no uncommitted changes, do not create an empty commit.

## Task 11: Run real browser-assisted acceptance and publish `master`

**Files:**

- Runtime data only: `data/*.sqlite` (ignored)
- No source changes unless acceptance exposes a verified defect

- [ ] **Step 1: Back up the acceptance database**

Use these exact task-specific paths:

```bash
acceptance_db=/Users/zhaok/Desktop/sjz/.worktrees/trustworthy-candidate-upgrade/data/trustworthy-upgrade-acceptance.sqlite
backup_db=/Users/zhaok/Desktop/sjz/.worktrees/trustworthy-candidate-upgrade/data/trustworthy-upgrade-acceptance.before-browser-refresh-acceptance.sqlite
test ! -e "$backup_db"
sqlite3 "$acceptance_db" "PRAGMA wal_checkpoint(FULL);"
sqlite3 "$acceptance_db" ".backup '$backup_db'"
sqlite3 "$backup_db" "PRAGMA integrity_check;"
```

Expected: the backup path did not previously exist and integrity is `ok`. If it already exists, stop and choose a new explicit timestamped filename after verifying the exact target; never overwrite a prior backup. Stop the current persistent dev `screen` session cleanly before changing the configured database, then restart against `acceptance_db`.

- [ ] **Step 2: Start and health-check the app**

Run in a persistent `screen` session:

```bash
SCOUT_DATABASE_PATH=/Users/zhaok/Desktop/sjz/.worktrees/trustworthy-candidate-upgrade/data/trustworthy-upgrade-acceptance.sqlite pnpm dev
curl -fsS http://127.0.0.1:4310/api/health
```

Expected: API reports `ok: true`, UI is available at `http://127.0.0.1:4311/`.

- [ ] **Step 3: Start the job from the UI and claim it**

In the Codex in-app browser:

- click “刷新交易猫”;
- verify “等待 Codex 接管” and a one-time code;
- import `scripts/jiaoyimao-browser-bridge.mjs`;
- claim the job;
- confirm the UI moves to list collection.

- [ ] **Step 4: Complete the real list scan**

Open or reuse the exact QQ + M7 棱镜攻势 + 极品 S/A/B/C filter page. If login/CAPTCHA appears, pause and ask the user to complete it in that tab. Submit a filter proof, all unique list batches, and every load event until the persisted natural-end rule passes.

Record:

```text
unique list count
load action count
natural-end reason
required detail count
```

- [ ] **Step 5: Complete all required details**

For every price-unknown or `<= ¥6,000` work item:

- open the exact detail URL;
- collect only `head`, `report`, `safety`, and `description` visible text;
- submit through the bridge;
- obey each server-provided `nextActionAt`, `cooldownUntil`, and one-use action permit;
- pause for any CAPTCHA/login;
- resume from `getWork` after user verification.

Expected: `detailCompletedCount === detailRequiredCount`.

- [ ] **Step 6: Publish and verify database integrity**

Complete the job, then run:

```bash
sqlite3 /Users/zhaok/Desktop/sjz/.worktrees/trustworthy-candidate-upgrade/data/trustworthy-upgrade-acceptance.sqlite "PRAGMA integrity_check;"
curl -fsS http://127.0.0.1:4310/api/sources
curl -fsS "http://127.0.0.1:4310/api/listings?view=pool&status=eligible&mode=global"
curl -fsS "http://127.0.0.1:4310/api/scan-history?limit=3"
```

Expected:

- integrity is `ok`;
- job is `success` or explicitly `quarantined`;
- a successful job has `single_source/jiaoyimao` history;
- Panzhi/PXB7 counts and histories remain;
- global candidates are re-scored;
- quarantined data does not replace the old snapshot.

- [ ] **Step 7: Perform browser UI acceptance**

Verify in the Codex browser:

- the job panel shows the correct terminal state;
- source card count and time match API data;
- candidate pool and Top 30 render;
- at least three candidate details match the source page for price, M7 quality, rare finish, assets, and safety evidence;
- refresh controls are enabled again;
- no stale warning remains after a successful publish.

- [ ] **Step 8: Re-run complete checks after any acceptance fix**

```bash
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

- [ ] **Step 9: Inspect, commit, and push**

```bash
git status --short --branch
git log --oneline --decorate -15
git push origin master
```

Expected: local `master` is clean and synchronized with `origin/master`.
