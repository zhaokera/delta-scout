# Secondary Real-Name Only Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make secondary real-name availability the only input to safety score, safety evidence coverage, risk level, and the safety portion of data completeness while preserving the current 10-point safety scale and 80/10/10 recommendation weights.

**Architecture:** Keep the existing `Score.coverage` shape and reference-only verification/recovery fields. Change the domain calculation and schema contract from two safety signals to one, then update all UI and acceptance consumers to the same denominator.

**Tech Stack:** TypeScript, Zod, React, Vitest, Testing Library, Node acceptance script

---

### Task 1: Lock the domain behavior with failing tests

**Files:**
- Modify: `tests/domain/score.test.ts`
- Modify: `tests/domain/confidence.test.ts`
- Modify: `tests/domain/listing.test.ts`

- [ ] **Step 1: Update score expectations to the one-signal contract**

Change score coverage expectations to `{ knownSafetySignals: 0 | 1, totalSafetySignals: 1 }`. Assert that a known `true` or `false` secondary-real-name value counts as known, while `null` does not.

- [ ] **Step 2: Add risk and score invariance tests**

Compare otherwise identical listings whose `verificationAt` values are recent, stale, and missing. Assert identical `total`, `exactTotal`, `safety`, `dataQuality`, `coverage`, and `riskLevel`. Repeat the invariant for `recoveryCoverage`.

- [ ] **Step 3: Add a confidence regression test**

Create a listing with `secondRealNameAvailable: null` and a known `verificationAt`; assert that verification time alone contributes zero confidence.

- [ ] **Step 4: Update the schema contract test**

Assert that `ScoreSchema` accepts `totalSafetySignals: 1` with `knownSafetySignals` 0 or 1 and rejects the old denominator 2.

- [ ] **Step 5: Run tests and verify RED**

Run: `pnpm vitest run tests/domain/score.test.ts tests/domain/confidence.test.ts tests/domain/listing.test.ts`

Expected: FAIL because the implementation still counts verification time, changes risk for stale/missing verification, permits the old schema contract, and lets verification contribute to confidence.

### Task 2: Implement the one-signal domain rule

**Files:**
- Modify: `src/domain/score.ts`
- Modify: `src/domain/confidence.ts`
- Modify: `src/domain/listing.ts`

- [ ] **Step 1: Change safety coverage**

Return 1 only when `secondRealNameAvailable !== null`; otherwise return 0. Emit `totalSafetySignals: 1`.

- [ ] **Step 2: Simplify risk classification**

Return `high` when secondary real-name is false or ban notes exist, `unknown` when the value is null, and `low` when it is true. Do not pass verification age, coverage count, or safety points into this function.

- [ ] **Step 3: Remove verification from confidence**

Award the safety-information confidence portion only when `secondRealNameAvailable !== null`.

- [ ] **Step 4: Update the Zod contract**

Limit `knownSafetySignals` to 0–1 and require `totalSafetySignals` to equal 1 while preserving the object shape.

- [ ] **Step 5: Run domain tests and verify GREEN**

Run: `pnpm vitest run tests/domain/score.test.ts tests/domain/confidence.test.ts tests/domain/listing.test.ts`

Expected: PASS.

### Task 3: Update UI and acceptance consumers

**Files:**
- Modify: `src/client/components/RankingDiagnostics.tsx`
- Modify: `tests/domain/listingFactory.ts`
- Modify: `tests/client/ListingDetail.test.tsx`
- Modify: `tests/client/ListingTable.test.tsx`
- Modify: `tests/client/CandidateCompare.test.tsx`
- Modify: `tests/client/RankingDiagnostics.test.tsx`
- Modify: `scripts/verify-acceptance.mjs`

- [ ] **Step 1: Update client fixtures and expectations first**

Change score fixtures to the one-signal coverage contract and expect `安全证据 1 / 1` for known secondary-real-name records. Update comparison and diagnostics expectations consistently.

- [ ] **Step 2: Run client tests and verify RED**

Run: `pnpm vitest run tests/client/ListingDetail.test.tsx tests/client/ListingTable.test.tsx tests/client/CandidateCompare.test.tsx tests/client/RankingDiagnostics.test.tsx`

Expected: FAIL because `RankingDiagnostics` still renders the hard-coded denominator 2.

- [ ] **Step 3: Update the diagnostics denominator**

Render `/ 1` in `RankingDiagnostics`; list, detail, and compare components continue reading the denominator from `Score.coverage`.

- [ ] **Step 4: Update acceptance validation**

Require `totalSafetySignals === 1` and bound `knownSafetySignals` to 0–1. Update the assertion message to describe the secondary-real-name-only contract.

- [ ] **Step 5: Run client tests and verify GREEN**

Run the client test command from Step 2.

Expected: PASS.

### Task 4: Verify the complete change

**Files:**
- Verify all modified files

- [ ] **Step 1: Run the focused regression suite**

Run: `pnpm vitest run tests/domain/score.test.ts tests/domain/confidence.test.ts tests/domain/listing.test.ts tests/client/ListingDetail.test.tsx tests/client/ListingTable.test.tsx tests/client/CandidateCompare.test.tsx tests/client/RankingDiagnostics.test.tsx`

Expected: PASS with zero failed tests.

- [ ] **Step 2: Run the full automated suite**

Run: `pnpm test`

Expected: PASS with zero failed tests.

- [ ] **Step 3: Run static and build verification**

Run: `pnpm typecheck && pnpm build`

Expected: both commands exit 0.

- [ ] **Step 4: Inspect the final diff**

Run: `git diff --check && git status --short && git diff --stat`

Expected: no whitespace errors; only the approved safety-rule implementation, tests, acceptance contract, and existing user changes are present.
