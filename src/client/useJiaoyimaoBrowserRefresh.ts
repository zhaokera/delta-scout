import {
  useCallback,
  useEffect,
  useRef,
  useState
} from "react";
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
  const channelRef = useRef<BroadcastChannel | null>(null);
  const requestSequenceRef = useRef(0);
  const appliedSequenceRef = useRef(0);
  const reloadKeysRef = useRef(new Set<string>());
  const broadcastVersionRef = useRef<string | null>(null);
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
    const previous = jobRef.current;
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

    if (incoming && !options.initial) {
      const firstSuccess =
        incoming.state === "success" &&
        (
          previous?.id !== incoming.id ||
          previous.state !== "success"
        );
      const publishedRunChanged =
        incoming.publishedRunId !== null &&
        (
          previous?.id !== incoming.id ||
          previous.publishedRunId !== incoming.publishedRunId
        );
      if (firstSuccess || publishedRunChanged) {
        const reloadKey = incoming.publishedRunId !== null
          ? `${incoming.id}:published:${incoming.publishedRunId}`
          : `${incoming.id}:success:${incoming.updatedAt}`;
        if (!reloadKeysRef.current.has(reloadKey)) {
          reloadKeysRef.current.add(reloadKey);
          void onPublished().catch((cause: unknown) => {
            if (mountedRef.current) setError(errorMessage(cause));
          });
        }
      }
    }

    if (options.broadcastChange && incoming) broadcast(incoming);
    schedule(incoming);
    return true;
  }, [broadcast, onPublished, schedule]);

  const synchronize = useCallback(async (
    origin: "initial" | "poll" | "focus" | "broadcast" = "poll"
  ) => {
    const sequence = ++requestSequenceRef.current;
    const generation = generationRef.current;
    const conflictAtRequest = conflictRef.current;
    try {
      const [current, allSourceStatus] = await Promise.all([
        api.getCurrentJiaoyimaoBrowserRefresh(),
        conflictAtRequest === null
          ? Promise.resolve(null)
          : api.getRefreshStatus().catch(() => null)
      ]);
      if (
        !mountedRef.current ||
        generation !== generationRef.current ||
        sequence !== requestSequenceRef.current
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
        sequence !== requestSequenceRef.current
      ) {
        return;
      }
      setError(errorMessage(cause));
      schedule(jobRef.current);
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
        channel.onmessage = () => {
          void synchronizeRef.current("broadcast");
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
      clearTimer();
      window.removeEventListener("focus", handleFocus);
      channelRef.current?.close();
      channelRef.current = null;
    };
  }, [api, clearTimer]);

  const start = useCallback(async () => {
    if (
      !mountedRef.current ||
      busy ||
      allSourcesRefreshing ||
      conflictRef.current !== null ||
      blocksAllSourceRefresh(jobRef.current)
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    conflictRef.current = null;
    setConflict(null);
    try {
      const started = await api.startJiaoyimaoBrowserRefresh();
      if (!mountedRef.current) return;
      localClaimJobRef.current = started.jobId;
      setClaimCode(started.claimCode);
      const current = await api.getCurrentJiaoyimaoBrowserRefresh();
      if (!mountedRef.current) return;
      const sequence = ++requestSequenceRef.current;
      applyJob(current, sequence);
      if (current) broadcast(current, true);
    } catch (cause) {
      if (!mountedRef.current) return;
      const message = errorMessage(cause);
      try {
        const current = await api.getCurrentJiaoyimaoBrowserRefresh();
        if (!mountedRef.current) return;
        const sequence = ++requestSequenceRef.current;
        applyJob(current, sequence);
        const nextConflict: JiaoyimaoBrowserRefreshConflict = {
          activeKind: current ? "browser" : "all_sources",
          message
        };
        conflictRef.current = nextConflict;
        setConflict(nextConflict);
      } catch {
        setError(message);
      }
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [
    allSourcesRefreshing,
    api,
    applyJob,
    broadcast,
    busy
  ]);

  const applyMutation = useCallback(async (
    operation: () => Promise<JiaoyimaoBrowserRefreshJob>
  ) => {
    if (!mountedRef.current || busy) return;
    setBusy(true);
    setError(null);
    conflictRef.current = null;
    setConflict(null);
    try {
      const result = await operation();
      if (!mountedRef.current) return;
      const sequence = ++requestSequenceRef.current;
      applyJob(result, sequence);
      broadcast(result, true);
    } catch (cause) {
      if (mountedRef.current) setError(errorMessage(cause));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [applyJob, broadcast, busy]);

  const cancel = useCallback(async (jobId: string) => {
    await applyMutation(() =>
      api.cancelJiaoyimaoBrowserRefresh(jobId)
    );
  }, [api, applyMutation]);

  const keepWaiting = useCallback(async (jobId: string) => {
    await applyMutation(() =>
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
