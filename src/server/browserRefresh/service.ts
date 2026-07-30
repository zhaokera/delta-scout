import { randomBytes } from "node:crypto";
import { ZodError } from "zod";
import {
  type BrowserDetailBatch,
  type BrowserFilterProof,
  type BrowserListBatch,
  type BrowserLoadEvent,
  type BrowserPause,
  type BrowserRefreshJobState
} from "./contracts.js";
import {
  detailRequiredIds,
  evaluateNaturalEnd,
  evaluatePublishReadiness,
  validateFilterProof
} from "./completeness.js";
import {
  BrowserRefreshRepository,
  BrowserRefreshRepositoryError,
  type AcceptedBatchView,
  type AcceptedLoadEventView,
  type BrowserRefreshOutcomeTransition,
  type BrowserRefreshJobView,
  type ClaimedBrowserRefreshJob,
  type CreatedBrowserRefreshJob,
  type DetailProgressView
} from "./repository.js";

export type BrowserRefreshCommand =
  | "claim"
  | "getWork"
  | "saveFilterProof"
  | "submitListBatch"
  | "submitLoadEvent"
  | "submitDetails"
  | "pause"
  | "resume"
  | "startCooldown"
  | "keepWaiting"
  | "cancel"
  | "complete";

export const BROWSER_REFRESH_STATE_COMMANDS = {
  awaiting_codex: ["claim", "keepWaiting", "cancel"],
  collecting_list: [
    "getWork",
    "saveFilterProof",
    "submitListBatch",
    "submitLoadEvent",
    "pause",
    "startCooldown",
    "keepWaiting",
    "cancel"
  ],
  collecting_details: [
    "getWork",
    "submitDetails",
    "pause",
    "startCooldown",
    "keepWaiting",
    "cancel"
  ],
  awaiting_user_verification: [
    "resume",
    "keepWaiting",
    "cancel"
  ],
  cooling_down: ["getWork", "pause", "keepWaiting", "cancel"],
  validating: ["complete", "pause", "keepWaiting", "cancel"],
  committing: ["keepWaiting"],
  success: [],
  quarantined: [],
  paused: ["claim", "resume", "keepWaiting", "cancel"],
  failed: [],
  cancelled: [],
  expired: []
} as const satisfies Record<
  BrowserRefreshJobState,
  readonly BrowserRefreshCommand[]
>;

export type BrowserRefreshServiceErrorCode =
  | "browser_job_not_found"
  | "browser_job_conflict"
  | "browser_job_expired"
  | "bridge_unauthorized"
  | "invalid_transition"
  | "filter_mismatch"
  | "staging_invalid"
  | "list_incomplete"
  | "details_incomplete"
  | "safety_limit"
  | "cooldown_active"
  | "action_too_early"
  | "action_permit_required"
  | "action_permit_invalid";

export class BrowserRefreshServiceError extends Error {
  constructor(
    readonly code: BrowserRefreshServiceErrorCode,
    message: string,
    readonly retryAt?: string
  ) {
    super(message);
    this.name = "BrowserRefreshServiceError";
  }
}

export type BrowserRefreshWork =
  | (BrowserRefreshJobView & {
      kind: "list";
      nextListBatchSequence: number;
      nextLoadSequence: number;
      actionPermit?: string;
    })
  | (BrowserRefreshJobView & {
      kind: "detail";
      sourceListingId: string;
      url: string;
      nextDetailSequence: number;
      actionPermit?: string;
    })
  | (BrowserRefreshJobView & {
      kind: "validating";
      actionPermit?: string;
    });

export interface JiaoyimaoBrowserTaskServiceOptions {
  now?: () => Date;
  random?: () => number;
  completeJob?: (jobId: string) => void | Promise<void>;
  permitFactory?: () => string;
}

interface PlannedOutcome {
  transition: BrowserRefreshOutcomeTransition;
  errorAfterCommit?: BrowserRefreshServiceError;
}

const COOLDOWN_DELAYS_MS = [30_000, 120_000, 300_000, 900_000] as const;
const ACTION_PERMIT_LIFETIME_MS = 60_000;

export class JiaoyimaoBrowserTaskService {
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly completeJobCallback:
    | ((jobId: string) => void | Promise<void>)
    | undefined;
  private readonly permitFactory: () => string;

