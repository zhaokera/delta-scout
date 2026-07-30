import type {
  BrowserRefreshJobState
} from "./browserRefresh/contracts.js";
import type {
  BrowserRefreshRepository
} from "./browserRefresh/repository.js";
import type { RefreshTracker } from "./refreshTracker.js";

const TERMINAL_BROWSER_STATES: ReadonlySet<BrowserRefreshJobState> =
  new Set([
    "success",
    "quarantined",
    "failed",
    "cancelled",
    "expired"
  ]);

export interface RefreshAdmissionLease {
  release(): void;
}

export interface RefreshAdmissionConflict {
  kind: "conflict";
  activeKind: "all_sources" | "browser";
  jobId?: string;
}

export interface RefreshAdmissionAcquired<T> {
  kind: "acquired";
  value: T;
  lease: RefreshAdmissionLease;
}

export type RefreshAdmissionResult<T> =
  | RefreshAdmissionAcquired<T>
  | RefreshAdmissionConflict;

export type RefreshAdmissionView =
  | { activeKind: "none" }
  | { activeKind: "all_sources" }
  | { activeKind: "browser"; jobId?: string };

interface RefreshAdmissionDependencies {
  browserRepository?: BrowserRefreshRepository;
  tracker: RefreshTracker;
  now?: () => Date;
}

type ActiveLease =
  | {
      kind: "all_sources";
      token: symbol;
    }
  | {
      kind: "browser";
      token: symbol;
      jobId: string | null;
    };

function isTerminalBrowserState(
  state: BrowserRefreshJobState
): boolean {
  return TERMINAL_BROWSER_STATES.has(state);
}

function redactJobId(jobId: string): string {
  if (jobId.length <= 12) return "…";
  return `${jobId.slice(0, 8)}…${jobId.slice(-4)}`;
}

export class RefreshAdmissionController {
  private readonly browserRepository:
    | BrowserRefreshRepository
    | undefined;
  private readonly tracker: RefreshTracker;
  private readonly now: () => Date;
  private active: ActiveLease | null = null;

  constructor({
    browserRepository,
    tracker,
    now = () => new Date()
  }: RefreshAdmissionDependencies) {
    this.browserRepository = browserRepository;
    this.tracker = tracker;
    this.now = now;

    const currentBrowser = this.readCurrentActiveBrowser();
    if (tracker.isRunning() && currentBrowser) {
      throw new Error(
        "refresh_admission_initialization_conflict"
      );
    }
    if (tracker.isRunning()) {
      this.active = {
        kind: "all_sources",
        token: Symbol("restored-all-sources-refresh")
      };
    } else if (currentBrowser) {
      this.active = {
        kind: "browser",
        token: Symbol("restored-browser-refresh"),
        jobId: currentBrowser.id
      };
    }
  }

  static forAllSources(
    tracker: RefreshTracker
  ): RefreshAdmissionController {
    return new RefreshAdmissionController({ tracker });
  }

  snapshot(): RefreshAdmissionView {
    if (this.active === null) return { activeKind: "none" };
    if (this.active.kind === "all_sources") {
      return { activeKind: "all_sources" };
    }
    return {
      activeKind: "browser",
      ...(this.active.jobId === null
        ? {}
        : { jobId: redactJobId(this.active.jobId) })
    };
  }

  withAllSourcesLease<T>(
    createScan: () => T
  ): RefreshAdmissionResult<T> {
    this.reconcile();
    const conflict = this.conflict();
    if (conflict) return conflict;

    const token = Symbol("all-sources-refresh");
    this.active = { kind: "all_sources", token };
    try {
      const value = createScan();
      return {
        kind: "acquired",
        value,
        lease: this.leaseFor(token)
      };
    } catch (error) {
      this.releaseToken(token);
      throw error;
    }
  }

  withBrowserLease<T extends { id: string }>(
    createJobInImmediateTransaction: () => T
  ): RefreshAdmissionResult<T> {
    if (!this.browserRepository) {
      throw new Error("browser_refresh_repository_required");
    }
    this.reconcile();
    const conflict = this.conflict();
    if (conflict) return conflict;

    const token = Symbol("browser-refresh");
    this.active = {
      kind: "browser",
      token,
      jobId: null
    };
    try {
      const value = createJobInImmediateTransaction();
      if (
        typeof value.id !== "string" ||
        value.id.length === 0
      ) {
        throw new Error("browser_refresh_job_id_required");
      }
      if (
        this.active?.kind !== "browser" ||
        this.active.token !== token
      ) {
        throw new Error("browser_refresh_lease_lost");
      }
      this.active.jobId = value.id;
      return {
        kind: "acquired",
        value,
        lease: this.leaseFor(token)
      };
    } catch (error) {
      this.releaseToken(token);
      throw error;
    }
  }

  reconcile(): void {
    const currentBrowser = this.readCurrentActiveBrowser();

    if (this.active?.kind === "browser") {
      if (this.active.jobId === null) return;
      const persisted = this.browserRepository?.getJobRecord(
        this.active.jobId,
        this.now()
      );
      if (
        !persisted ||
        isTerminalBrowserState(persisted.state)
      ) {
        this.active = null;
      }
    }

    if (this.active === null) {
      if (this.tracker.isRunning()) {
        this.active = {
          kind: "all_sources",
          token: Symbol("restored-all-sources-refresh")
        };
      } else if (currentBrowser) {
        this.active = {
          kind: "browser",
          token: Symbol("restored-browser-refresh"),
          jobId: currentBrowser.id
        };
      }
    }
  }

  releaseBrowser(jobId: string): void {
    if (
      this.active?.kind === "browser" &&
      this.active.jobId === jobId
    ) {
      this.active = null;
    }
  }

  private readCurrentActiveBrowser():
    | { id: string; state: BrowserRefreshJobState }
    | null {
    if (!this.browserRepository) return null;
    const at = this.now();
    this.browserRepository.expireJobs(at);
    const current = this.browserRepository.getCurrentJob(at);
    return current && !isTerminalBrowserState(current.state)
      ? current
      : null;
  }

  private conflict(): RefreshAdmissionConflict | null {
    const view = this.snapshot();
    if (view.activeKind === "none") return null;
    return {
      kind: "conflict",
      activeKind: view.activeKind,
      ...(view.activeKind === "browser" && view.jobId
        ? { jobId: view.jobId }
        : {})
    };
  }

  private leaseFor(token: symbol): RefreshAdmissionLease {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.releaseToken(token);
      }
    };
  }

  private releaseToken(token: symbol): void {
    if (this.active?.token === token) {
      this.active = null;
    }
  }
}
