import { DatabaseSync } from "node:sqlite";

export function createDatabase(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS listings (
      listing_key TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      eligibility TEXT NOT NULL,
      payload TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS listings_source_idx
      ON listings (source);
    CREATE INDEX IF NOT EXISTS listings_eligibility_idx
      ON listings (eligibility);

    CREATE TABLE IF NOT EXISTS source_status (
      source TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      last_attempt_at TEXT,
      last_success_at TEXT,
      item_count INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );
  `);

  const columns = new Set(
    (
      database.prepare("PRAGMA table_info(source_status)").all() as {
        name: string;
      }[]
    ).map(({ name }) => name)
  );
  if (!columns.has("pages_scanned")) {
    database.exec(
      "ALTER TABLE source_status ADD COLUMN pages_scanned INTEGER NOT NULL DEFAULT 0"
    );
  }
  if (!columns.has("stop_reason")) {
    database.exec("ALTER TABLE source_status ADD COLUMN stop_reason TEXT");
  }

  const seed = database.prepare(`
    INSERT INTO source_status (source, state, item_count)
    VALUES (?, 'idle', 0)
    ON CONFLICT(source) DO NOTHING
  `);
  for (const source of ["jiaoyimao", "panzhi", "pxb7"]) {
    seed.run(source);
  }

  return database;
}