  constructor(
    private readonly repository: BrowserRefreshRepository,
    options: JiaoyimaoBrowserTaskServiceOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.completeJobCallback = options.completeJob;
    this.permitFactory = options.permitFactory ??
      (() => randomBytes(24).toString("base64url"));
  }

  create(): CreatedBrowserRefreshJob {
    try {
      return this.repository.createJob(this.now());
    } catch (error) {
      throw this.mapError(error);
    }
  }

  claim(id: string, claimCode: string): ClaimedBrowserRefreshJob {
    const now = this.now();
    const job = this.requireJob(id, now);
    this.assertCommand(job, "claim");
    if (
      job.state === "paused" &&
      (
        job.reason !== "process_interrupted" ||
        job.claimedAt !== null
      )
    ) {
      throw new BrowserRefreshServiceError(
        "invalid_transition",
        "Only an interrupted unclaimed job may be claimed from paused"
      );
    }
    try {
      return this.repository.claimJob(id, claimCode, now);
    } catch (error) {
      throw this.mapError(error);
    }
  }

  getWork(id: string, bridgeToken: string): BrowserRefreshWork {
    const now = this.now();
    let job = this.authenticate(id, bridgeToken, now);
    this.assertCommand(job, "getWork");

    let actionPermit: string | undefined;
    if (job.state === "cooling_down") {
      if (
        job.cooldownUntil === null ||
        Date.parse(job.cooldownUntil) > now.getTime()
      ) {
        throw new BrowserRefreshServiceError(
          "cooldown_active",
          "The browser action is still cooling down",
          job.cooldownUntil ?? undefined
        );
      }
      const target = this.resumeTarget(job);
      actionPermit = this.permitFactory();
      job = this.repository.transition(
        id,
        ["cooling_down"],
        target,
        {
          stage: target,
          reason: null,
          cooldownUntil: null,
          nextActionAt: null,
          actionPermit,
          actionPermitExpiresAt: new Date(
            now.getTime() + ACTION_PERMIT_LIFETIME_MS
          ).toISOString()
        },
        now
      );
    } else if (job.actionPermitExpiresAt !== null) {
      if (
        Date.parse(job.actionPermitExpiresAt) <= now.getTime()
      ) {
        throw new BrowserRefreshServiceError(
          "action_permit_invalid",
          "The outstanding action permit has expired"
        );
      }
      throw new BrowserRefreshServiceError(
        "action_permit_required",
        "The outstanding permitted action must report an outcome"
      );
    }

    this.assertActionTime(job, now);
    if (job.state === "collecting_list") {
      return {
        ...job,
        kind: "list",
        nextListBatchSequence: job.listBatchCursor + 1,
        nextLoadSequence:
          this.repository.getLoadEvents(id, now).length + 1,
        ...(actionPermit ? { actionPermit } : {})
      };
    }
    if (job.state === "collecting_details") {
      const detail = this.repository.getNextRequiredDetail(id, now);
      if (!detail) {
        const validating = this.repository.transition(
          id,
          ["collecting_details"],
          "validating",
          {
            stage: "validating",
            reason: null,
            nextActionAt: null
          },
          now
        );
        return {
          ...validating,
          kind: "validating",
          ...(actionPermit ? { actionPermit } : {})
        };
      }
      return {
        ...job,
        kind: "detail",
        ...detail,
        nextDetailSequence:
          this.repository.getNextDetailSequence(id, now),
        ...(actionPermit ? { actionPermit } : {})
      };
    }
    if (job.state === "validating") {
      return {
        ...job,
        kind: "validating",
        ...(actionPermit ? { actionPermit } : {})
      };
    }
    throw new BrowserRefreshServiceError(
      "invalid_transition",
      `No browser work is available in state ${job.state}`
    );
  }

  saveFilterProof(
    id: string,
    bridgeToken: string,
    proof: BrowserFilterProof
  ): BrowserRefreshJobView {
    const now = this.now();
    const job = this.authenticate(id, bridgeToken, now);
    this.assertCommand(job, "saveFilterProof");
    try {
      this.repository.saveFilterProof(id, proof, now);
      if (validateFilterProof(proof).kind !== "ok") {
        this.repository.transition(
          id,
          ["collecting_list"],
          "paused",
          {
            stage: "collecting_list",
            reason: "filter_mismatch",
            lastError: "filter_mismatch",
            actionPermit: null,
            actionPermitExpiresAt: null
          },
          now
        );
        throw new BrowserRefreshServiceError(
          "filter_mismatch",
          "The visible Jiaoyimao filters do not match the required scope"
        );
      }
      return this.repository.getJob(id, now)!;
    } catch (error) {
      if (error instanceof BrowserRefreshServiceError) throw error;
      throw this.mapError(error);
    }
  }

