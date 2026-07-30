import express, {
  type ErrorRequestHandler,
  type Express,
  type RequestHandler,
  type Response
} from "express";
import { z, ZodError } from "zod";
import {
  selectBalancedCandidatePool,
  selectGlobalCandidatePool
} from "../domain/candidatePool.js";
import {
  EligibilitySchema,
  type Listing,
  type SourceId
} from "../domain/listing.js";
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
import type {
  ListingRepository,
  ScanState,
  SourceStatus
} from "./repository.js";
import type {
  RefreshProgressEvent
} from "./collector/coordinator.js";
import {
  RefreshAdmissionController
} from "./refreshAdmission.js";
import type { RefreshTracker } from "./refreshTracker.js";

interface RefreshCoordinator {
  refreshAll(
    runId: number,
    onProgress?: (event: RefreshProgressEvent) => void
  ): Promise<ScanState>;
}

interface AppDependencies {
  repository: ListingRepository;
  coordinator: RefreshCoordinator;
  tracker: RefreshTracker;
  admission: RefreshAdmissionController;
  browserRepository: BrowserRefreshRepository;
  browserService: JiaoyimaoBrowserTaskService;
}

const ListingViewSchema = z.enum(["pool", "all"]);
const PoolModeSchema = z.enum(["balanced", "global"]);
const HistoryLimitSchema = z.coerce.number().int().min(1).max(50);
const EmptyBodySchema = z.strictObject({});
const ClaimBodySchema = z.strictObject({
  claimCode: z.string().min(1)
    .max(BROWSER_REFRESH_LIMITS.maxClaimCodeChars)
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

function readBearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const match = authorization.match(/^Bearer ([A-Za-z0-9_-]{16,256})$/);
  return match?.[1] ?? null;
}

const BROWSER_REFRESH_PATH_PREFIXES = [
  "/api/browser-refresh",
  "/api/sources/jiaoyimao/browser-refresh"
] as const;

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

const decodeBrowserJson: RequestHandler = (
  request,
  response,
  next
) => {
  if (request.method === "GET" || request.method === "HEAD") {
    next();
    return;
  }
  if (!hasJsonContentType(request.get("content-type"))) {
    response.status(400).json({
      error: "invalid_browser_payload",
      message: "浏览器刷新请求必须使用 application/json"
    });
    return;
  }
  if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
    response.status(400).json({
      error: "invalid_browser_payload",
      message: "浏览器刷新请求格式无效"
    });
    return;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true })
      .decode(request.body);
    request.body = JSON.parse(text);
    next();
  } catch {
    response.status(400).json({
      error: "invalid_browser_payload",
      message: "浏览器刷新请求格式无效"
    });
  }
};

interface CurrentListingSnapshot {
  statuses: SourceStatus[];
  listings: Listing[];
  activeEligibleListings: Listing[];
  balancedPool: Listing[];
  globalPool: Listing[];
}

function readCurrentListingSnapshot(
  repository: ListingRepository
): CurrentListingSnapshot {
  const statuses = repository.getSourceStatuses();
  const listings = repository.getListings();
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
      listing.eligibility === "eligible"
  );

  return {
    statuses,
    listings,
    activeEligibleListings,
    balancedPool: selectBalancedCandidatePool(activeEligibleListings),
    globalPool: selectGlobalCandidatePool(activeEligibleListings)
  };
}

