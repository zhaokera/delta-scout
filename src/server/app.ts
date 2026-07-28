import express, { type Express } from "express";
import { z } from "zod";
import { selectBalancedCandidatePool } from "../domain/candidatePool.js";
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

interface CurrentListingSnapshot {
  statuses: SourceStatus[];
  listings: Listing[];
  activeEligibleListings: Listing[];
  pool: Listing[];
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
    pool: selectBalancedCandidatePool(activeEligibleListings)
  };
}

function derivedSourceStatuses(snapshot: CurrentListingSnapshot) {
  const eligibleCounts = new Map<SourceId, number>();
  const candidateCounts = new Map<SourceId, number>();

  for (const listing of snapshot.activeEligibleListings) {
    if (listing.score !== null) {
      eligibleCounts.set(
        listing.source,
        (eligibleCounts.get(listing.source) ?? 0) + 1
      );
    }
  }
  for (const listing of snapshot.pool) {
    candidateCounts.set(
      listing.source,
      (candidateCounts.get(listing.source) ?? 0) + 1
    );
  }

  return snapshot.statuses.map((status) => ({
    ...status,
    eligibleCount: eligibleCounts.get(status.source) ?? 0,
    candidateCount: candidateCounts.get(status.source) ?? 0,
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

  app.get("/api/sources", (_request, response) => {
    response.json(
      derivedSourceStatuses(readCurrentListingSnapshot(repository))
    );
  });

  app.get("/api/listings", (request, response) => {
    const rawView = request.query.view;
    const rawStatus = request.query.status;
    const parsedView =
      rawView === undefined ? null : ListingViewSchema.safeParse(rawView);
    const parsedStatus =
      rawStatus === undefined ? null : EligibilitySchema.safeParse(rawStatus);
    if (
      (parsedView !== null && !parsedView.success) ||
      (parsedStatus !== null && !parsedStatus.success)
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
    if (view === "pool" && status !== "eligible") {
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
        ? snapshot.pool
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
        sources: derivedSourceStatuses(snapshot)
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