  submitListBatch(
    id: string,
    bridgeToken: string,
    batch: BrowserListBatch
  ): AcceptedBatchView {
    const now = this.now();
    this.authenticate(id, bridgeToken, now);
    try {
      const replay = this.repository.replayListBatch(id, batch, now);
      if (replay) return replay;
      const job = this.repository.getJob(id, now)!;
      this.assertCommand(job, "submitListBatch");
      const proof = this.repository.getFilterProof(id, now);
      if (proof === null || validateFilterProof(proof).kind !== "ok") {
        this.repository.transition(
          id,
          ["collecting_list"],
          "paused",
          {
            stage: "collecting_list",
            reason: "filter_mismatch",
            lastError: "filter_mismatch"
          },
          now
        );
        throw new BrowserRefreshServiceError(
          "filter_mismatch",
          "A valid visible filter proof is required before list staging"
        );
      }
      return this.repository.acceptListBatch(id, batch, now);
    } catch (error) {
      if (error instanceof BrowserRefreshServiceError) throw error;
      throw this.mapError(error);
    }
  }

  submitLoadEvent(
    id: string,
    bridgeToken: string,
    event: BrowserLoadEvent
  ): AcceptedLoadEventView {
    const now = this.now();
    this.authenticate(id, bridgeToken, now);
    try {
      const replay = this.repository.replayLoadEvent(id, event, now);
      if (replay) return replay;
      const job = this.repository.getJob(id, now)!;
      this.assertCommand(job, "submitLoadEvent");
      this.assertActionPermitForOutcome(job, event.actionPermit, now);
      this.assertActionTime(job, now);
      const outcome = this.planLoadOutcome(id, job, event, now);
      const result = this.repository.acceptLoadEventAndTransition(
        id,
        event,
        outcome.transition,
        now
      );
      if (outcome.errorAfterCommit) throw outcome.errorAfterCommit;
      return result.accepted;
    } catch (error) {
      if (error instanceof BrowserRefreshServiceError) throw error;
      throw this.mapError(error);
    }
  }

  submitDetails(
    id: string,
    bridgeToken: string,
    batch: BrowserDetailBatch
  ): DetailProgressView {
    const now = this.now();
    this.authenticate(id, bridgeToken, now);
    try {
      const replay = this.repository.replayDetailBatch(id, batch, now);
      if (replay) return replay;
      const job = this.repository.getJob(id, now)!;
      this.assertCommand(job, "submitDetails");
      this.assertActionPermitForOutcome(job, batch.actionPermit, now);
      this.assertActionTime(job, now);
      const requiredIds = new Set(
        detailRequiredIds(this.repository.getListItems(id, now))
      );
      if (
        batch.items.some((item) => !requiredIds.has(item.sourceListingId))
      ) {
        throw new BrowserRefreshServiceError(
          "staging_invalid",
          "Detail evidence may only be staged for required list items"
        );
      }
      const completedIds = this.repository.getCompletedDetailIds(id, now);
      for (const item of batch.items) {
        completedIds.add(item.sourceListingId);
      }
      const complete = [...requiredIds].every((id) =>
        completedIds.has(id)
      );
      const result = this.repository.acceptDetailBatchAndTransition(
        id,
        batch,
        {
          next: complete ? "validating" : "collecting_details",
          patch: {
            stage: complete ? "validating" : "collecting_details",
            reason: null,
            cooldownAttempt: 0,
            cooldownUntil: null,
            actionPermit: null,
            actionPermitExpiresAt: null,
            nextActionAt: complete
              ? null
              : this.nextActionTimestamp("detail", now)
          }
        },
        now
      );
      return result.accepted;
    } catch (error) {
      if (error instanceof BrowserRefreshServiceError) throw error;
      throw this.mapError(error);
    }
  }

