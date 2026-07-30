import {
  useCallback,
  useEffect,
  useRef,
  useState
} from "react";
import { ScoutApiError } from "./api";
import type {
  JiaoyimaoBrowserRefreshConflict,
  JiaoyimaoBrowserRefreshJob,
  JiaoyimaoBrowserRefreshState,
  ScoutApi
} from "./api";

const BROWSER_REFRESH_CHANNEL =
  "jiaoyimao-browser-refresh-changed";
const ACTIVE_POLL_MS = 1_000;
const IDLE_POLL_MS = 5_000;
const SYNC_TIMEOUT_MS = 4_000;
const TERMINAL_STATES: ReadonlySet<JiaoyimaoBrowserRefreshState> =
  new Set([
    "success",
    "quarantined",
    "failed",
    "cancelled",
    "expired"
  ]);
const KNOWN_STATES: ReadonlySet<string> = new Set([
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

function isTerminal(job: JiaoyimaoBrowserRefreshJob): boolean {
  return KNOWN_STATES.has(job.state) &&
    TERMINAL_STATES.has(job.state);
}

function blocksAllSourceRefresh(
  job: JiaoyimaoBrowserRefreshJob | null
): boolean {
  return job !== null && !isTerminal(job);
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function isStaleJob(
  current: JiaoyimaoBrowserRefreshJob | null,
  incoming: JiaoyimaoBrowserRefreshJob | null
): boolean {
  if (!current || !incoming || current.id !== incoming.id) return false;
  if (isTerminal(current) && !isTerminal(incoming)) return true;
  return timestamp(incoming.updatedAt) < timestamp(current.updatedAt);
}

function jobVersion(job: JiaoyimaoBrowserRefreshJob): string {
  return [
    job.id,
    job.state,
    job.updatedAt,
    job.publishedRunId ?? "unpublished"
  ].join(":");
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error
    ? cause.message
    : "交易猫浏览器刷新状态暂不可达";
}

function isStartConflictError(cause: unknown): cause is ScoutApiError {
  return cause instanceof ScoutApiError &&
    cause.status === 409 &&
    (
      cause.code === "refresh_conflict" ||
      cause.code === "browser_job_conflict"
    );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key));
}

function isBrowserRefreshBroadcast(data: unknown): boolean {
  if (
    data === null ||
    typeof data !== "object" ||
    Array.isArray(data)
  ) {
    return false;
  }
  const message = data as Record<string, unknown>;
  if (
    message.version === 1 &&
    message.type === "browser-refresh-invalidated"
  ) {
    return hasExactKeys(message, ["version", "type"]);
  }
  return (
    message.version === 1 &&
    message.type === "browser-refresh-changed" &&
    hasExactKeys(message, [
      "version",
      "type",
      "jobId",
      "state",
      "updatedAt",
      "publishedRunId"
    ]) &&
    typeof message.jobId === "string" &&
    message.jobId.length > 0 &&
    typeof message.state === "string" &&
    KNOWN_STATES.has(message.state) &&
    typeof message.updatedAt === "string" &&
    Number.isFinite(Date.parse(message.updatedAt)) &&
    (
      message.publishedRunId === null ||
      (
        typeof message.publishedRunId === "number" &&
        Number.isSafeInteger(message.publishedRunId)
      )
    )
  );
}

function abortError(): Error {
  const error = new Error("交易猫浏览器刷新状态请求已取消");
  error.name = "AbortError";
  return error;
}

function waitForAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const handleAbort = () => reject(abortError());
    signal.addEventListener("abort", handleAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", handleAbort);
        resolve(value);
      },
      (cause: unknown) => {
        signal.removeEventListener("abort", handleAbort);
        reject(cause);
      }
    );
  });
}

interface BrowserRefreshController {
  job: JiaoyimaoBrowserRefreshJob | null;
  claimCode: string | null;
  conflict: JiaoyimaoBrowserRefreshConflict | null;
  busy: boolean;
  error: string | null;
  blocksAllSourceRefresh: boolean;
  start(): Promise<void>;
  cancel(jobId: string): Promise<void>;
  keepWaiting(jobId: string): Promise<void>;
}

interface BrowserRefreshOperation {
  generation: number;
  kind: "start" | "cancel" | "keep-waiting";
  targetId: string | null;
}

