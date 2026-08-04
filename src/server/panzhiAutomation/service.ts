import { createHash } from "node:crypto";
import type { RefreshMode } from "../collector/coordinator.js";
import {
  PanzhiBrowserSnapshotSchema,
  type PanzhiBrowserSnapshot
} from "../panzhiBrowserSnapshot.js";
import type { RefreshAdmissionController } from "../refreshAdmission.js";
import type { ListingRepository, ScanState } from "../repository.js";
import type { RefreshTracker } from "../refreshTracker.js";
import {
  isTerminalPanzhiAutomationState,
  type PanzhiAutomationEnqueueResponse,
  type PanzhiAutomationExtensionHeartbeat,
  type PanzhiAutomationJob,
  type PanzhiAutomationMode
} from "./contracts.js";
import type {
  PanzhiAutomationRepository
} from "./repository.js";
import {
  PanzhiSnapshotPublisher,
  type PanzhiSnapshotPublishResult
} from "./publisher.js";

export type PanzhiAutomationServiceErrorCode =
  | "not_found"
  | "expired"
  | "unauthorized"
  | "conflict"
  | "invalid_transition"
  | "terminal"
  | "body_mismatch"
  | "captcha_snapshot_rejected"
  | "refresh_conflict";

export class PanzhiAutomationServiceError extends Error {
  constructor(
    readonly code: PanzhiAutomationServiceErrorCode,
    message: string,
    readonly details?: {
      activeKind?: "all_sources" | "browser";
      jobId?: string;
    }
  ) {
    super(message);
    this.name = "PanzhiAutomationServiceError";
  }
}

export interface PanzhiAutomationPublicJob {
  id: string;
  mode: PanzhiAutomationMode;
  state: PanzhiAutomationJob["state"];
  leaseExpiresAt: string | null;
  verificationDeadlineAt: string | null;
  verificationNotifiedAt: string | null;
  error: string | null;
  scanRunId: number | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface PanzhiAutomationPublicStatus {
  connected: boolean;
  lastHeartbeatAt: string | null;
  currentJob: PanzhiAutomationPublicJob | null;
}

export interface PanzhiAutomationStateUpdate {
  state:
    | "applying_filters"
    | "collecting"
    | "awaiting_user_verification"
    | "submitting"
    | "failed";
  error?: string;
}

export interface PanzhiAutomationSchedule {
  markStarted(source: "panzhi", mode: RefreshMode, at: Date): void;
  markAutomationFinished(
    source: "panzhi",
    mode: RefreshMode,
    state: ScanState,
    error: string | null,
    at: Date,
    random: () => number
  ): void;
  markAutomationFailedWithoutAdvancing(
    source: "panzhi",
    mode: RefreshMode,
    state: "partial" | "failed",
    error: string,
    at: Date,
    random: () => number
  ): void;
}

export interface PanzhiAutomationServiceDependencies {
  repository: PanzhiAutomationRepository;
  publisher: PanzhiSnapshotPublisher;
  listings: ListingRepository;
  schedule: PanzhiAutomationSchedule;
  admission: Pick<RefreshAdmissionController, "withAllSourcesLease">;
  tracker: Pick<RefreshTracker, "synchronize">;
  now?: () => Date;
  random?: () => number;
}

export type PanzhiAutomationSnapshotResponse =
  PanzhiSnapshotPublishResult & { deduplicated: boolean };

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(record[key])}`
  ).join(",")}}`;
}

function canonicalDigest(snapshot: PanzhiBrowserSnapshot): string {
  return createHash("sha256")
    .update(stableJson(snapshot), "utf8")
    .digest("hex");
}

function publicJob(job: PanzhiAutomationJob): PanzhiAutomationPublicJob {
  return {
    id: job.id,
    mode: job.mode,
    state: job.state,
    leaseExpiresAt: job.leaseExpiresAt,
    verificationDeadlineAt: job.verificationDeadlineAt,
    verificationNotifiedAt: job.verificationNotifiedAt,
    error: job.error,
    scanRunId: job.scanRunId,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt
  };
}

export class PanzhiAutomationService {
  private readonly repository: PanzhiAutomationRepository;
  private readonly publisher: PanzhiSnapshotPublisher;
  private readonly listings: ListingRepository;
  private readonly schedule: PanzhiAutomationSchedule;
  private readonly admission: Pick<
    RefreshAdmissionController,
    "withAllSourcesLease"
  >;
  private readonly tracker: Pick<RefreshTracker, "synchronize">;
  private readonly now: () => Date;
  private readonly random: () => number;

  constructor({
    repository,
    publisher,
    listings,
    schedule,
    admission,
    tracker,
    now = () => new Date(),
    random = () => Math.random()
  }: PanzhiAutomationServiceDependencies) {
    this.repository = repository;
    this.publisher = publisher;
    this.listings = listings;
    this.schedule = schedule;
    this.admission = admission;
    this.tracker = tracker;
    this.now = now;
    this.random = random;
  }