  pause(
    id: string,
    bridgeToken: string,
    pause: BrowserPause
  ): BrowserRefreshJobView {
    const now = this.now();
    const job = this.authenticate(id, bridgeToken, now);
    this.assertCommand(job, "pause");
    const target = this.resumeTarget(job);
    const verification =
      pause.reason === "login_required" ||
      pause.reason === "captcha_required";
    try {
      return this.repository.transition(
        id,
        [job.state],
        verification ? "awaiting_user_verification" : "paused",
        {
          stage: target,
          reason: pause.reason,
          lastError: pause.message ?? pause.reason,
          actionPermit: null,
          actionPermitExpiresAt: null
        },
        now
      );
    } catch (error) {
      throw this.mapError(error);
    }
  }

  resume(id: string, bridgeToken: string): BrowserRefreshJobView {
    const now = this.now();
    const job = this.authenticate(id, bridgeToken, now);
    this.assertCommand(job, "resume");
    const target = this.resumeTarget(job);
    try {
      if (
        job.reason === "process_interrupted" &&
        job.cooldownAttempt > 0 &&
        job.cooldownUntil !== null
      ) {
        return this.repository.transition(
          id,
          ["paused"],
          "cooling_down",
          {
            stage: target,
            reason: "rate_limited",
            lastError: "process_interrupted"
          },
          now
        );
      }
      return this.repository.transition(
        id,
        [job.state],
        target,
        {
          stage: target,
          reason: null,
          lastError: null,
          cooldownAttempt: 0,
          cooldownUntil: null,
          actionPermit: null,
          actionPermitExpiresAt: null
        },
        now
      );
    } catch (error) {
      throw this.mapError(error);
    }
  }

  startCooldown(
    id: string,
    bridgeToken: string
  ): BrowserRefreshJobView {
    const now = this.now();
    const job = this.authenticate(id, bridgeToken, now);
    this.assertCommand(job, "startCooldown");
    const target = this.resumeTarget(job);
    try {
      if (job.cooldownAttempt >= COOLDOWN_DELAYS_MS.length) {
        return this.repository.transition(
          id,
          [job.state],
          "paused",
          {
            stage: target,
            reason: "rate_limited",
            lastError: "rate_limited",
            cooldownUntil: null,
            nextActionAt: null,
            actionPermit: null,
            actionPermitExpiresAt: null
          },
          now
        );
      }
      const cooldownAttempt = job.cooldownAttempt + 1;
      return this.repository.transition(
        id,
        [job.state],
        "cooling_down",
        {
          stage: target,
          reason: "rate_limited",
          lastError: "rate_limited",
          cooldownAttempt,
          cooldownUntil: new Date(
            now.getTime() + COOLDOWN_DELAYS_MS[cooldownAttempt - 1]
          ).toISOString(),
          nextActionAt: null,
          actionPermit: null,
          actionPermitExpiresAt: null
        },
        now
      );
    } catch (error) {
      throw this.mapError(error);
    }
  }

  keepWaiting(id: string): BrowserRefreshJobView {
    const now = this.now();
    const job = this.requireJob(id, now);
    this.assertCommand(job, "keepWaiting");
    try {
      return this.repository.keepWaiting(id, now);
    } catch (error) {
      throw this.mapError(error);
    }
  }

  cancel(id: string): BrowserRefreshJobView {
    const now = this.now();
    const job = this.requireJob(id, now);
    this.assertCommand(job, "cancel");
    try {
      return this.repository.transition(
        id,
        [job.state],
        "cancelled",
        {
          stage: "cancelled",
          reason: "cancelled",
          cooldownUntil: null,
          nextActionAt: null,
          actionPermit: null,
          actionPermitExpiresAt: null
        },
        now
      );
    } catch (error) {
      throw this.mapError(error);
    }
  }

  complete(
    id: string,
    bridgeToken: string
  ): void | Promise<void> {
    const now = this.now();
    const job = this.authenticate(id, bridgeToken, now);
    const readiness = evaluatePublishReadiness(
      this.repository.getFilterProof(id, now),
      this.repository.getLoadEvents(id, now),
      this.repository.getListItems(id, now),
      this.repository.getCompletedDetailIds(id, now)
    );
    if (readiness.kind !== "ready") {
      throw new BrowserRefreshServiceError(
        readiness.reason,
        `Browser refresh is not ready: ${readiness.reason}`
      );
    }
    this.assertCommand(job, "complete");
    if (!this.completeJobCallback) {
      throw new BrowserRefreshServiceError(
        "staging_invalid",
        "No browser refresh completion callback is configured"
      );
    }
    try {
      this.repository.transition(
        id,
        ["validating"],
        "committing",
        {
          stage: "committing",
          reason: null,
          nextActionAt: null,
          actionPermit: null,
          actionPermitExpiresAt: null
        },
        now
      );
      const result = this.completeJobCallback(id);
      if (result instanceof Promise) {
        return result.catch((error: unknown) => {
          throw new BrowserRefreshServiceError(
            "staging_invalid",
            error instanceof Error
              ? `Completion failed: ${error.message}`
              : "Completion failed"
          );
        });
      }
    } catch (error) {
      if (error instanceof BrowserRefreshServiceError) throw error;
      throw this.mapError(error);
    }
  }

