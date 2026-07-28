import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createApp } from "./app.js";
import { CollectionCoordinator } from "./collector/coordinator.js";
import { PublicPageFetcher } from "./collector/fetcher.js";
import { sourceAdapters } from "./collector/sources.js";
import { createDatabase } from "./db.js";
import { ListingRepository } from "./repository.js";

const port = Number.parseInt(process.env.PORT ?? "4310", 10);
const host = "127.0.0.1";
const databasePath = resolve(
  process.env.SCOUT_DATABASE_PATH ?? "data/scout.sqlite"
);
mkdirSync(dirname(databasePath), { recursive: true });
const repository = new ListingRepository(createDatabase(databasePath));
const coordinator = new CollectionCoordinator({
  adapters: sourceAdapters,
  fetcher: new PublicPageFetcher(),
  repository
});

createApp({ repository, coordinator }).listen(port, host, () => {
  console.log(`Delta Account Scout API listening on http://${host}:${port}`);
});