  status(): PanzhiAutomationPublicStatus {
    this.maintain();
    const status = this.repository.getStatus(this.now());
    return {
      connected: status.connected,
      lastHeartbeatAt: status.lastHeartbeatAt,
      currentJob: status.currentJob ? publicJob(status.currentJob) : null
    };
  }

  recordExtensionHeartbeat(): PanzhiAutomationExtensionHeartbeat {
    return this.repository.recordExtensionHeartbeat(this.now());
  }

  enqueue(mode: PanzhiAutomationMode): Omit<
    PanzhiAutomationEnqueueResponse,
    "job"
  > & { job: PanzhiAutomationPublicJob } {
    const effectiveMode =
      mode === "quick" &&
      !this.listings.hasCompletePublishedSourceSnapshot("panzhi")
        ? "deep"
        : mode;
    const result = this.repository.enqueue(effectiveMode, this.now());
    return { ...result, job: publicJob(result.job) };
  }

  claim() {
    const now = this.now();
    return this.listings.runInTransaction(() => {
      this.maintainInTransaction(now);
      const claimed = this.repository.claim(now);
      if (claimed) {
        this.schedule.markStarted("panzhi", claimed.job.mode, now);
      }
      return claimed
        ? { ...claimed, job: publicJob(claimed.job) }
        : null;
    });
  }

  authenticateRequest(jobId: string, bearerToken: string): void {
    this.repository.authenticateJobToken(jobId, bearerToken);
  }

  resume(jobId: string, bearerToken: string) {
    const at = this.now();
    this.requireAuthenticatedActiveJob(jobId, bearerToken, at);
    const result = this.repository.resume(jobId, bearerToken, at);
    return { ...result, job: publicJob(result.job) };
  }

  heartbeat(jobId: string, bearerToken: string) {
    const at = this.now();
    this.requireAuthenticatedActiveJob(jobId, bearerToken, at);
    const result = this.repository.heartbeat(
      jobId,
      bearerToken,
      at
    );
    return { ...result, job: publicJob(result.job) };
  }

  updateState(
    jobId: string,
    bearerToken: string,
    update: PanzhiAutomationStateUpdate
  ) {
    const at = this.now();
    const current = this.requireAuthenticatedActiveJob(
      jobId,
      bearerToken,
      at
    );
    if (
      (update.state === "failed" && !update.error) ||
      (update.state !== "failed" && update.error !== undefined)
    ) {
      throw new PanzhiAutomationServiceError(
        "body_mismatch",
        "The state and error fields do not match"
      );
    }
    if (
      current.state === "awaiting_user_verification" &&
      update.state === "awaiting_user_verification"
    ) {
      const renewed = this.repository.heartbeat(
        jobId,
        bearerToken,
        at
      );
      return { job: publicJob(renewed.job), shouldNotify: false };
    }
    const enteringVerification =
      update.state === "awaiting_user_verification";
    const shouldNotify = enteringVerification &&
      current.verificationNotifiedAt === null;
    const transition = () => this.repository.transition(
      jobId,
      bearerToken,
      update.state,
      {
        ...(update.error === undefined ? {} : { error: update.error }),
        verificationNotified: shouldNotify,
        clearVerification:
          update.state === "applying_filters" &&
          current.verificationNotifiedAt !== null
      },
      at
    );
    const result = update.state === "failed"
      ? this.listings.runInTransaction(() => {
          const failed = transition();
          this.schedule.markAutomationFailedWithoutAdvancing(
            "panzhi",
            current.mode,
            "failed",
            update.error!,
            at,
            this.random
          );
          return failed;
        })
      : transition();
    return {
      ...result,
      job: publicJob(result.job),
      ...(enteringVerification ? { shouldNotify } : {})
    };
  }

  cancel(jobId: string, bearerToken: string) {
    const at = this.now();
    const current = this.requireAuthenticatedActiveJob(
      jobId,
      bearerToken,
      at
    );
    const result = this.listings.runInTransaction(() => {
      const cancelled = this.repository.cancel(jobId, bearerToken, at);
      this.schedule.markAutomationFailedWithoutAdvancing(
        "panzhi",
        current.mode,
        "failed",
        "automation_cancelled",
        at,
        this.random
      );
      return cancelled;
    });
    return { ...result, job: publicJob(result.job) };
  }

