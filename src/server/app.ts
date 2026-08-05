import express, {
  type ErrorRequestHandler,
  type Express,
  type RequestHandler,
  type Response
} from "express";
import { setTimeout as delay } from "node:timers/promises";
import { z, ZodError } from "zod";
import {
  selectBalancedCandidatePool,
  selectGlobalCandidatePool
} from "../domain/candidatePool.js";
import {
  EligibilitySchema,
  SourceIdSchema,
  type Listing,
  type SourceId
} from "../domain/listing.js";
import {
  parseManualExclusionInput,
  type ReviewedListing
} from "../domain/manualReview.js";
import { summarizeReviewedListing } from "../domain/listingSummary.js";
import { compareRecommendations } from "../domain/score.js";
import {
  BROWSER_REFRESH_LIMITS,
  BrowserCooldownSchema,
  BrowserDetailBatchSchema,
  BrowserFilterProofSchema,
  BrowserListBatchSchema,
  BrowserLoadEventSchema,
  BrowserPauseSchema
} from "./browserRefresh/contracts.js";
import type {
  BrowserRefreshRepository
} from "./browserRefresh/repository.js";
import {
  BrowserRefreshServiceError,
  type BrowserRefreshServiceErrorCode,
  type JiaoyimaoBrowserTaskService
} from "./browserRefresh/service.js";
import {
  ManualListingReviewError,
  type ListingRepository,
  type ScanState,
  type SourceStatus
} from "./repository.js";
import type {
  RefreshMode,
  RefreshProgressEvent
} from "./collector/coordinator.js";
import {
  RefreshAdmissionController
} from "./refreshAdmission.js";
import type { RefreshTracker } from "./refreshTracker.js";
import type {
  RefreshScheduler,
  RefreshTriggerResult
} from "./refreshScheduler.js";
import {
  PanzhiAutomationRepositoryError
} from "./panzhiAutomation/repository.js";
import {
  PanzhiAutomationServiceError,
  type PanzhiAutomationService
} from "./panzhiAutomation/service.js";
import {
  PanzhiSnapshotPublisher,
  PanzhiSnapshotPublisherError
} from "./panzhiAutomation/publisher.js";

interface RefreshCoordinator {
  refreshAll(
    runId: number,
    onProgress?: (event: RefreshProgressEvent) => void,
    mode?: RefreshMode
  ): Promise<ScanState>;
}

export interface AppDependencies {
  repository: ListingRepository;
  coordinator: RefreshCoordinator;
  tracker: RefreshTracker;
  admission: RefreshAdmissionController;
  browserRepository: BrowserRefreshRepository;
  browserService: JiaoyimaoBrowserTaskService;
  scheduler?: Pick<RefreshScheduler, "snapshot" | "trigger">;
  panzhiAutomationService?: PanzhiAutomationService;
  panzhiPublisher?: PanzhiSnapshotPublisher;
  now?: () => Date;
}

const ListingViewSchema = z.enum(["pool", "all"]);
const PoolModeSchema = z.enum(["balanced", "global"]);
const HistoryLimitSchema = z.coerce.number().int().min(1).max(50);
const EmptyBodySchema = z.strictObject({});
const RefreshModeSchema = z.enum(["quick", "deep"]);
const RefreshRequestSchema = z.object({
  mode: RefreshModeSchema.optional().default("quick")
}).passthrough();
const RefreshEventLimitSchema = z.coerce.number().int().min(1).max(100);
const AcknowledgeRefreshEventsSchema = z.strictObject({
  ids: z.array(z.number().int().positive()).max(100).optional()
});
const ClaimBodySchema = z.strictObject({
  claimCode: z.string()
});
const PanzhiAutomationClaimBodySchema = z.union([
  z.strictObject({}),
  z.strictObject({ jobId: z.uuid() })
]);
const PanzhiAutomationResumeJobSchema = z.object({
  jobId: z.uuid()
}).passthrough();
const PanzhiAutomationStateBodySchema = z.strictObject({
  state: z.enum([
    "applying_filters",
    "collecting",
    "awaiting_user_verification",
    "submitting",
    "failed"
  ]),
  error: z.string().trim().min(1).max(500).optional()
});
const PanzhiAutomationDelayBodySchema = z.strictObject({
  milliseconds: z.number().int().min(0).max(10_000)
});
type PoolMode = z.infer<typeof PoolModeSchema>;

const BROWSER_ERROR_MESSAGES: Record<
  BrowserRefreshServiceErrorCode,
  string
> = {
  browser_job_not_found: "交易猫浏览器刷新任务不存在",
  browser_job_conflict: "交易猫浏览器刷新任务已存在",
  browser_job_expired: "交易猫浏览器刷新任务已过期",
  bridge_unauthorized: "浏览器桥接凭据无效或已过期",
  invalid_transition: "当前任务状态不允许此操作",
  filter_mismatch: "页面筛选条件与目标不一致",
  staging_invalid: "浏览器采集数据无效",
  list_incomplete: "列表采集尚未完成",
  details_incomplete: "详情采集尚未完成",
  safety_limit: "浏览器采集已达到安全上限",
  cooldown_active: "浏览器采集仍在冷却中",
  action_too_early: "尚未到下一次浏览器操作时间",
  action_permit_required: "本次操作需要一次性许可",
  action_permit_invalid: "一次性操作许可无效或已过期"
};

