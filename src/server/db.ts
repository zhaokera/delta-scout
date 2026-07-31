import { DatabaseSync } from "node:sqlite";
import { listingMaterialHash } from "../domain/listingFingerprint.js";
import { parseStoredListing } from "./storedListing.js";

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

    CREATE TABLE IF NOT EXISTS manual_listing_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_key TEXT NOT NULL,
      source TEXT NOT NULL
        CHECK(source IN ('jiaoyimao', 'panzhi', 'pxb7')),
      action TEXT NOT NULL
        CHECK(action IN ('exclude', 'restore')),
      reason_code TEXT
        CHECK(reason_code IS NULL OR reason_code IN (
          'price_overvalued',
          'm7_low_value',
          'red_skins_mismatch',
          'safety_risk',
          'assets_low',
          'seller_concern',
          'other'
        )),
      note TEXT,
      created_at TEXT NOT NULL,
      CHECK(
        (action = 'exclude' AND reason_code IS NOT NULL)
        OR
        (action = 'restore' AND reason_code IS NULL AND note IS NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS manual_listing_reviews_latest_idx
      ON manual_listing_reviews (listing_key, id DESC);

    CREATE TABLE IF NOT EXISTS source_status (
      source TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      last_attempt_at TEXT,
      last_success_at TEXT,
      item_count INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS scan_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      state TEXT NOT NULL
        CHECK(state IN ('running', 'success', 'partial', 'failed')),
      error TEXT,
      is_baseline INTEGER NOT NULL DEFAULT 0
        CHECK(is_baseline IN (0, 1)),
      scope TEXT NOT NULL DEFAULT 'all_sources'
        CHECK(scope IN ('all_sources', 'single_source')),
      requested_source TEXT
        CHECK(requested_source IS NULL OR requested_source IN (
          'jiaoyimao', 'panzhi', 'pxb7'
        ))
    );

    CREATE TABLE IF NOT EXISTS scan_source_results (
      run_id INTEGER NOT NULL,
      source TEXT NOT NULL
        CHECK(source IN ('jiaoyimao', 'panzhi', 'pxb7')),
      state TEXT NOT NULL
        CHECK(state IN ('success', 'partial', 'blocked', 'failed')),
      pages_scanned INTEGER NOT NULL CHECK(pages_scanned >= 0),
      observed_item_count INTEGER NOT NULL
        CHECK(observed_item_count >= 0),
      eligible_count INTEGER NOT NULL CHECK(eligible_count >= 0),
      balanced_candidate_count INTEGER NOT NULL
        CHECK(balanced_candidate_count >= 0),
      global_candidate_count INTEGER NOT NULL
        CHECK(global_candidate_count >= 0),
      anomaly_state TEXT NOT NULL DEFAULT 'none',
      published INTEGER NOT NULL DEFAULT 1
        CHECK(published IN (0, 1)),
      stop_reason TEXT,
      error TEXT,
      PRIMARY KEY (run_id, source),
      FOREIGN KEY (run_id) REFERENCES scan_runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS listing_observations (
      run_id INTEGER NOT NULL,
      listing_key TEXT NOT NULL,
      source TEXT NOT NULL
        CHECK(source IN ('jiaoyimao', 'panzhi', 'pxb7')),
      observed_at TEXT NOT NULL,
      eligibility TEXT NOT NULL
        CHECK(eligibility IN (
          'eligible', 'needs_verification', 'rejected'
        )),
      material_hash TEXT NOT NULL,
      stability TEXT NOT NULL
        CHECK(stability IN ('unknown', 'new', 'changed', 'stable')),
      consecutive_unchanged_scans INTEGER NOT NULL
        CHECK(consecutive_unchanged_scans >= 0),
      snapshot_json TEXT,
      changes_json TEXT NOT NULL DEFAULT '[]',
      availability TEXT NOT NULL DEFAULT 'active'
        CHECK(availability IN ('active', 'removed')),
      trusted INTEGER NOT NULL DEFAULT 0
        CHECK(trusted IN (0, 1)),
      PRIMARY KEY (run_id, listing_key),
      FOREIGN KEY (run_id) REFERENCES scan_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS listing_observations_listing_run_idx
      ON listing_observations (listing_key, run_id DESC);
    CREATE INDEX IF NOT EXISTS listing_observations_source_run_idx
      ON listing_observations (source, run_id DESC);

    CREATE TABLE IF NOT EXISTS source_anomaly_guards (
      source TEXT PRIMARY KEY
        CHECK(source IN ('jiaoyimao', 'panzhi', 'pxb7')),
      state TEXT NOT NULL DEFAULT 'clear'
        CHECK(state IN ('clear', 'suspect')),
      baseline_item_count INTEGER,
      baseline_pages_scanned INTEGER,
      observed_item_count INTEGER,
      observed_pages_scanned INTEGER,
      confirmation_count INTEGER NOT NULL DEFAULT 0,
      first_detected_at TEXT,
      last_detected_at TEXT,
      reason TEXT
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

  const resultColumns = new Set(
    (
      database.prepare("PRAGMA table_info(scan_source_results)").all() as {
        name: string;
      }[]
    ).map(({ name }) => name)
  );
  if (!resultColumns.has("anomaly_state")) {
    database.exec(
      "ALTER TABLE scan_source_results ADD COLUMN anomaly_state TEXT NOT NULL DEFAULT 'none'"
    );
  }
  if (!resultColumns.has("published")) {
    database.exec(
      "ALTER TABLE scan_source_results ADD COLUMN published INTEGER NOT NULL DEFAULT 1"
    );
  }

  const scanRunColumns = new Set(
    (
      database.prepare("PRAGMA table_info(scan_runs)").all() as {
        name: string;
      }[]
    ).map(({ name }) => name)
  );
  if (!scanRunColumns.has("scope")) {
    database.exec(
      "ALTER TABLE scan_runs ADD COLUMN scope TEXT NOT NULL DEFAULT 'all_sources'"
    );
  }
  if (!scanRunColumns.has("requested_source")) {
    database.exec(
      "ALTER TABLE scan_runs ADD COLUMN requested_source TEXT"
    );
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS browser_refresh_jobs (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'jiaoyimao'
        CHECK(source = 'jiaoyimao'),
      state TEXT NOT NULL
        CHECK(state IN (
          'awaiting_codex', 'collecting_list', 'collecting_details',
          'awaiting_user_verification', 'cooling_down', 'validating',
          'committing', 'success', 'quarantined', 'paused', 'failed',
          'cancelled', 'expired'
        )),
      stage TEXT NOT NULL,
      reason TEXT,
      claim_code_hash TEXT,
      bridge_token_hash TEXT,
      claimed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT,
      expires_at TEXT NOT NULL,
      list_batch_cursor INTEGER NOT NULL DEFAULT 0
        CHECK(list_batch_cursor >= 0),
      detail_completed_count INTEGER NOT NULL DEFAULT 0
        CHECK(detail_completed_count >= 0),
      detail_required_count INTEGER NOT NULL DEFAULT 0
        CHECK(detail_required_count >= 0),
      unique_item_count INTEGER NOT NULL DEFAULT 0
        CHECK(unique_item_count >= 0),
      item_count INTEGER NOT NULL DEFAULT 0
        CHECK(item_count >= 0),
      load_action_count INTEGER NOT NULL DEFAULT 0
        CHECK(load_action_count >= 0),
      cooldown_attempt INTEGER NOT NULL DEFAULT 0
        CHECK(cooldown_attempt >= 0),
      cooldown_until TEXT,
      next_action_at TEXT,
      action_permit_hash TEXT,
      action_permit_expires_at TEXT,
      action_permit_consumed_at TEXT,
      filter_url TEXT,
      last_error TEXT,
      scan_run_id INTEGER,
      published_run_id INTEGER,
      CHECK(
        detail_completed_count <= detail_required_count
        OR detail_required_count = 0
      ),
      CHECK(
        published_run_id IS NULL
        OR published_run_id = scan_run_id
      ),
      FOREIGN KEY (scan_run_id)
        REFERENCES scan_runs(id) ON DELETE CASCADE,
      FOREIGN KEY (published_run_id)
        REFERENCES scan_runs(id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS
      browser_refresh_one_active_jiaoyimao
      ON browser_refresh_jobs (source)
      WHERE state NOT IN (
        'success', 'quarantined', 'failed', 'cancelled', 'expired'
      );
    CREATE INDEX IF NOT EXISTS browser_refresh_jobs_state_idx
      ON browser_refresh_jobs (state, updated_at);
    CREATE INDEX IF NOT EXISTS browser_refresh_jobs_scan_run_idx
      ON browser_refresh_jobs (scan_run_id);

    CREATE TABLE IF NOT EXISTS browser_refresh_filter_proofs (
      job_id TEXT PRIMARY KEY,
      current_url TEXT NOT NULL,
      game_label TEXT NOT NULL,
      platform_label TEXT NOT NULL,
      category_label TEXT NOT NULL,
      m7_filter_labels_json TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      FOREIGN KEY (job_id)
        REFERENCES browser_refresh_jobs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS browser_refresh_load_events (
      job_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK(sequence > 0),
      payload_hash TEXT NOT NULL,
      accepted_result_json TEXT NOT NULL,
      observed_unique_count INTEGER NOT NULL
        CHECK(observed_unique_count >= 0),
      new_item_count INTEGER NOT NULL CHECK(new_item_count >= 0),
      visible_total_count INTEGER
        CHECK(visible_total_count IS NULL OR visible_total_count >= 0),
      end_marker_visible INTEGER NOT NULL
        CHECK(end_marker_visible IN (0, 1)),
      loading_visible INTEGER NOT NULL
        CHECK(loading_visible IN (0, 1)),
      blocking_state TEXT NOT NULL
        CHECK(blocking_state IN (
          'none', 'login', 'captcha', 'rate_limited', 'error'
        )),
      observed_at TEXT NOT NULL,
      PRIMARY KEY (job_id, sequence),
      FOREIGN KEY (job_id)
        REFERENCES browser_refresh_jobs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS browser_refresh_list_items (
      job_id TEXT NOT NULL,
      source_listing_id TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      raw_text TEXT NOT NULL,
      price_cny REAL CHECK(price_cny IS NULL OR price_cny >= 0),
      last_batch_sequence INTEGER NOT NULL
        CHECK(last_batch_sequence > 0),
      observed_at TEXT NOT NULL,
      PRIMARY KEY (job_id, source_listing_id),
      FOREIGN KEY (job_id)
        REFERENCES browser_refresh_jobs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS browser_refresh_details (
      job_id TEXT NOT NULL,
      source_listing_id TEXT NOT NULL,
      url TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      PRIMARY KEY (job_id, source_listing_id),
      FOREIGN KEY (job_id, source_listing_id)
        REFERENCES browser_refresh_list_items(job_id, source_listing_id)
        ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS browser_refresh_batches (
      job_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('list', 'detail')),
      sequence INTEGER NOT NULL CHECK(sequence > 0),
      payload_hash TEXT NOT NULL,
      accepted_count INTEGER NOT NULL CHECK(accepted_count >= 0),
      accepted_result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (job_id, kind, sequence),
      FOREIGN KEY (job_id)
        REFERENCES browser_refresh_jobs(id) ON DELETE CASCADE
    );

    CREATE TRIGGER IF NOT EXISTS
      browser_refresh_jobs_terminal_link_insert
      BEFORE INSERT ON browser_refresh_jobs
      WHEN (
        NEW.state = 'success'
        AND (
          NEW.scan_run_id IS NULL
          OR NEW.published_run_id IS NULL
          OR NEW.published_run_id <> NEW.scan_run_id
        )
      ) OR (
        NEW.state = 'quarantined'
        AND (
          NEW.scan_run_id IS NULL
          OR NEW.published_run_id IS NOT NULL
        )
      ) OR (
        NEW.state <> 'success'
        AND NEW.published_run_id IS NOT NULL
      )
      BEGIN
        SELECT RAISE(
          ABORT,
          'invalid browser refresh run linkage'
        );
      END;

    CREATE TRIGGER IF NOT EXISTS
      browser_refresh_jobs_terminal_link_update
      BEFORE UPDATE OF state, scan_run_id, published_run_id
      ON browser_refresh_jobs
      WHEN (
        NEW.state = 'success'
        AND (
          NEW.scan_run_id IS NULL
          OR NEW.published_run_id IS NULL
          OR NEW.published_run_id <> NEW.scan_run_id
        )
      ) OR (
        NEW.state = 'quarantined'
        AND (
          NEW.scan_run_id IS NULL
          OR NEW.published_run_id IS NOT NULL
        )
      ) OR (
        NEW.state <> 'success'
        AND NEW.published_run_id IS NOT NULL
      )
      BEGIN
        SELECT RAISE(
          ABORT,
          'invalid browser refresh run linkage'
        );
      END;
  `);

  const loadEventColumns = new Set(
    (
      database
        .prepare("PRAGMA table_info(browser_refresh_load_events)")
        .all() as { name: string }[]
    ).map(({ name }) => name)
  );
  if (!loadEventColumns.has("accepted_result_json")) {
    database.exec(
      "ALTER TABLE browser_refresh_load_events ADD COLUMN accepted_result_json TEXT"
    );
  }

  const observationColumns = new Set(
    (
      database.prepare("PRAGMA table_info(listing_observations)").all() as {
        name: string;
      }[]
    ).map(({ name }) => name)
  );
  if (!observationColumns.has("snapshot_json")) {
    database.exec(
      "ALTER TABLE listing_observations ADD COLUMN snapshot_json TEXT"
    );
  }
  if (!observationColumns.has("changes_json")) {
    database.exec(
      "ALTER TABLE listing_observations ADD COLUMN changes_json TEXT NOT NULL DEFAULT '[]'"
    );
  }
  if (!observationColumns.has("availability")) {
    database.exec(
      "ALTER TABLE listing_observations ADD COLUMN availability TEXT NOT NULL DEFAULT 'active'"
    );
  }
  if (!observationColumns.has("trusted")) {
    database.exec(
      "ALTER TABLE listing_observations ADD COLUMN trusted INTEGER NOT NULL DEFAULT 0"
    );
  }

  const seed = database.prepare(`
    INSERT INTO source_status (source, state, item_count)
    VALUES (?, 'idle', 0)
    ON CONFLICT(source) DO NOTHING
  `);
  for (const source of ["jiaoyimao", "panzhi", "pxb7"]) {
    seed.run(source);
  }
  const seedGuard = database.prepare(`
    INSERT INTO source_anomaly_guards (source, state)
    VALUES (?, 'clear')
    ON CONFLICT(source) DO NOTHING
  `);
  for (const source of ["jiaoyimao", "panzhi", "pxb7"]) {
    seedGuard.run(source);
  }

  try {
    database.exec("BEGIN IMMEDIATE");
    database
      .prepare(`
        UPDATE scan_runs
        SET state = 'failed',
            finished_at = COALESCE(finished_at, ?),
            error = '进程中断'
        WHERE state = 'running'
      `)
      .run(new Date().toISOString());

    const runCount = database
      .prepare("SELECT COUNT(*) AS count FROM scan_runs")
      .get() as { count: number };
    if (runCount.count === 0) {
      const legacyRows = database
        .prepare(`
          SELECT l.payload, s.source, s.last_success_at,
                 s.pages_scanned, s.stop_reason, s.error
          FROM listings l
          JOIN source_status s ON s.source = l.source
          WHERE s.state = 'success'
          ORDER BY l.listing_key
        `)
        .all() as unknown as Array<{
          payload: string;
          source: "jiaoyimao" | "panzhi" | "pxb7";
          last_success_at: string | null;
          pages_scanned: number;
          stop_reason: string | null;
          error: string | null;
        }>;
      if (legacyRows.length > 0) {
        const timestamps = legacyRows
          .map(({ last_success_at }) => last_success_at)
          .filter((value): value is string => value !== null)
          .sort();
        const timestamp =
          timestamps.at(-1) ?? new Date().toISOString();
        const run = database
          .prepare(`
            INSERT INTO scan_runs (
              started_at, finished_at, state, error, is_baseline
            ) VALUES (?, ?, 'success', NULL, 1)
          `)
          .run(timestamp, timestamp);
        const runId = Number(run.lastInsertRowid);
        const listings = legacyRows.map((row) => ({
          row,
          listing: parseStoredListing(row.payload)
        }));
        const insertSource = database.prepare(`
          INSERT INTO scan_source_results (
            run_id, source, state, pages_scanned,
            observed_item_count, eligible_count,
            balanced_candidate_count, global_candidate_count,
            stop_reason, error
          ) VALUES (?, ?, 'success', ?, ?, ?, 0, 0, ?, ?)
        `);
        for (const source of ["jiaoyimao", "panzhi", "pxb7"] as const) {
          const sourceListings = listings.filter(
            ({ listing }) => listing.source === source
          );
          if (sourceListings.length === 0) continue;
          const metadata = sourceListings[0].row;
          insertSource.run(
            runId,
            source,
            metadata.pages_scanned,
            sourceListings.length,
            sourceListings.filter(
              ({ listing }) => listing.eligibility === "eligible"
            ).length,
            metadata.stop_reason,
            metadata.error
          );
        }
        const insertObservation = database.prepare(`
          INSERT INTO listing_observations (
            run_id, listing_key, source, observed_at, eligibility,
            material_hash, stability, consecutive_unchanged_scans
          ) VALUES (?, ?, ?, ?, ?, ?, 'unknown', 1)
        `);
        for (const { listing } of listings) {
          insertObservation.run(
            runId,
            listing.key,
            listing.source,
            timestamp,
            listing.eligibility,
            listingMaterialHash(listing)
          );
        }
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the migration failure.
    }
    database.close();
    throw error;
  }

  return database;
}