  private planLoadOutcome(
    id: string,
    job: BrowserRefreshJobView,
    event: BrowserLoadEvent,
    now: Date
  ): PlannedOutcome {
    const resumeTarget = this.resumeTarget(job);
    if (event.blockingState === "login" || event.blockingState === "captcha") {
      return {
        transition: {
          next: "awaiting_user_verification",
          patch: {
            stage: resumeTarget,
            reason: event.blockingState === "login"
              ? "login_required"
              : "captcha_required",
            actionPermit: null,
            actionPermitExpiresAt: null,
            nextActionAt: null
          }
        }
      };
    }
    if (event.blockingState === "error") {
      return {
        transition: {
          next: "paused",
          patch: {
            stage: resumeTarget,
            reason: "structure_changed",
            lastError: "structure_changed",
            nextActionAt: null
          }
        }
      };
    }
    if (event.blockingState === "rate_limited" || event.loadingVisible) {
      return {
        transition: {
          next: job.state,
          patch: {
            stage: job.stage
          }
        }
      };
    }

    const events = [...this.repository.getLoadEvents(id, now), event];
    const naturalEnd = evaluateNaturalEnd(events);
    if (naturalEnd.kind === "incomplete" &&
        naturalEnd.reason === "safety_limit") {
      return {
        transition: {
          next: "paused",
          patch: {
            stage: resumeTarget,
            reason: "safety_limit",
            lastError: "safety_limit",
            nextActionAt: null,
            actionPermit: null,
            actionPermitExpiresAt: null
          }
        }
      };
    }
    if (naturalEnd.kind === "complete") {
      const items = this.repository.getListItems(id, now);
      if (
        events.at(-1)?.observedUniqueCount !==
        new Set(items.map((item) => item.sourceListingId)).size
      ) {
        return {
          transition: {
            next: "paused",
            patch: {
              stage: resumeTarget,
              reason: "staging_invalid",
              lastError: "staging_invalid",
              nextActionAt: null,
              actionPermit: null,
              actionPermitExpiresAt: null
            }
          },
          errorAfterCommit: new BrowserRefreshServiceError(
            "staging_invalid",
            "The staged list count does not match the visible unique count"
          )
        };
      }
      const requiredCount = detailRequiredIds(items).length;
      return {
        transition: {
          next: requiredCount === 0
            ? "validating"
            : "collecting_details",
          patch: {
            stage: requiredCount === 0
              ? "validating"
              : "collecting_details",
            reason: naturalEnd.reason,
            detailRequiredCount: requiredCount,
            detailCompletedCount: 0,
            cooldownAttempt: 0,
            cooldownUntil: null,
            nextActionAt: requiredCount === 0
              ? null
              : this.nextActionTimestamp("detail", now),
            actionPermit: null,
            actionPermitExpiresAt: null
          }
        }
      };
    }
    return {
      transition: {
        next: job.state,
        patch: {
          stage: job.state,
          reason: null,
          cooldownAttempt: 0,
          cooldownUntil: null,
          nextActionAt: this.nextActionTimestamp("list", now),
          actionPermit: null,
          actionPermitExpiresAt: null
        }
      }
    };
  }

  private requireJob(id: string, now: Date): BrowserRefreshJobView {
    try {
      const job = this.repository.getJob(id, now);
      if (!job) {
        throw new BrowserRefreshServiceError(
          "browser_job_not_found",
          "Browser refresh job not found"
        );
      }
      if (job.state === "expired") {
        throw new BrowserRefreshServiceError(
          "browser_job_expired",
          "Browser refresh job expired"
        );
      }
      return job;
    } catch (error) {
      if (error instanceof BrowserRefreshServiceError) throw error;
      throw this.mapError(error);
    }
  }

