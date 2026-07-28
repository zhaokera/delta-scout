import express, { type Express } from "express";
import {
  EligibilitySchema,
  type Listing
} from "../domain/listing.js";
import type { ListingRepository } from "./repository.js";

interface RefreshCoordinator {
  refreshAll(): Promise<void>;
}

interface AppDependencies {
  repository: ListingRepository;
  coordinator: RefreshCoordinator;
}

function byRecommendation(left: Listing, right: Listing): number {
  const scoreDifference =
    (right.score?.total ?? -1) - (left.score?.total ?? -1);
  if (scoreDifference !== 0) return scoreDifference;
  if (right.confidence !== left.confidence) {
    return right.confidence - left.confidence;
  }
  return (left.priceCny ?? Infinity) - (right.priceCny ?? Infinity);
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
    response.json(repository.getSourceStatuses());
  });

  app.get("/api/listings", (request, response) => {
    const rawStatus = request.query.status;
    if (
      rawStatus !== undefined &&
      (typeof rawStatus !== "string" ||
        !EligibilitySchema.safeParse(rawStatus).success)
    ) {
      response.status(400).json({
        error: "invalid_status",
        message: "status 参数无效"
      });
      return;
    }
    const status =
      typeof rawStatus === "string"
        ? EligibilitySchema.parse(rawStatus)
        : undefined;
    response.json(repository.getListings(status).sort(byRecommendation));
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
      response.json({
        ok: true,
        sources: repository.getSourceStatuses()
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