function sendBrowserError(
  response: Response,
  error: unknown,
  bridgeRoute = false
): void {
  if (error instanceof ZodError) {
    response.status(400).json({
      error: "invalid_browser_payload",
      message: "浏览器刷新请求格式无效"
    });
    return;
  }
  if (error instanceof BrowserRefreshServiceError) {
    if (
      error.code === "bridge_unauthorized" ||
      (bridgeRoute && error.code === "browser_job_expired")
    ) {
      response.status(401).json({
        error: "bridge_unauthorized",
        message: BROWSER_ERROR_MESSAGES.bridge_unauthorized
      });
      return;
    }
    const status = error.code === "browser_job_not_found" ? 404 : 409;
    response.status(status).json({
      error: error.code,
      message: BROWSER_ERROR_MESSAGES[error.code],
      ...(error.retryAt ? { retryAt: error.retryAt } : {})
    });
    return;
  }
  response.status(500).json({
    error: "browser_refresh_failed",
    message: "交易猫浏览器刷新操作失败"
  });
}

function sendManualReviewError(
  response: Response,
  error: unknown
): void {
  if (error instanceof ZodError) {
    response.status(400).json({
      error: "invalid_manual_review",
      message: "人工淘汰信息无效"
    });
    return;
  }
  if (error instanceof ManualListingReviewError) {
    if (error.code === "listing_not_found") {
      response.status(404).json({
        error: error.code,
        message: "候选不存在或已下架"
      });
      return;
    }
    response.status(409).json({
      error: error.code,
      message: "该账号不满足 QQ 官服与 ¥1,900–¥4,000 价格条件，不能人工淘汰"
    });
    return;
  }
  response.status(500).json({
    error: "manual_review_failed",
    message: "人工淘汰操作失败，请稍后重试"
  });
}

function sendPanzhiAutomationError(
  response: Response,
  error: unknown
): void {
  if (error instanceof ZodError) {
    response.status(400).json({
      error: "invalid_panzhi_automation_payload",
      message: "盼之自动化请求格式无效"
    });
    return;
  }
  if (error instanceof PanzhiAutomationRepositoryError) {
    const status = error.code === "unauthorized"
      ? 401
      : error.code === "not_found" || error.code === "expired"
        ? 404
        : 409;
    response.status(status).json({
      error: error.code,
      message: status === 401
        ? "盼之自动化凭据无效"
        : status === 404
          ? "盼之自动化任务不存在或已过期"
          : "盼之自动化任务状态冲突"
    });
    return;
  }
  if (error instanceof PanzhiAutomationServiceError) {
    const status = error.code === "unauthorized"
      ? 401
      : error.code === "not_found" || error.code === "expired"
        ? 404
        : 409;
    response.status(status).json({
      error: error.code,
      message: status === 401
        ? "盼之自动化凭据无效"
        : status === 404
          ? "盼之自动化任务不存在或已过期"
          : "盼之自动化任务状态冲突",
      ...(error.code === "refresh_conflict" && error.details?.activeKind
        ? {
            activeKind: error.details.activeKind,
            ...(error.details.jobId ? { jobId: error.details.jobId } : {})
          }
        : {})
    });
    return;
  }
  response.status(500).json({
    error: "panzhi_automation_failed",
    message: "盼之自动化操作失败"
  });
}

function readBearerToken(authorization: string | undefined): string {
  if (!authorization) return "";
  const match = authorization.match(/^Bearer[ \t]+(.*)$/i);
  return match?.[1] ?? authorization;
}

function readStrictBearerToken(
  authorization: string | undefined
): string {
  const match = authorization?.match(/^Bearer[ \t]+([^\s]+)$/i);
  return match?.[1] ?? "";
}

const BROWSER_REFRESH_PATH_PREFIXES = [
  "/api/browser-refresh",
  "/api/sources/jiaoyimao/browser-refresh"
] as const;
const PANZHI_BROWSER_SNAPSHOT_PATH =
  "/api/sources/panzhi/browser-snapshot";
const PANZHI_AUTOMATION_PREFIX =
  "/api/sources/panzhi/automation";
const PANZHI_AUTOMATION_SNAPSHOT_PATH =
  `${PANZHI_AUTOMATION_PREFIX}/jobs/:id/snapshot`;
const PANZHI_BROWSER_SNAPSHOT_MAX_BYTES = 1024 * 1024;

