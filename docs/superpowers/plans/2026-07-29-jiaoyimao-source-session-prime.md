# Jiaoyimao Source Session Prime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep one narrowly scoped anonymous Jiaoyimao MTop session for each source refresh and prime page 1 before the first requested MTop page so real page 2+ results are returned.

**Architecture:** Add optional source lifecycle hooks to `PageFetcher` and bracket every adapter refresh in `CollectionCoordinator` with `beginSource`/`endSource`. `PublicPageFetcher` will keep only an approved token, the two approved cookies, and one fixed `jym-meta-h5` value in memory during a Jiaoyimao lifecycle; the first approved page-2+ request uses a three-call handshake/prime/request bootstrap, while later pages reuse that session under the existing three-call retry budget. Every failed path clears the session, and lifecycle end always clears all retained MTop state.

**Tech Stack:** TypeScript, Node Fetch API, Vitest.

---

## File map

**Modify**

- `src/server/collector/types.ts` — optional per-source lifecycle contract.
- `src/server/collector/coordinator.ts` — bracket each adapter refresh with lifecycle hooks.
- `src/server/collector/mtop.ts` — safely derive an internal page-1 data body only from a strictly approved page-2+ body.
- `src/server/collector/fetcher.ts` — lifecycle-local session/meta, bootstrap prime, reuse, failure cleanup.
- `tests/server/coordinator.test.ts` — lifecycle ordering and `finally` coverage.
- `tests/server/mtop.test.ts` — request ordering, fixed metadata, reuse/reset, budget/failure and cookie-boundary coverage.

## Task 1: Bracket every source refresh with optional hooks

- [ ] Add coordinator tests using a fetcher that records `begin`, `fetch`, and `end`.
- [ ] Verify RED: hooks are absent and therefore not called.
- [ ] Add optional `beginSource?(source)` and `endSource?(source)` methods returning `void | Promise<void>` to `PageFetcher`.
- [ ] In `refreshAll`, await `beginSource` before `refreshSource` and await `endSource` in `finally`; defer marking a source fresh until cleanup succeeds.
- [ ] Verify GREEN for successful, early-return, and thrown-fetch cases; existing fetcher stubs remain valid without hooks.

## Task 2: Bootstrap one approved Jiaoyimao source session

- [ ] Replace the old two-call transport test with a RED test asserting this exact first page-2 sequence:

```text
empty-token handshake using derived page 1
signed page-1 prime using the issued session
signed requested page 2 using the same session
```

- [ ] Assert all three requests carry the exact same `jym-meta-h5`, the first request has no Cookie, and the signed requests contain only `_m_h5_tk` and `_m_h5_tk_enc`.
- [ ] Add a pure helper that first validates the existing page-2+ strict allowlist, parses the outer JSON, changes only `page` to `"1"`, and serializes it. Do not broaden the public request allowlist to page 1.
- [ ] Add lifecycle-local state to `PublicPageFetcher` containing only:

```ts
{
  session: { token: string; cookieHeader: string } | null;
  jymMeta: string;
}
```

- [ ] Build the fixed metadata at `beginSource("jiaoyimao")`; direct fetcher use creates an ephemeral state that is cleared before returning.
- [ ] Run handshake, prime, and requested calls with one `remaining: 3` budget and transient retry disabled. Validate the prime with the same strict success structure used for returned pages.
- [ ] Store the session only after the complete bootstrap succeeds; clear it on every failed bootstrap path.
- [ ] Verify GREEN.

## Task 3: Reuse, rotate, and clear the session safely

- [ ] Add a RED lifecycle test: after bootstrap, page 3 makes one signed request with the same Cookie/meta; after `endSource`, the next lifecycle performs handshake/prime again.
- [ ] Reuse the lifecycle session for later MTop pages without handshake or prime.
- [ ] Preserve a fresh three-call budget per later requested page: allow the existing single transient retry and one token-expired replacement attempt.
- [ ] Accept replacement state only through `extractAnonymousMtopSession`, so unrelated `Set-Cookie` values never enter retained state or outbound Cookie headers.
- [ ] On any invalid response, redirect, captcha, network exhaustion, missing replacement, or failed replacement request, clear the retained session and return the existing sanitized failure shape.
- [ ] Verify GREEN.

## Task 4: Fail closed before the requested page

- [ ] Add table-driven tests for bootstrap network exhaustion, invalid prime structure, prime redirect, and prime token error.
- [ ] Assert every case uses at most three calls, does not send the actual page-2 body after prime failure, and does not expose token/cookie/signature text in the result.
- [ ] Add a response containing unrelated sensitive cookies and assert only the two approved cookie names are ever sent.
- [ ] Verify focused MTop and coordinator tests.

## Task 5: Complete verification and one commit

- [ ] Run `npm test -- tests/server/mtop.test.ts tests/server/coordinator.test.ts`.
- [ ] Run `npm test`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build`.
- [ ] Inspect `git diff --check`, `git status --short`, and the complete staged diff.
- [ ] Commit all Task 9 changes once with `fix: prime Jiaoyimao pagination session`.