export function useJiaoyimaoBrowserRefresh(
  api: ScoutApi,
  allSourcesRefreshing: boolean,
  onPublished: () => Promise<void>
): BrowserRefreshController {
  const [job, setJob] =
    useState<JiaoyimaoBrowserRefreshJob | null>(null);
  const [claimCode, setClaimCode] = useState<string | null>(null);
  const [conflict, setConflict] =
    useState<JiaoyimaoBrowserRefreshConflict | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const generationRef = useRef(0);
  const jobRef = useRef<JiaoyimaoBrowserRefreshJob | null>(null);
  const conflictRef =
    useRef<JiaoyimaoBrowserRefreshConflict | null>(null);
  const localClaimJobRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncTimeoutRef =
    useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncAbortRef = useRef<AbortController | null>(null);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const requestSequenceRef = useRef(0);
  const appliedSequenceRef = useRef(0);
  const reloadInFlightKeysRef = useRef(new Set<string>());
  const reloadCompletedKeysRef = useRef(new Set<string>());
  const broadcastVersionRef = useRef<string | null>(null);
  const operationGenerationRef = useRef(0);
  const operationInFlightRef = useRef(false);
  const operationRef = useRef<BrowserRefreshOperation | null>(null);
  const synchronizeRef = useRef<
    (origin?: "initial" | "poll" | "focus" | "broadcast") => Promise<void>
  >(async () => undefined);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const broadcast = useCallback((
    nextJob: JiaoyimaoBrowserRefreshJob | null,
    force = false
  ) => {
    if (!nextJob || !channelRef.current) return;
    const version = jobVersion(nextJob);
    if (!force && broadcastVersionRef.current === version) return;
    broadcastVersionRef.current = version;
    try {
      channelRef.current.postMessage({
        version: 1,
        type: "browser-refresh-changed",
        jobId: nextJob.id,
        state: nextJob.state,
        updatedAt: nextJob.updatedAt,
        publishedRunId: nextJob.publishedRunId
      });
    } catch {
      // Polling and focus synchronization remain available.
    }
  }, []);

  const broadcastInvalidation = useCallback(() => {
    try {
      channelRef.current?.postMessage({
        version: 1,
        type: "browser-refresh-invalidated"
      });
    } catch {
      // Polling and focus synchronization remain available.
    }
  }, []);

  const schedule = useCallback((
    nextJob: JiaoyimaoBrowserRefreshJob | null
  ) => {
    clearTimer();
    if (!mountedRef.current) return;
    timerRef.current = setTimeout(() => {
      void synchronizeRef.current("poll");
    }, blocksAllSourceRefresh(nextJob) ? ACTIVE_POLL_MS : IDLE_POLL_MS);
  }, [clearTimer]);

  const applyJob = useCallback((
    incoming: JiaoyimaoBrowserRefreshJob | null,
    sequence: number,
    options: {
      initial?: boolean;
      broadcastChange?: boolean;
    } = {}
  ): boolean => {
    if (
      !mountedRef.current ||
      sequence < appliedSequenceRef.current ||
      isStaleJob(jobRef.current, incoming)
    ) {
      return false;
    }
    appliedSequenceRef.current = sequence;
    jobRef.current = incoming;
    setJob(incoming);
    setError(null);

    if (
      localClaimJobRef.current !== null &&
      (
        incoming?.id !== localClaimJobRef.current ||
        incoming.state !== "awaiting_codex"
      )
    ) {
      localClaimJobRef.current = null;
      setClaimCode(null);
    }

    const reloadKey = incoming?.publishedRunId !== null &&
      incoming?.publishedRunId !== undefined
      ? `${incoming.id}:published:${incoming.publishedRunId}`
      : incoming?.state === "success"
        ? `${incoming.id}:success:${incoming.updatedAt}`
        : null;
    if (
      reloadKey !== null &&
      !reloadInFlightKeysRef.current.has(reloadKey) &&
      !reloadCompletedKeysRef.current.has(reloadKey)
    ) {
      reloadInFlightKeysRef.current.add(reloadKey);
      void onPublished().then(
        () => {
          reloadInFlightKeysRef.current.delete(reloadKey);
          reloadCompletedKeysRef.current.add(reloadKey);
          if (mountedRef.current) setError(null);
        },
        (cause: unknown) => {
          reloadInFlightKeysRef.current.delete(reloadKey);
          if (mountedRef.current) setError(errorMessage(cause));
        }
      );
    }

    if (options.broadcastChange && incoming) broadcast(incoming);
    schedule(incoming);
    return true;
  }, [broadcast, onPublished, schedule]);

  const synchronize = useCallback(async (
    origin: "initial" | "poll" | "focus" | "broadcast" = "poll"
  ) => {
    syncAbortRef.current?.abort();
    if (syncTimeoutRef.current !== null) {
      clearTimeout(syncTimeoutRef.current);
    }
    const controller = new AbortController();
    syncAbortRef.current = controller;
    syncTimeoutRef.current = setTimeout(() => {
      controller.abort();
    }, SYNC_TIMEOUT_MS);
    const sequence = ++requestSequenceRef.current;
    const generation = generationRef.current;
    const conflictAtRequest = conflictRef.current;
    try {
      const [current, allSourceStatus] = await waitForAbort(Promise.all([
        api.getCurrentJiaoyimaoBrowserRefresh(controller.signal),
        conflictAtRequest === null
          ? Promise.resolve(null)
          : api.getRefreshStatus(controller.signal).catch(() => null)
      ]), controller.signal);
      if (
        !mountedRef.current ||
        generation !== generationRef.current ||
        sequence !== requestSequenceRef.current ||
        syncAbortRef.current !== controller
      ) {
        return;
      }
      const stateChanged =
        current !== null &&
        (
          jobRef.current === null ||
          jobVersion(jobRef.current) !== jobVersion(current)
        );
      const applied = applyJob(current, sequence, {
        initial: origin === "initial",
        broadcastChange:
          origin !== "initial" &&
          origin !== "broadcast" &&
          stateChanged
      });
      const operation = operationRef.current;
      const operationWasSuperseded =
        operation !== null &&
        (
          operation.targetId !== null
            ? current?.id !== operation.targetId
            : (
              operation.kind === "start" &&
              current !== null &&
              !isTerminal(current)
            )
        );
      if (applied && operationWasSuperseded) {
        operationGenerationRef.current += 1;
        operationInFlightRef.current = false;
        operationRef.current = null;
        setBusy(false);
      }
      const browserCurrentIsInactive =
        current === null || isTerminal(current);
      const allSourceConflictResolved =
        conflictAtRequest?.activeKind === "all_sources" &&
        browserCurrentIsInactive &&
        allSourceStatus !== null &&
        allSourceStatus.state !== "running";
      const browserConflictResolved =
        conflictAtRequest?.activeKind === "browser" &&
        browserCurrentIsInactive;
      if (
        applied &&
        conflictAtRequest !== null &&
        conflictRef.current === conflictAtRequest &&
        (allSourceConflictResolved || browserConflictResolved)
      ) {
        conflictRef.current = null;
        setConflict(null);
      }
    } catch (cause) {
      if (
        !mountedRef.current ||
        generation !== generationRef.current ||
        sequence !== requestSequenceRef.current ||
        syncAbortRef.current !== controller
      ) {
        return;
      }
      setError(
        cause instanceof Error && cause.name === "AbortError"
          ? "交易猫浏览器刷新状态请求超时"
          : errorMessage(cause)
      );
      schedule(jobRef.current);
    } finally {
      if (syncAbortRef.current === controller) {
        syncAbortRef.current = null;
        if (syncTimeoutRef.current !== null) {
          clearTimeout(syncTimeoutRef.current);
          syncTimeoutRef.current = null;
        }
      }
    }
  }, [api, applyJob, schedule]);

  synchronizeRef.current = synchronize;

  useEffect(() => {
    mountedRef.current = true;
    generationRef.current += 1;
    const generation = generationRef.current;

    const handleFocus = () => {
      void synchronizeRef.current("focus");
    };
    window.addEventListener("focus", handleFocus);

    if (typeof BroadcastChannel !== "undefined") {
      try {
        const channel = new BroadcastChannel(BROWSER_REFRESH_CHANNEL);
        channel.onmessage = (event) => {
          if (isBrowserRefreshBroadcast(event.data)) {
            void synchronizeRef.current("broadcast");
          }
        };
        channelRef.current = channel;
      } catch {
        channelRef.current = null;
      }
    }
    void synchronizeRef.current("initial");

    return () => {
      if (generation === generationRef.current) {
        generationRef.current += 1;
      }
      mountedRef.current = false;
      requestSequenceRef.current += 1;
      operationGenerationRef.current += 1;
      operationInFlightRef.current = false;
      operationRef.current = null;
      clearTimer();
      syncAbortRef.current?.abort();
      syncAbortRef.current = null;
      if (syncTimeoutRef.current !== null) {
        clearTimeout(syncTimeoutRef.current);
        syncTimeoutRef.current = null;
      }
      window.removeEventListener("focus", handleFocus);
      channelRef.current?.close();
      channelRef.current = null;
    };
  }, [api, clearTimer]);

  const start = useCallback(async () => {
    if (
      !mountedRef.current ||
      operationInFlightRef.current ||
      allSourcesRefreshing ||
      conflictRef.current !== null ||
      blocksAllSourceRefresh(jobRef.current)
    ) {
      return;
    }
    const operationGeneration = ++operationGenerationRef.current;
    operationInFlightRef.current = true;
    operationRef.current = {
      generation: operationGeneration,
      kind: "start",
      targetId: null
    };
    setBusy(true);
    setError(null);
    conflictRef.current = null;
    setConflict(null);
    try {
      const started = await api.startJiaoyimaoBrowserRefresh();
      if (
        !mountedRef.current ||
        operationGeneration !== operationGenerationRef.current
      ) {
        broadcastInvalidation();
        return;
      }
      operationRef.current = {
        generation: operationGeneration,
        kind: "start",
        targetId: started.jobId
      };
      localClaimJobRef.current = started.jobId;
      setClaimCode(started.claimCode);
      const current = await api.getCurrentJiaoyimaoBrowserRefresh();
      if (
        !mountedRef.current ||
        operationGeneration !== operationGenerationRef.current ||
        current?.id !== started.jobId
      ) {
        localClaimJobRef.current = null;
        setClaimCode(null);
        broadcastInvalidation();
        return;
      }
      const sequence = ++requestSequenceRef.current;
      applyJob(current, sequence);
      if (current) broadcast(current, true);
    } catch (cause) {
      if (
        !mountedRef.current ||
        operationGeneration !== operationGenerationRef.current
      ) {
        return;
      }
      const message = errorMessage(cause);
      if (!isStartConflictError(cause)) {
        setError(message);
        return;
      }
      try {
        const [current, allSourceStatus] = await Promise.all([
          api.getCurrentJiaoyimaoBrowserRefresh(),
          api.getRefreshStatus()
        ]);
        if (
          !mountedRef.current ||
          operationGeneration !== operationGenerationRef.current
        ) {
          return;
        }
        const sequence = ++requestSequenceRef.current;
        applyJob(current, sequence);
        const browserActive =
          current !== null &&
          KNOWN_STATES.has(current.state) &&
          !isTerminal(current);
        const activeKind = browserActive
          ? "browser"
          : allSourceStatus.state === "running"
            ? "all_sources"
            : null;
        if (activeKind === null) {
          setError(message);
          return;
        }
        const nextConflict: JiaoyimaoBrowserRefreshConflict = {
          activeKind,
          message
        };
        conflictRef.current = nextConflict;
        setConflict(nextConflict);
      } catch {
        setError(message);
      }
    } finally {
      if (
        operationGeneration === operationGenerationRef.current
      ) {
        operationInFlightRef.current = false;
        operationRef.current = null;
        if (mountedRef.current) setBusy(false);
      }
    }
  }, [
    allSourcesRefreshing,
    api,
    applyJob,
    broadcast,
    broadcastInvalidation
  ]);

  const applyMutation = useCallback(async (
    kind: "cancel" | "keep-waiting",
    targetId: string,
    operation: () => Promise<JiaoyimaoBrowserRefreshJob>
  ) => {
    if (!mountedRef.current || operationInFlightRef.current) return;
    const operationGeneration = ++operationGenerationRef.current;
    operationInFlightRef.current = true;
    operationRef.current = {
      generation: operationGeneration,
      kind,
      targetId
    };
    setBusy(true);
    setError(null);
    conflictRef.current = null;
    setConflict(null);
    try {
      const result = await operation();
      if (
        !mountedRef.current ||
        operationGeneration !== operationGenerationRef.current ||
        jobRef.current?.id !== targetId ||
        result.id !== targetId
      ) {
        broadcastInvalidation();
        return;
      }
      const sequence = ++requestSequenceRef.current;
      applyJob(result, sequence);
      broadcast(result, true);
    } catch (cause) {
      if (
        mountedRef.current &&
        operationGeneration === operationGenerationRef.current &&
        jobRef.current?.id === targetId
      ) {
        setError(errorMessage(cause));
      }
    } finally {
      if (
        operationGeneration === operationGenerationRef.current
      ) {
        operationInFlightRef.current = false;
        operationRef.current = null;
        if (mountedRef.current) setBusy(false);
      }
    }
  }, [applyJob, broadcast, broadcastInvalidation]);

  const cancel = useCallback(async (jobId: string) => {
    await applyMutation("cancel", jobId, () =>
      api.cancelJiaoyimaoBrowserRefresh(jobId)
    );
  }, [api, applyMutation]);

  const keepWaiting = useCallback(async (jobId: string) => {
    await applyMutation("keep-waiting", jobId, () =>
      api.keepWaitingForJiaoyimaoBrowserRefresh(jobId)
    );
  }, [api, applyMutation]);

  return {
    job,
    claimCode,
    conflict,
    busy,
    error,
    blocksAllSourceRefresh: blocksAllSourceRefresh(job),
    start,
    cancel,
    keepWaiting
  };
}