function isBrowserRefreshPath(path: string): boolean {
  const pathname = (path.split("?")[0] ?? "").toLowerCase();
  return BROWSER_REFRESH_PATH_PREFIXES.some((prefix) =>
    pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

function hasJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  return /^application\/json\s*(?:;\s*charset\s*=\s*(?:utf-8|"utf-8")\s*)?$/i
    .test(contentType.trim());
}

function createStrictJsonBodyReader(
  limit: number,
  tooLargeMessage: string
): RequestHandler {
  return (request, response, next) => {
  let settled = false;
  let received = 0;
  const chunks: Buffer[] = [];

  const rejectTooLarge = (): void => {
    if (settled) return;
    settled = true;
    chunks.length = 0;
    request.off("data", onData);
    request.resume();
    response.status(413).json({
      error: "browser_payload_too_large",
      message: tooLargeMessage
    });
  };
  const rejectInvalid = (
    status: 400 | 415,
    message: string
  ): void => {
    if (settled) return;
    settled = true;
    chunks.length = 0;
    response.status(status).json({
      error: "invalid_browser_payload",
      message
    });
  };

  const contentLength = request.get("content-length");
  if (contentLength !== undefined) {
    if (!/^\d+$/.test(contentLength)) {
      request.resume();
      rejectInvalid(400, "浏览器刷新请求格式无效");
      return;
    }
    if (BigInt(contentLength) > BigInt(limit)) {
      rejectTooLarge();
      return;
    }
  }

  function onData(chunk: Buffer | string): void {
    if (settled) return;
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk);
    received += buffer.length;
    if (received > limit) {
      rejectTooLarge();
      return;
    }
    chunks.push(buffer);
  }
  request.on("data", onData);
  request.once("aborted", () => {
    settled = true;
    chunks.length = 0;
  });
  request.once("error", () => {
    rejectInvalid(400, "浏览器刷新请求格式无效");
  });
  request.once("end", () => {
    if (settled) return;
    const body = Buffer.concat(chunks, received);
    chunks.length = 0;
    const contentEncoding = (
      request.get("content-encoding") ?? "identity"
    ).trim().toLowerCase();
    if (contentEncoding !== "identity") {
      rejectInvalid(415, "浏览器刷新请求编码不受支持");
      return;
    }
    if (request.method === "GET" || request.method === "HEAD") {
      settled = true;
      request.body = body;
      next();
      return;
    }
    if (!hasJsonContentType(request.get("content-type"))) {
      rejectInvalid(
        400,
        "浏览器刷新请求必须使用 application/json"
      );
      return;
    }
    if (body.length === 0) {
      rejectInvalid(400, "浏览器刷新请求格式无效");
      return;
    }
    try {
      const text = new TextDecoder("utf-8", { fatal: true })
        .decode(body);
      request.body = JSON.parse(text);
      settled = true;
      next();
    } catch {
      rejectInvalid(400, "浏览器刷新请求格式无效");
    }
  });
  };
}

const readBrowserBody = createStrictJsonBodyReader(
  BROWSER_REFRESH_LIMITS.maxBatchUtf8Bytes,
  "浏览器刷新请求超过 128 KiB 限制"
);
const readPanzhiBrowserSnapshotBody = createStrictJsonBodyReader(
  PANZHI_BROWSER_SNAPSHOT_MAX_BYTES,
  "盼之浏览器快照请求超过 1 MiB 限制"
);

interface CurrentListingSnapshot {
  statuses: SourceStatus[];
  listings: ReviewedListing[];
  activeEligibleListings: ReviewedListing[];
  balancedPool: ReviewedListing[];
  globalPool: ReviewedListing[];
}

function readCurrentListingSnapshot(
  repository: ListingRepository
): CurrentListingSnapshot {
  const statuses = repository.getSourceStatuses();
  const listings = repository.getReviewedListings();
  const activeSources = new Set(
    statuses
      .filter(
        ({ state }) => state === "success" || state === "partial"
      )
      .map(({ source }) => source)
  );
  const activeEligibleListings = listings.filter(
    (listing) =>
      activeSources.has(listing.source) &&
      listing.eligibility === "eligible" &&
      listing.manualReview === null
  );

  return {
    statuses,
    listings,
    activeEligibleListings,
    balancedPool: selectBalancedCandidatePool(
      activeEligibleListings
    ) as ReviewedListing[],
    globalPool: selectGlobalCandidatePool(
      activeEligibleListings
    ) as ReviewedListing[]
  };
}

function candidatePool(
  snapshot: CurrentListingSnapshot,
  mode: PoolMode
): ReviewedListing[] {
  return mode === "balanced"
    ? snapshot.balancedPool
    : snapshot.globalPool;
}

function candidateCounts(listings: Listing[]): Map<SourceId, number> {
  const counts = new Map<SourceId, number>();
  for (const listing of listings) {
    counts.set(
      listing.source,
      (counts.get(listing.source) ?? 0) + 1
    );
  }
  return counts;
}