  submitSnapshot(
    jobId: string,
    bearerToken: string,
    input: unknown
  ): PanzhiAutomationSnapshotResponse {
    const at = this.now();
    this.repository.authenticateJobToken(jobId, bearerToken);
    const parsed = PanzhiBrowserSnapshotSchema.parse(input);
    const effectiveMode = parsed.mode ?? "deep";
    const normalizedSnapshot = { ...parsed, mode: effectiveMode };
    const digest = canonicalDigest(normalizedSnapshot);
    const replay = this.repository.findSuccessfulReplay<
      PanzhiSnapshotPublishResult
    >(jobId, bearerToken, digest);
    if (replay !== null) {
      return { ...replay, deduplicated: true };
    }

    const job = this.requireActiveJob(jobId, at);
    const semanticError = job.mode !== effectiveMode
      ? new PanzhiAutomationServiceError(
        "body_mismatch",
        "The snapshot mode does not match the claimed job"
      )
      : parsed.stopReason === "captcha_required"
        ? new PanzhiAutomationServiceError(
            "captcha_snapshot_rejected",
            "Automation captcha snapshots cannot be published"
          )
        : null;
    if (semanticError) {
      this.listings.runInTransaction(() => {
        this.repository.getAuthorizedJobForSnapshot(
          jobId,
          bearerToken,
          digest,
          at
        );
        throw semanticError;
      });
    }

    const acquired = this.admission.withAllSourcesLease(() =>
      this.listings.runInTransaction(() => {
        this.repository.getAuthorizedJobForSnapshot(
          jobId,
          bearerToken,
          digest,
          at
        );
        return this.publisher.publish(normalizedSnapshot, at, (result) => {
          if (result.published) {
            this.repository.completePublished({
              jobId,
              bearerToken,
              canonicalBodyDigest: digest,
              result,
              scanRunId: result.scanRunId,
              now: at
            });
            this.schedule.markAutomationFinished(
              "panzhi",
              effectiveMode,
              result.state as ScanState,
              null,
              at,
              this.random
            );
          } else {
            this.repository.completeUnpublished({
              jobId,
              bearerToken,
              error: "anomaly_guard",
              now: at
            });
            this.schedule.markAutomationFailedWithoutAdvancing(
              "panzhi",
              effectiveMode,
              "partial",
              "anomaly_guard",
              at,
              this.random
            );
          }
        });
      })
    );
    if (acquired.kind === "conflict") {
      throw new PanzhiAutomationServiceError(
        "refresh_conflict",
        "Another refresh is already running",
        {
          activeKind: acquired.activeKind,
          ...(acquired.jobId ? { jobId: acquired.jobId } : {})
        }
      );
    }
    try {
      this.tracker.synchronize(this.listings.getRefreshSnapshot());
      return { ...acquired.value, deduplicated: false };
    } finally {
      acquired.lease.release();
    }
  }

  maintain(): { requeued: number; verificationExpired: number } {
    const now = this.now();
    return this.listings.runInTransaction(() =>
      this.maintainInTransaction(now)
    );
  }

  private maintainInTransaction(
    now: Date
  ): { requeued: number; verificationExpired: number } {
    const current = this.repository.getCurrentJob(now);
    const verificationExpired =
      this.repository.failExpiredVerification(now);
    const requeued = this.repository.requeueExpiredLease(now);
    if (current && verificationExpired > 0) {
      this.schedule.markAutomationFailedWithoutAdvancing(
        "panzhi",
        current.mode,
        "failed",
        "captcha_required",
        now,
        this.random
      );
    } else if (current && requeued > 0) {
      this.schedule.markAutomationFailedWithoutAdvancing(
        "panzhi",
        current.mode,
        "failed",
        "automation_lease_expired",
        now,
        this.random
      );
    }
    return { requeued, verificationExpired };
  }

  private requireAuthenticatedActiveJob(
    jobId: string,
    bearerToken: string,
    at: Date
  ): PanzhiAutomationJob {
    this.repository.authenticateJobToken(jobId, bearerToken);
    return this.requireActiveJob(jobId, at);
  }

  private requireActiveJob(
    jobId: string,
    at: Date
  ): PanzhiAutomationJob {
    const job = this.repository.getJob(jobId);
    if (!job) {
      throw new PanzhiAutomationServiceError(
        "not_found",
        "Panzhi automation job not found"
      );
    }
    if (isTerminalPanzhiAutomationState(job.state)) {
      if (
        job.error === "captcha_required" &&
        job.verificationDeadlineAt !== null &&
        Date.parse(job.verificationDeadlineAt) < at.getTime()
      ) {
        throw new PanzhiAutomationServiceError(
          "expired",
          "Panzhi user verification expired"
        );
      }
      throw new PanzhiAutomationServiceError(
        "terminal",
        "The Panzhi automation job is already terminal"
      );
    }
    const operationTime = at.getTime();
    if (
      job.verificationDeadlineAt !== null &&
      Date.parse(job.verificationDeadlineAt) < operationTime
    ) {
      this.listings.runInTransaction(() => {
        this.repository.failExpiredVerification(at);
        this.schedule.markAutomationFailedWithoutAdvancing(
          "panzhi",
          job.mode,
          "failed",
          "captcha_required",
          at,
          this.random
        );
      });
      throw new PanzhiAutomationServiceError(
        "expired",
        "Panzhi user verification expired"
      );
    }
    if (
      job.state !== "queued" &&
      (
        job.leaseExpiresAt === null ||
        Date.parse(job.leaseExpiresAt) <= operationTime
      )
    ) {
      this.listings.runInTransaction(() => {
        this.repository.requeueExpiredLease(at);
        this.schedule.markAutomationFailedWithoutAdvancing(
          "panzhi",
          job.mode,
          "failed",
          "automation_lease_expired",
          at,
          this.random
        );
      });
      throw new PanzhiAutomationServiceError(
        "expired",
        "Panzhi automation lease expired"
      );
    }
    return job;
  }
}
