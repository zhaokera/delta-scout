import express, { type Express } from "express";
import { z } from "zod";
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
import type {
  ListingRepository,
  SourceStatus
} from "./repository.js";

interface RefreshCoordinator {
  refreshAll(): Promise<void>;
}

interface AppDependencies {
  repository: ListingRepository;
  coordinator: RefreshCoordinator;
}

const ListingViewSchema = z.enum(["pool", "all"]);
const PoolModeSchema = z.enum(["balanced", "global"]);
type PoolMode = z.infer<typeof PoolModeSchema>;

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

  app.use(express.json({ limit: "256kb" }));
  app.get("/api/health", (_request, response) => {
    response.json({
      ok: true,
      service: "delta-account-scout"
    });
  });

  if (!dependencies) return app;

  const { repository, coordinator } = dependencies;
  let refreshing = false;

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

  app.post("/api/refresh", async (_request, response) => {
    if (refreshing) {
      response.status(409).json({
        error: "refresh_in_progress",
        message: "刷新任务正在进行"
      });
      return;
    }
    refreshing = true;
    try {
      await coordinator.refreshAll();
      const snapshot = readCurrentListingSnapshot(repository);
      response.json({
        ok: true,
        sources: derivedSourceStatuses(snapshot, "balanced")
      });
    } catch {
      response.status(500).json({
        error: "refresh_failed",
        message: "刷新失败，请查看来源状态后重试"
      });
    } finally {
      refreshing = false;
    }
  });

  return app;
}