function candidatePool(
  snapshot: CurrentListingSnapshot,
  mode: PoolMode
): Listing[] {
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

  const browserBody = express.raw({
    limit: BROWSER_REFRESH_LIMITS.maxBatchUtf8Bytes,
    type: () => true
  });
  for (const prefix of BROWSER_REFRESH_PATH_PREFIXES) {
    app.use(prefix, browserBody, decodeBrowserJson);
  }
  app.use(express.json({ limit: "256kb" }));
  app.get("/api/health", (_request, response) => {
    response.json({
      ok: true,
      service: "delta-account-scout"
    });
  });

  if (!dependencies) return app;

  const {
    repository,
    coordinator,
    tracker,
    admission,
    browserRepository,
    browserService
  } = dependencies;

  const bridgeToken = (
    authorization: string | undefined,
    response: Response
  ): string | null => {
    const token = readBearerToken(authorization);
    if (token !== null) return token;
    response.status(401).json({
      error: "bridge_unauthorized",
      message: BROWSER_ERROR_MESSAGES.bridge_unauthorized
    });
    return null;
  };

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
        response.json(browserRepository.getCurrentJob());
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
    const token = bridgeToken(request.get("authorization"), response);
    if (token === null) return;
    try {
      response.json(browserService.getWork(request.params.id, token));
    } catch (error) {
      sendBrowserError(response, error, true);
    }
  });

  app.post(
    "/api/browser-refresh/:id/filter-proof",
    (request, response) => {
      const token = bridgeToken(request.get("authorization"), response);
      if (token === null) return;
      try {
        const body = BrowserFilterProofSchema.parse(request.body);
        response.json(
          browserService.saveFilterProof(
            request.params.id,
            token,
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
      const token = bridgeToken(request.get("authorization"), response);
      if (token === null) return;
      try {
        const body = BrowserListBatchSchema.parse(request.body);
        response.json(
          browserService.submitListBatch(
            request.params.id,
            token,
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
      const token = bridgeToken(request.get("authorization"), response);
      if (token === null) return;
      try {
        const body = BrowserLoadEventSchema.parse(request.body);
        response.json(
          browserService.submitLoadEvent(
            request.params.id,
            token,
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
      const token = bridgeToken(request.get("authorization"), response);
      if (token === null) return;
      try {
        const body = BrowserDetailBatchSchema.parse(request.body);
        response.json(
          browserService.submitDetails(
            request.params.id,
            token,
            body
          )
        );
      } catch (error) {
        sendBrowserError(response, error, true);
      }
    }
  );

  app.post("/api/browser-refresh/:id/pause", (request, response) => {
    const token = bridgeToken(request.get("authorization"), response);
    if (token === null) return;
    try {
      const body = BrowserPauseSchema.parse(request.body);
      response.json(
        browserService.pause(request.params.id, token, body)
      );
    } catch (error) {
      sendBrowserError(response, error, true);
    }
  });

  app.post("/api/browser-refresh/:id/resume", (request, response) => {
    const token = bridgeToken(request.get("authorization"), response);
    if (token === null) return;
    try {
      EmptyBodySchema.parse(request.body);
      response.json(browserService.resume(request.params.id, token));
    } catch (error) {
      sendBrowserError(response, error, true);
    }
  });

  app.post(
    "/api/browser-refresh/:id/cooldown",
    (request, response) => {
      const token = bridgeToken(request.get("authorization"), response);
      if (token === null) return;
      try {
        BrowserCooldownSchema.parse(request.body);
        response.json(
          browserService.startCooldown(request.params.id, token)
        );
      } catch (error) {
        sendBrowserError(response, error, true);
      }
    }
  );

  app.post("/api/browser-refresh/:id/complete", (request, response) => {
    const token = bridgeToken(request.get("authorization"), response);
    if (token === null) return;
    try {
      EmptyBodySchema.parse(request.body);
      response.json(browserService.complete(request.params.id, token));
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
    const listings = snapshot.listings.filter(
      (listing) => listing.eligibility === status
    );
    response.json(
      view === "pool"
        ? candidatePool(snapshot, mode)
        : listings.sort(compareRecommendations)
    );
  });

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
    const listing = repository.getListing(request.params.key);
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

  app.post("/api/refresh", (_request, response) => {
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
          (event) => tracker.update(runId, event)
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
    if (type === "entity.parse.failed") {
      response.status(400).json(
        browserPath
          ? {
              error: "invalid_browser_payload",
              message: "浏览器刷新请求格式无效"
            }
          : {
              error: "invalid_json",
              message: "请求 JSON 格式无效"
            }
      );
      return;
    }
    next(error);
  };
  app.use(jsonErrorHandler);

  return app;
}