  private authenticate(
    id: string,
    bridgeToken: string,
    now: Date
  ): BrowserRefreshJobView {
    this.requireJob(id, now);
    try {
      return this.repository.verifyBridgeToken(id, bridgeToken, now);
    } catch (error) {
      throw this.mapError(error);
    }
  }

  private assertCommand(
    job: BrowserRefreshJobView,
    command: BrowserRefreshCommand
  ): void {
    const commands =
      BROWSER_REFRESH_STATE_COMMANDS[job.state] as readonly string[];
    if (!commands.includes(command)) {
      throw new BrowserRefreshServiceError(
        "invalid_transition",
        `Command ${command} is invalid in state ${job.state}`
      );
    }
  }

  private assertActionTime(
    job: BrowserRefreshJobView,
    now: Date
  ): void {
    if (
      job.cooldownUntil !== null &&
      Date.parse(job.cooldownUntil) > now.getTime()
    ) {
      throw new BrowserRefreshServiceError(
        "cooldown_active",
        "The browser action is still cooling down",
        job.cooldownUntil
      );
    }
    if (
      job.nextActionAt !== null &&
      Date.parse(job.nextActionAt) > now.getTime()
    ) {
      throw new BrowserRefreshServiceError(
        "action_too_early",
        "The next serial browser action is not allowed yet",
        job.nextActionAt
      );
    }
  }

  private assertActionPermitForOutcome(
    job: BrowserRefreshJobView,
    supplied: string | undefined,
    now: Date
  ): void {
    if (job.actionPermitExpiresAt === null) return;
    if (supplied === undefined) {
      throw new BrowserRefreshServiceError(
        "action_permit_required",
        "The one-use action permit is required"
      );
    }
    if (
      job.actionPermitConsumedAt !== null ||
      Date.parse(job.actionPermitExpiresAt) <= now.getTime()
    ) {
      throw new BrowserRefreshServiceError(
        "action_permit_invalid",
        "The one-use action permit is expired or consumed"
      );
    }
  }

  private resumeTarget(
    job: BrowserRefreshJobView
  ): "collecting_list" | "collecting_details" | "validating" {
    if (job.stage === "validating" || job.state === "validating") {
      return "validating";
    }
    if (
      job.stage === "collecting_details" ||
      job.state === "collecting_details"
    ) {
      return "collecting_details";
    }
    return "collecting_list";
  }

  private nextActionTimestamp(
    kind: "list" | "detail",
    now: Date
  ): string {
    const [minimum, maximum] = kind === "list"
      ? [1_200, 2_500]
      : [2_000, 3_500];
    const random = Math.min(1, Math.max(0, this.random()));
    const delay = minimum + Math.round((maximum - minimum) * random);
    return new Date(now.getTime() + delay).toISOString();
  }

  private mapError(error: unknown): BrowserRefreshServiceError {
    if (error instanceof BrowserRefreshServiceError) return error;
    if (error instanceof ZodError) {
      return new BrowserRefreshServiceError(
        "staging_invalid",
        "Browser refresh staging input is invalid"
      );
    }
    if (error instanceof BrowserRefreshRepositoryError) {
      switch (error.code) {
        case "job_not_found":
          return new BrowserRefreshServiceError(
            "browser_job_not_found",
            error.message
          );
        case "active_job_exists":
          return new BrowserRefreshServiceError(
            "browser_job_conflict",
            error.message
          );
        case "invalid_bridge_token":
        case "invalid_claim_code":
        case "job_terminal":
          return new BrowserRefreshServiceError(
            "bridge_unauthorized",
            error.message
          );
        case "invalid_action_permit":
          return new BrowserRefreshServiceError(
            "action_permit_invalid",
            error.message
          );
        case "invalid_transition":
        case "invalid_terminal_linkage":
          return new BrowserRefreshServiceError(
            "invalid_transition",
            error.message
          );
        case "invalid_load_event":
        case "sequence_conflict":
          return new BrowserRefreshServiceError(
            /limit/i.test(error.message)
              ? "safety_limit"
              : "staging_invalid",
            error.message
          );
        case "batch_conflict":
        case "missing_list_item":
        case "browser_refresh_corrupt_replay":
          return new BrowserRefreshServiceError(
            "staging_invalid",
            error.message
          );
      }
    }
    return new BrowserRefreshServiceError(
      "staging_invalid",
      error instanceof Error ? error.message : "Browser refresh failed"
    );
  }
}
