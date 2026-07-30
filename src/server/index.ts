import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createApp } from "./app.js";
import {
  BrowserRefreshRepository
} from "./browserRefresh/repository.js";
import { CollectionCoordinator } from "./collector/coordinator.js";
import { PublicPageFetcher } from "./collector/fetcher.js";
import { sourceAdapters } from "./collector/sources.js";
import { createDatabase } from "./db.js";
import {
  RefreshAdmissionController
} from "./refreshAdmission.js";
import { ListingRepository } from "./repository.js";
import { RefreshTracker } from "./refreshTracker.js";

const port = Number.parseInt(process.env.PORT ?? "4310", 10);
const host = "127.0.0.1";
const databasePath = resolve(
  process.env.SCOUT_DATABASE_PATH ?? "data/scout.sqlite"
);
mkdirSync(dirname(databasePath), { recursive: true });
const database = createDatabase(databasePath);
const repository = new ListingRepository(database);
const browserRepository = new BrowserRefreshRepository(database);
const tracker = new RefreshTracker(repository.getRefreshSnapshot());
const admission = new RefreshAdmissionController({
  browserRepository,
  tracker
});
const coordinator = new CollectionCoordinator({
  adapters: sourceAdapters,
  fetcher: new PublicPageFetcher(),
  repository
});

createApp({
  repository,
  coordinator,
  tracker,
  admission
}).listen(port, host, () => {
  console.log(
    `Delta Account Scout API listening on http://${host}:${port}`
  );
});