function derivedSourceStatuses(
  snapshot: CurrentListingSnapshot,
  mode: PoolMode
) {
  const eligibleCounts = new Map<SourceId, number>();
  const balancedCounts = candidateCounts(snapshot.balancedPool);
  const globalCounts = candidateCounts(snapshot.globalPool);

  for (const listing of snapshot.activeEligibleListings) {
    if (listing.score !== null) {
      eligibleCounts.set(
        listing.source,
        (eligibleCounts.get(listing.source) ?? 0) + 1
      );
    }
  }
  return snapshot.statuses.map((status) => ({
    ...status,
    eligibleCount: eligibleCounts.get(status.source) ?? 0,
    candidateCount:
      (mode === "balanced" ? balancedCounts : globalCounts).get(
        status.source
      ) ?? 0,
    balancedCandidateCount: balancedCounts.get(status.source) ?? 0,
    globalCandidateCount: globalCounts.get(status.source) ?? 0,
    completion: status.state === "success" ? "complete" : status.state
  }));
}

export function createApp(dependencies?: AppDependencies): Express {
  const app = express();

  for (const prefix of BROWSER_REFRESH_PATH_PREFIXES) {
    app.use(prefix, readBrowserBody);
  }
  app.use(
    PANZHI_BROWSER_SNAPSHOT_PATH,
    readPanzhiBrowserSnapshotBody
  );
  app.use(
    PANZHI_AUTOMATION_SNAPSHOT_PATH,
    readPanzhiBrowserSnapshotBody
  );
  app.use(express.json({ limit: "256kb" }));
  app.get("/api/health", (_request, response) => {
    response.json({
      ok: true,
      service: "delta-account-scout"
    });
  });

  if (!dependencies) {
    app.use(PANZHI_AUTOMATION_PREFIX, (_request, response) => {
      response.status(503).json({
        error: "panzhi_automation_unavailable",
        message: "盼之自动化服务未配置"
      });
    });
    return app;
  }

  const {
    repository,
    coordinator,
    tracker,
    admission,
    browserRepository,
    browserService,
    scheduler,
    panzhiAutomationService,
    panzhiPublisher: providedPanzhiPublisher,
    now = () => new Date()
  } = dependencies;
  const panzhiPublisher = providedPanzhiPublisher ??
    new PanzhiSnapshotPublisher(repository);

  const bridgeToken = (
    authorization: string | undefined
  ): string => readBearerToken(authorization);

  app.post(PANZHI_BROWSER_SNAPSHOT_PATH, (request, response) => {
    const capturedAt = now();
    let acquired;
    try {
      acquired = admission.withAllSourcesLease(() =>
        panzhiPublisher.publish(request.body, capturedAt)
      );
      if (acquired.kind === "conflict") {
        response.status(409).json({
          error: "refresh_conflict",
          message: "另一个刷新任务正在进行",
          activeKind: acquired.activeKind,
          ...(acquired.jobId ? { jobId: acquired.jobId } : {})
        });
        return;
      }
      tracker.synchronize(repository.getRefreshSnapshot());
      const { published: _published, ...publicResult } = acquired.value;
      response.json({
        ...publicResult
      });
    } catch (error) {
      if (error instanceof ZodError) {
        response.status(400).json({
          error: "invalid_panzhi_browser_snapshot",
          message: "盼之浏览器快照或原生价格筛选证明无效"
        });
        return;
      }
      if (error instanceof PanzhiSnapshotPublisherError) {
        response.status(409).json({
          error: error.code,
          message: error.message
        });
        return;
      }
      response.status(500).json({
        error: "panzhi_browser_snapshot_failed",
        message: "盼之浏览器快照发布失败"
      });
    } finally {
      if (acquired?.kind === "acquired") acquired.lease.release();
    }
  });

  const unavailablePanzhiAutomation = (response: Response): void => {
    response.status(503).json({
      error: "panzhi_automation_unavailable",
      message: "盼之自动化服务未配置"
    });
  };

  app.use(PANZHI_AUTOMATION_PREFIX, (request, response, next) => {
    if (Object.keys(request.query).length > 0) {
      response.status(400).json({
        error: "invalid_panzhi_automation_payload",
        message: "盼之自动化请求格式无效"
      });
      return;
    }
    next();
  });

  app.get(`${PANZHI_AUTOMATION_PREFIX}/status`, (_request, response) => {
    if (!panzhiAutomationService) {
      unavailablePanzhiAutomation(response);
      return;
    }
    try {
      response.json(panzhiAutomationService.status());
    } catch (error) {
      sendPanzhiAutomationError(response, error);
    }
  });

  app.post(`${PANZHI_AUTOMATION_PREFIX}/heartbeat`, (request, response) => {
    if (!panzhiAutomationService) {
      unavailablePanzhiAutomation(response);
      return;
    }
    try {
      EmptyBodySchema.parse(request.body);
      response.json(panzhiAutomationService.recordExtensionHeartbeat());
    } catch (error) {
      sendPanzhiAutomationError(response, error);
    }
  });

  app.post(`${PANZHI_AUTOMATION_PREFIX}/jobs/claim`, (request, response) => {
    if (!panzhiAutomationService) {
      unavailablePanzhiAutomation(response);
      return;
    }
    try {
      const rawAuthorization = request.get("authorization");
      if (rawAuthorization !== undefined) {
        const resume = PanzhiAutomationResumeJobSchema.safeParse(request.body);
        if (!resume.success) {
          throw new PanzhiAutomationServiceError(
            "unauthorized",
            "A valid resume job id is required"
          );
        }
        const token = readStrictBearerToken(rawAuthorization);
        panzhiAutomationService.authenticateRequest(
          resume.data.jobId,
          token
        );
        PanzhiAutomationClaimBodySchema.parse(request.body);
        response.json(panzhiAutomationService.resume(
          resume.data.jobId,
          token
        ));
        return;
      }
      const body = PanzhiAutomationClaimBodySchema.parse(request.body);
      if ("jobId" in body) {
        throw new PanzhiAutomationServiceError(
          "unauthorized",
          "A bearer token is required to resume a job"
        );
      }
      const claimed = panzhiAutomationService.claim();
      if (!claimed) {
        response.status(204).end();
        return;
      }
      response.status(202).json(claimed);
    } catch (error) {
      sendPanzhiAutomationError(response, error);
    }
  });

  app.post(
    `${PANZHI_AUTOMATION_PREFIX}/jobs/:id/heartbeat`,
    (request, response) => {
      if (!panzhiAutomationService) {
        unavailablePanzhiAutomation(response);
        return;
      }
      try {
        const token = readStrictBearerToken(request.get("authorization"));
        panzhiAutomationService.authenticateRequest(
          request.params.id,
          token
        );
        EmptyBodySchema.parse(request.body);
        response.json(panzhiAutomationService.heartbeat(
          request.params.id,
          token
        ));
      } catch (error) {
        sendPanzhiAutomationError(response, error);
      }
    }
  );

  app.post(
    `${PANZHI_AUTOMATION_PREFIX}/jobs/:id/delay`,
    async (request, response) => {
      if (!panzhiAutomationService) {
        unavailablePanzhiAutomation(response);
        return;
      }
      try {
        const token = readStrictBearerToken(request.get("authorization"));
        panzhiAutomationService.authenticateRequest(
          request.params.id,
          token
        );
        const body = PanzhiAutomationDelayBodySchema.parse(request.body);
        await delay(body.milliseconds);
        response.json({ completed: true });
      } catch (error) {
        sendPanzhiAutomationError(response, error);
      }
    }
  );

  app.post(
    `${PANZHI_AUTOMATION_PREFIX}/jobs/:id/state`,
    (request, response) => {
      if (!panzhiAutomationService) {
        unavailablePanzhiAutomation(response);
        return;
      }
      try {
        const token = readStrictBearerToken(request.get("authorization"));
        panzhiAutomationService.authenticateRequest(
          request.params.id,
          token
        );
        const body = PanzhiAutomationStateBodySchema.parse(request.body);
        response.json(panzhiAutomationService.updateState(
          request.params.id,
          token,
          body
        ));
      } catch (error) {
        sendPanzhiAutomationError(response, error);
      }
    }
  );

  app.post(PANZHI_AUTOMATION_SNAPSHOT_PATH, (request, response) => {
    if (!panzhiAutomationService) {
      unavailablePanzhiAutomation(response);
      return;
    }
    try {
      const token = readStrictBearerToken(request.get("authorization"));
      panzhiAutomationService.authenticateRequest(request.params.id, token);
      response.json(panzhiAutomationService.submitSnapshot(
        request.params.id,
        token,
        request.body
      ));
    } catch (error) {
      sendPanzhiAutomationError(response, error);
    }
  });

  app.post(
    `${PANZHI_AUTOMATION_PREFIX}/jobs/:id/cancel`,
    (request, response) => {
      if (!panzhiAutomationService) {
        unavailablePanzhiAutomation(response);
        return;
      }
      try {
        const token = readStrictBearerToken(request.get("authorization"));
        panzhiAutomationService.authenticateRequest(
          request.params.id,
          token
        );
        EmptyBodySchema.parse(request.body);
        response.json(panzhiAutomationService.cancel(
          request.params.id,
          token
        ));
      } catch (error) {
        sendPanzhiAutomationError(response, error);
      }
    }
  );

  app.post(
    "/api/sources/jiaoyimao/browser-refresh",
    (request, response) => {
      try {
        EmptyBodySchema.parse(request.body);
        const acquired = admission.withBrowserLease(
          () => browserService.create()
        );
        if (acquired.kind === "conflict") {
          response.status(409).json({
            error: "refresh_conflict",
            message: "另一个刷新任务正在进行",
            activeKind: acquired.activeKind,
            ...(acquired.jobId ? { jobId: acquired.jobId } : {})
          });
          return;
        }
        response.status(202).json({
          jobId: acquired.value.id,
          state: acquired.value.state,
          claimCode: acquired.value.claimCode,
          expiresAt: acquired.value.expiresAt
        });
      } catch (error) {
        sendBrowserError(response, error);
      }
    }
  );

  app.get(
    "/api/sources/jiaoyimao/browser-refresh/current",
    (_request, response) => {
      try {
        response.json(browserRepository.getCurrentJob(now()));
      } catch (error) {
        sendBrowserError(response, error);
      }
    }
  );

  app.post(
    "/api/sources/jiaoyimao/browser-refresh/:id/cancel",
    (request, response) => {
      try {
        EmptyBodySchema.parse(request.body);
        const job = browserService.cancel(request.params.id);
        admission.releaseBrowser(request.params.id);
        response.json(job);
      } catch (error) {
        sendBrowserError(response, error);
      }
    }
  );

  app.post(
    "/api/sources/jiaoyimao/browser-refresh/:id/keep-waiting",
    (request, response) => {
      try {
        EmptyBodySchema.parse(request.body);
        response.json(browserService.keepWaiting(request.params.id));
      } catch (error) {
        sendBrowserError(response, error);
      }
    }
  );

  app.post("/api/browser-refresh/:id/claim", (request, response) => {
    try {
      const body = ClaimBodySchema.parse(request.body);
      response.json(
        browserService.claim(request.params.id, body.claimCode)
      );
    } catch (error) {
      sendBrowserError(response, error);
    }
  });

  app.get("/api/browser-refresh/:id/work", (request, response) => {
    const token = bridgeToken(request.get("authorization"));
    try {
      response.json(browserService.getWork(request.params.id, token));
    } catch (error) {
      sendBrowserError(response, error, true);
    }
  });

  app.post(
    "/api/browser-refresh/:id/filter-proof",
    (request, response) => {
      const token = bridgeToken(request.get("authorization"));
      try {
        const authorization = browserService.authorize(
          request.params.id,
          token
        );
        const body = BrowserFilterProofSchema.parse(request.body);
        response.json(
          browserService.saveFilterProof(
            request.params.id,
            authorization,
            body
          )
        );
      } catch (error) {
        sendBrowserError(response, error, true);
      }
    }
  );

  app.post(
    "/api/browser-refresh/:id/list-batches",
    (request, response) => {
      const token = bridgeToken(request.get("authorization"));
      try {
        const authorization = browserService.authorize(
          request.params.id,
          token
        );
        const body = BrowserListBatchSchema.parse(request.body);
        response.json(
          browserService.submitListBatch(
            request.params.id,
            authorization,
            body
          )
        );
      } catch (error) {
        sendBrowserError(response, error, true);
      }
    }
  );

  app.post(
    "/api/browser-refresh/:id/load-events",
    (request, response) => {
      const token = bridgeToken(request.get("authorization"));
      try {
        const authorization = browserService.authorize(
          request.params.id,
          token
        );
        const body = BrowserLoadEventSchema.parse(request.body);
        response.json(
          browserService.submitLoadEvent(
            request.params.id,
            authorization,
            body
          )
        );
      } catch (error) {
        sendBrowserError(response, error, true);
      }
    }
  );

  app.post(
    "/api/browser-refresh/:id/details",
    (request, response) => {
      const token = bridgeToken(request.get("authorization"));
      try {
        const authorization = browserService.authorize(
          request.params.id,
          token
        );
        const body = BrowserDetailBatchSchema.parse(request.body);
        response.json(
          browserService.submitDetails(
            request.params.id,
            authorization,
            body
          )
        );
      } catch (error) {
        sendBrowserError(response, error, true);
      }
    }
  );

  app.post("/api/browser-refresh/:id/pause", (request, response) => {
    const token = bridgeToken(request.get("authorization"));
    try {
      const authorization = browserService.authorize(
        request.params.id,
        token
      );
      const body = BrowserPauseSchema.parse(request.body);
      response.json(
        browserService.pause(
          request.params.id,
          authorization,
          body
        )
      );
    } catch (error) {
      sendBrowserError(response, error, true);
    }
  });

  app.post("/api/browser-refresh/:id/resume", (request, response) => {
    const token = bridgeToken(request.get("authorization"));
    try {
      const authorization = browserService.authorize(
        request.params.id,
        token
      );
      EmptyBodySchema.parse(request.body);
      response.json(
        browserService.resume(request.params.id, authorization)
      );
    } catch (error) {
      sendBrowserError(response, error, true);
    }
  });

  app.post(
    "/api/browser-refresh/:id/cooldown",
    (request, response) => {
      const token = bridgeToken(request.get("authorization"));
      try {
        const authorization = browserService.authorize(
          request.params.id,
          token
        );
        BrowserCooldownSchema.parse(request.body);
        response.json(
          browserService.startCooldown(
            request.params.id,
            authorization
          )
        );
      } catch (error) {
        sendBrowserError(response, error, true);
      }
    }
  );

  app.post("/api/browser-refresh/:id/complete", (request, response) => {
    const token = bridgeToken(request.get("authorization"));
    try {
      const authorization = browserService.authorize(
        request.params.id,
        token
      );
      EmptyBodySchema.parse(request.body);
      response.json(
        browserService.complete(request.params.id, authorization)
      );
    } catch (error) {
      sendBrowserError(response, error, true);
    }
  });

  app.get("/api/sources", (request, response) => {
    const parsedMode =
      request.query.mode === undefined
        ? null
        : PoolModeSchema.safeParse(request.query.mode);
    if (parsedMode !== null && !parsedMode.success) {
      response.status(400).json({
        error: "invalid_pool_mode",
        message: "候选池模式无效"
      });
      return;
    }
    response.json(
      derivedSourceStatuses(
        readCurrentListingSnapshot(repository),
        parsedMode?.data ?? "balanced"
      )
    );
  });

  app.get("/api/listings", (request, response) => {
    const rawView = request.query.view;
    const rawStatus = request.query.status;
    const rawMode = request.query.mode;
    const parsedView =
      rawView === undefined ? null : ListingViewSchema.safeParse(rawView);
    const parsedStatus =
      rawStatus === undefined ? null : EligibilitySchema.safeParse(rawStatus);
    const parsedMode =
      rawMode === undefined ? null : PoolModeSchema.safeParse(rawMode);
    if (
      (parsedView !== null && !parsedView.success) ||
      (parsedStatus !== null && !parsedStatus.success) ||
      (parsedMode !== null && !parsedMode.success)
    ) {
      response.status(400).json({
        error: "invalid_listing_view",
        message: "候选视图参数无效"
      });
      return;
    }
    const status = parsedStatus?.data ?? "eligible";
    const view =
      parsedView?.data ?? (status === "eligible" ? "pool" : "all");
    const mode = parsedMode?.data ?? "balanced";
    if (
      (view === "pool" && status !== "eligible") ||
      (rawMode !== undefined &&
        (view !== "pool" || status !== "eligible"))
    ) {
      response.status(400).json({
        error: "invalid_listing_view",
        message: "候选视图参数无效"
      });
      return;
    }

    const snapshot = readCurrentListingSnapshot(repository);
    let listings: ReviewedListing[];
    if (status === "eligible") {
      listings = snapshot.listings.filter(
        (listing) =>
          listing.eligibility === "eligible" &&
          listing.manualReview === null
      );
    } else if (status === "rejected") {
      listings = Array.from(
        new Map(
          snapshot.listings
            .filter(
              (listing) =>
                listing.eligibility === "rejected" ||
                listing.manualReview !== null
            )
            .map((listing) => [listing.key, listing])
        ).values()
      );
    } else {
      listings = snapshot.listings.filter(
        (listing) => listing.eligibility === status
      );
    }
    response.json(
      (
        view === "pool"
          ? candidatePool(snapshot, mode)
          : listings.sort(compareRecommendations)
      ).map(summarizeReviewedListing)
    );
  });

  app.put(
    "/api/listings/:key/manual-exclusion",
    (request, response) => {
      try {
        const input = parseManualExclusionInput(request.body);
        response.json(
          repository.excludeListing(request.params.key, input)
        );
      } catch (error) {
        sendManualReviewError(response, error);
      }
    }
  );

  app.delete(
    "/api/listings/:key/manual-exclusion",
    (request, response) => {
      try {
        response.json(
          repository.restoreListing(request.params.key)
        );
      } catch (error) {
        sendManualReviewError(response, error);
      }
    }
  );

  app.get("/api/listings/:key/history", (request, response) => {
    const parsedLimit = HistoryLimitSchema.safeParse(
      request.query.limit ?? 20
    );
    if (!parsedLimit.success) {
      response.status(400).json({
        error: "invalid_history_limit",
        message: "账号历史数量参数无效"
      });
      return;
    }
    const history = repository.getListingHistory(
      request.params.key,
      parsedLimit.data
    );
    if (!history) {
      response.status(404).json({
        error: "listing_history_not_found",
        message: "账号不存在或尚无可信历史"
      });
      return;
    }
    response.json(history);
  });

  app.get("/api/listings/:key", (request, response) => {
    const listing = repository.getReviewedListing(request.params.key);
    if (!listing) {
      response.status(404).json({
        error: "listing_not_found",
        message: "候选不存在或已下架"
      });
      return;
    }
    response.json(listing);
  });

  app.get("/api/refresh-status", (_request, response) => {
    tracker.synchronize(repository.getRefreshSnapshot());
    response.json(tracker.snapshot());
  });

  app.get("/api/scan-history", (request, response) => {
    const parsedLimit = HistoryLimitSchema.safeParse(
      request.query.limit ?? 10
    );
    if (!parsedLimit.success) {
      response.status(400).json({
        error: "invalid_history_limit",
        message: "扫描历史数量参数无效"
      });
      return;
    }
    response.json({
      runs: repository.getScanHistory(parsedLimit.data)
    });
  });

  app.get("/api/refresh-schedule", (_request, response) => {
    response.json({ schedules: scheduler?.snapshot() ?? [] });
  });

  app.get("/api/refresh-events", (request, response) => {
    const parsedLimit = RefreshEventLimitSchema.safeParse(
      request.query.limit ?? 30
    );
    if (!parsedLimit.success) {
      response.status(400).json({
        error: "invalid_refresh_event_limit",
        message: "刷新提醒数量参数无效"
      });
      return;
    }
    const onlyUnacknowledged = request.query.unread === "true";
    response.json({
      events: repository.getRefreshEvents(
        parsedLimit.data,
        onlyUnacknowledged
      )
    });
  });

  app.post("/api/refresh-events/acknowledge", (request, response) => {
    const parsed = AcknowledgeRefreshEventsSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: "invalid_refresh_event_acknowledgement",
        message: "刷新提醒确认参数无效"
      });
      return;
    }
    response.json({
      acknowledged: repository.acknowledgeRefreshEvents(parsed.data.ids)
    });
  });

  app.post("/api/refresh/source/:source", (request, response) => {
    const parsedSource = SourceIdSchema.safeParse(request.params.source);
    const parsedBody = RefreshRequestSchema.safeParse(request.body);
    if (!parsedSource.success || !parsedBody.success || !scheduler) {
      response.status(400).json({
        error: "invalid_scheduled_refresh",
        message: "单平台刷新参数无效"
      });
      return;
    }
    let result: RefreshTriggerResult;
    try {
      result = scheduler.trigger(parsedSource.data, parsedBody.data.mode);
    } catch {
      response.status(500).json({
        error: "refresh_failed",
        message: "单平台刷新启动失败"
      });
      return;
    }
    if (result.kind === "conflict") {
      response.status(409).json({
        error: "refresh_conflict",
        message: "另一个刷新任务正在进行",
        activeKind: result.activeKind,
        ...(result.jobId ? { jobId: result.jobId } : {})
      });
      return;
    }
    if (result.kind === "queued") {
      response.status(202).json(result);
      return;
    }
    response.status(202).json({
      runId: result.runId,
      state: "running",
      source: result.source,
      mode: result.mode
    });
  });

  app.post("/api/refresh", (request, response) => {
    const parsedRefresh = RefreshRequestSchema.safeParse(
      request.body ?? {}
    );
    if (!parsedRefresh.success) {
      response.status(400).json({
        error: "invalid_refresh_mode",
        message: "刷新模式无效"
      });
      return;
    }
    const startedAt = new Date();
    let acquired;
    try {
      acquired = admission.withAllSourcesLease(() => {
        const runId = repository.startScan(startedAt);
        tracker.start(runId, startedAt);
        return runId;
      });
    } catch {
      response.status(500).json({
        error: "refresh_failed",
        message: "刷新失败，请查看来源状态后重试"
      });
      return;
    }
    if (acquired.kind === "conflict") {
      response.status(409).json({
        error: "refresh_conflict",
        message: "另一个刷新任务正在进行",
        activeKind: acquired.activeKind,
        ...(acquired.jobId ? { jobId: acquired.jobId } : {})
      });
      return;
    }
    const runId = acquired.value;

    const runRefresh = async (): Promise<void> => {
      try {
        const state = await coordinator.refreshAll(
          runId,
          (event) => tracker.update(runId, event),
          parsedRefresh.data.mode
        );
        tracker.finish(runId, state, new Date());
      } catch {
        const finishedAt = new Date();
        try {
          repository.failScan(runId, "刷新失败", finishedAt);
        } catch {
          // The in-memory tracker must still reach a terminal state.
        }
        tracker.finish(
          runId,
          "failed",
          finishedAt,
          "刷新失败"
        );
      } finally {
        acquired.lease.release();
      }
    };
    void runRefresh().catch(() => {
      // The detached refresh must never create an unhandled rejection.
    });

    response.status(202).json({
      runId,
      state: "running"
    });
  });

  const jsonErrorHandler: ErrorRequestHandler = (
    error,
    request,
    response,
    next
  ) => {
    const type = (
      typeof error === "object" &&
      error !== null &&
      "type" in error
    )
      ? String(error.type)
      : "";
    const browserPath = isBrowserRefreshPath(request.originalUrl);
    if (type === "entity.too.large") {
      response.status(413).json(
        browserPath
          ? {
              error: "browser_payload_too_large",
              message: "浏览器刷新请求超过 128 KiB 限制"
            }
          : {
              error: "payload_too_large",
              message: "请求体超过 256 KiB 限制"
            }
      );
      return;
    }
    if (browserPath) {
      const unsupportedEncoding =
        type === "encoding.unsupported" ||
        (
          typeof error === "object" &&
          error !== null &&
          "status" in error &&
          error.status === 415
        );
      response.status(unsupportedEncoding ? 415 : 400).json({
        error: "invalid_browser_payload",
        message: unsupportedEncoding
          ? "浏览器刷新请求编码不受支持"
          : "浏览器刷新请求格式无效"
      });
      return;
    }
    if (type === "entity.parse.failed") {
      response.status(400).json({
        error: "invalid_json",
        message: "请求 JSON 格式无效"
      });
      return;
    }
    next(error);
  };
  app.use(jsonErrorHandler);

  return app;
}
