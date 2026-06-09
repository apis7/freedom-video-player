//! Library SQLite handle, schema, migrations.
//!
//! The DB lives at `<app_local_data_dir>/library.db` (typically
//! `%LOCALAPPDATA%\Freedom Video Player\library.db` on Windows). WAL mode
//! is enabled for concurrent reader access (the indexer runs background
//! writes; the UI reads continuously).
//!
//! Schema is versioned via a single `schema_version` row. New migrations
//! are appended to `MIGRATIONS` — never re-numbered, never deleted.

use parking_lot::Mutex;
use rusqlite::{params, Connection};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// The single source of truth for the library schema. Each migration is a
/// pure additive SQL block — once written, never edited. Bumping the
/// schema = appending a new entry here.
const MIGRATIONS: &[&str] = &[
    // ── v1 — initial schema ─────────────────────────────────────────────
    r#"
    -- "Identity" = a unique piece of content (a movie). Curation lives
    -- here. Multiple files (true duplicates) can share an identity.
    CREATE TABLE library_identities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cheap_fingerprint TEXT NOT NULL UNIQUE,
        strong_fingerprint TEXT,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        -- TMDb metadata (refreshable)
        tmdb_id INTEGER,
        movie_title TEXT,
        movie_year INTEGER,
        movie_director TEXT,
        movie_plot TEXT,
        movie_stars_json TEXT,
        genres_json TEXT,
        mpaa_rating TEXT,
        imdb_id TEXT,
        imdb_rating REAL,
        poster_url TEXT,
        poster_local_path TEXT,
        -- Curation (sticky against auto-metadata refresh)
        custom_thumbnail_path TEXT,
        notes TEXT,
        family_rating INTEGER,
        non_family_friendly INTEGER NOT NULL DEFAULT 0,
        priority_for_profile INTEGER NOT NULL DEFAULT 0,
        no_profile_necessary INTEGER NOT NULL DEFAULT 0,
        -- Override flags: if true, auto-metadata leaves these fields alone
        manual_title INTEGER NOT NULL DEFAULT 0,
        manual_year INTEGER NOT NULL DEFAULT 0,
        manual_thumbnail INTEGER NOT NULL DEFAULT 0,
        manual_director INTEGER NOT NULL DEFAULT 0,
        manual_plot INTEGER NOT NULL DEFAULT 0,
        first_seen_at INTEGER NOT NULL,
        last_updated_at INTEGER NOT NULL
    );

    CREATE TABLE watched_folders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL UNIQUE,
        recursive INTEGER NOT NULL DEFAULT 1,
        added_at INTEGER NOT NULL
    );

    -- A "file" = a physical location on disk pointing to an identity.
    -- Physical attributes (size/resolution/codec) and watch history live
    -- here; curation lives on the identity.
    CREATE TABLE library_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL UNIQUE,
        watched_folder_id INTEGER NOT NULL REFERENCES watched_folders(id) ON DELETE CASCADE,
        identity_id INTEGER NOT NULL REFERENCES library_identities(id) ON DELETE CASCADE,
        size_bytes INTEGER NOT NULL,
        modified_unix INTEGER NOT NULL,
        resolution TEXT,
        codec TEXT,
        is_missing INTEGER NOT NULL DEFAULT 0,
        watch_progress_ms INTEGER NOT NULL DEFAULT 0,
        last_watched_at INTEGER,
        watched INTEGER NOT NULL DEFAULT 0,
        added_at INTEGER NOT NULL,
        -- True when an indexed file's fingerprint changes vs. what's on
        -- the linked identity — drives the Profile Drift Sentinel.
        drift_warning INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX idx_library_files_identity ON library_files(identity_id);
    CREATE INDEX idx_library_files_folder ON library_files(watched_folder_id);

    CREATE TABLE library_tags (
        identity_id INTEGER NOT NULL REFERENCES library_identities(id) ON DELETE CASCADE,
        tag TEXT NOT NULL,
        PRIMARY KEY (identity_id, tag)
    );

    CREATE TABLE library_collections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
    );

    CREATE TABLE library_collection_items (
        collection_id INTEGER NOT NULL REFERENCES library_collections(id) ON DELETE CASCADE,
        identity_id INTEGER NOT NULL REFERENCES library_identities(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        PRIMARY KEY (collection_id, identity_id)
    );

    CREATE TABLE library_series (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        has_seasons INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
    );

    CREATE TABLE library_series_items (
        series_id INTEGER NOT NULL REFERENCES library_series(id) ON DELETE CASCADE,
        identity_id INTEGER NOT NULL REFERENCES library_identities(id) ON DELETE CASCADE,
        season INTEGER,
        position INTEGER NOT NULL,
        PRIMARY KEY (series_id, identity_id)
    );

    CREATE TABLE library_watch_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES library_files(id) ON DELETE CASCADE,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        end_progress_ms INTEGER
    );

    CREATE INDEX idx_library_watch_log_file ON library_watch_log(file_id);

    -- Reconciliation rejections (don't-nag rule)
    CREATE TABLE library_dismissed_pairs (
        fingerprint_a TEXT NOT NULL,
        fingerprint_b TEXT NOT NULL,
        dismissed_at INTEGER NOT NULL,
        PRIMARY KEY (fingerprint_a, fingerprint_b)
    );

    -- Suggestion dismissals (don't re-suggest "next'd" for 7 days)
    CREATE TABLE library_suggestion_dismissals (
        identity_id INTEGER PRIMARY KEY REFERENCES library_identities(id) ON DELETE CASCADE,
        dismissed_at INTEGER NOT NULL
    );

    -- Key/value settings: PIN hash, family view enabled, clock format,
    -- column layout, default delete behavior, poster cache cap, etc.
    CREATE TABLE library_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    "#,
    // ── v2 — cache .free sibling presence on the file row ───────────────
    // Computing this at list-time by reading every parent dir on a
    // network drive cost ~10 ms per dir × hundreds of dirs = visible
    // freezes. Cache it on the file row, refresh during scans + on
    // explicit profile-save hooks. has_free_sibling values:
    //   NULL  = never computed (force a check on next access)
    //   0     = checked, no .free found
    //   1     = checked, .free present
    r#"
    ALTER TABLE library_files ADD COLUMN has_free_sibling INTEGER;
    "#,
    // ── v3 — per-folder Scan-on-Startup opt-in (default OFF) ────────────
    // Network shares can take 30+ s to enumerate, so we don't want to
    // gate the whole app on a startup scan for folders the user only
    // touches occasionally. When 0, the orchestrator skips this folder
    // during the boot ScanAll; the user can still trigger via Rescan or
    // the per-folder Rescan button in Settings. notify watcher stays
    // attached either way so on-disk changes still get picked up live.
    r#"
    ALTER TABLE watched_folders ADD COLUMN scan_on_startup INTEGER NOT NULL DEFAULT 0;
    "#,
    // ── v4 — MAPS rating ingestion + subtitle detection + reorder pos +
    //          watch_log event type, sortable group ordering ────────────────
    //
    // MAPS columns mirror the .free metadata's two MAPS ratings; cached
    // here on identity so the column view can sort/filter without
    // re-reading .free files per row. tier values match
    // src-tauri/src/profile/format.rs::MapsTier ("family", "teen",
    // "adult", "married_adult", "degrading"). NULL = no MAPS data
    // recorded yet (no .free or .free has no MAPS block).
    //
    // has_subtitle: 1 when a sibling .srt is present OR an embedded sub
    // track was detected. Maintained alongside has_free_sibling at scan.
    //
    // sort_position: stable ordering for the sidebar's Collections /
    // Series lists. Allows drag-reorder. NULL ordering falls back to
    // alphabetical, preserving the pre-v4 default.
    //
    // event_type: opened|watch_progress|watch_end — distinguishes the
    // "opened the file" log line from the periodic progress writes.
    r#"
    ALTER TABLE library_identities ADD COLUMN maps_filtered_tier TEXT;
    ALTER TABLE library_identities ADD COLUMN maps_filtered_summary TEXT;
    ALTER TABLE library_identities ADD COLUMN maps_unfiltered_tier TEXT;
    ALTER TABLE library_identities ADD COLUMN maps_unfiltered_summary TEXT;
    ALTER TABLE library_files ADD COLUMN has_subtitle INTEGER;
    ALTER TABLE library_collections ADD COLUMN sort_position INTEGER;
    ALTER TABLE library_series ADD COLUMN sort_position INTEGER;
    ALTER TABLE library_watch_log ADD COLUMN event_type TEXT NOT NULL DEFAULT 'progress';
    CREATE INDEX idx_library_watch_log_started ON library_watch_log(started_at);
    "#,
    // ── v5 — missing-since timestamp for PROBABLE temporal-correlation ────
    //
    // When the indexer marks a file is_missing=1, it also stamps
    // missing_since=now if it's currently NULL. Cleared when the file is
    // re-found (is_missing flips back to 0). The reconcile engine uses
    // this to compute the temporal-correlation signal: "did a known file
    // in this folder vanish recently? If yes, and this candidate
    // appeared during that window, that's an upgrade-in-place signature."
    r#"
    ALTER TABLE library_files ADD COLUMN missing_since INTEGER;
    "#,
    // ── v6 — snoozed pairs (24h cooldown on "Decide later") ───────────
    //
    // Distinct from library_dismissed_pairs (which is permanent).
    // snooze_until is a unix timestamp; find_probable_pairs filters
    // pairs whose snooze_until is in the future. Hitting "Decide later"
    // / X / Esc in the reconciliation dialog inserts a 24h snooze so
    // the user isn't re-pestered about the same pair the next time
    // they open the library.
    r#"
    CREATE TABLE library_snoozed_pairs (
        fingerprint_a TEXT NOT NULL,
        fingerprint_b TEXT NOT NULL,
        snooze_until INTEGER NOT NULL,
        PRIMARY KEY (fingerprint_a, fingerprint_b)
    );
    "#,
    // ── v7 — renormalize series/collection positions ──────────────────
    //
    // Earlier versions of library_add_to_series and
    // library_add_to_collection started new items at position = 1
    // (instead of 0) when the group was empty, so older series like
    // "Lord of the Rings" and "Johnny Quest" have positions starting
    // at 1. The display layer now ignores DB position in favor of
    // display-index for episode badges, so users no longer see "#2"
    // for the first item. But the DB itself is still wonky. This
    // migration renumbers each group's positions to be dense and
    // 0-based — preserves the existing relative order. Safe: no other
    // table references these position values directly.
    r#"
    UPDATE library_series_items
       SET position = (
           SELECT COUNT(*) FROM library_series_items s2
           WHERE s2.series_id = library_series_items.series_id
             AND ( s2.position < library_series_items.position
                OR (s2.position = library_series_items.position
                    AND s2.identity_id < library_series_items.identity_id) )
       );
    UPDATE library_collection_items
       SET position = (
           SELECT COUNT(*) FROM library_collection_items c2
           WHERE c2.collection_id = library_collection_items.collection_id
             AND ( c2.position < library_collection_items.position
                OR (c2.position = library_collection_items.position
                    AND c2.identity_id < library_collection_items.identity_id) )
       );
    "#,
    // ── v8 — manual override flags for genres + stars ─────────────────
    //
    // Earlier schema had manual_<field> flags for title/year/director/
    // plot/thumbnail only. To let the user manually edit Genres and
    // Cast in the details panel without auto-enrichment clobbering
    // them on next refresh, we need the same sticky flag for those
    // two array-typed fields too.
    r#"
    ALTER TABLE library_identities ADD COLUMN manual_genres INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE library_identities ADD COLUMN manual_stars INTEGER NOT NULL DEFAULT 0;
    "#,
    // ── v9 — 3D flag ──────────────────────────────────────────────────
    //
    // User-curated boolean. When set, the title is rendered with a
    // " (3D)" suffix; "Search 3D" is a filter option. Distinct from
    // any TMDb metadata — TMDb doesn't reliably track 3D releases.
    r#"
    ALTER TABLE library_identities ADD COLUMN is_3d INTEGER NOT NULL DEFAULT 0;
    "#,
    // ── v10 — Extended Edition flag ───────────────────────────────────
    //
    // Same pattern as is_3d but for Extended / Director's Cut / Final
    // Cut variants. The "Find possible duplicates" fuzzy matcher must
    // never pair an extended cut with the theatrical release, so this
    // flag is part of the equality contract.
    r#"
    ALTER TABLE library_identities ADD COLUMN is_extended INTEGER NOT NULL DEFAULT 0;
    "#,
    // ── v11 — Non-family-friendly flag on collections + series ─────────
    //
    // Collection / series-level NFF flag. When set, the whole group
    // hides in Family Mode (independent of its members). A group is
    // ALSO effectively hidden when EVERY member identity is flagged
    // non_family_friendly — that's computed at query time, not
    // stored, since it's a derived signal.
    r#"
    ALTER TABLE library_collections ADD COLUMN non_family_friendly INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE library_series ADD COLUMN non_family_friendly INTEGER NOT NULL DEFAULT 0;
    "#,
];

/// Thread-safe handle around a single `Connection`. SQLite's serialized
/// mode is on by default so a single connection is fine for our access
/// pattern; we keep it behind a Mutex to satisfy Rust's `Send + Sync`
/// requirements when shared across the Tauri command runtime.
#[derive(Clone)]
pub struct LibraryDb {
    inner: Arc<Mutex<Connection>>,
    path: PathBuf,
}

impl LibraryDb {
    /// Open (or create) the DB at the standard location and run any
    /// pending migrations. Safe to call multiple times — `Connection::open`
    /// creates the file lazily, and migrations are idempotent.
    pub fn open(db_path: &Path) -> Result<Self, String> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create library dir: {e}"))?;
        }
        let conn = Connection::open(db_path)
            .map_err(|e| format!("open {}: {e}", db_path.display()))?;
        // WAL gives us a single writer + many readers without blocking.
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| format!("set WAL: {e}"))?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| format!("set foreign_keys: {e}"))?;
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(|e| format!("set synchronous: {e}"))?;

        run_migrations(&conn)?;

        Ok(Self {
            inner: Arc::new(Mutex::new(conn)),
            path: db_path.to_path_buf(),
        })
    }

    /// Lock the underlying connection. Holders should keep the guard for
    /// as little time as possible — long-running scans should yield with
    /// short transactions to keep the UI's reads snappy.
    pub fn lock(&self) -> parking_lot::MutexGuard<'_, Connection> {
        self.inner.lock()
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

fn run_migrations(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);",
    )
    .map_err(|e| format!("create schema_version: {e}"))?;

    let current: i64 = conn
        .query_row("SELECT COALESCE(MAX(version), 0) FROM schema_version", [], |r| {
            r.get(0)
        })
        .map_err(|e| format!("read schema version: {e}"))?;

    for (i, sql) in MIGRATIONS.iter().enumerate() {
        let target = (i + 1) as i64;
        if target <= current {
            continue;
        }
        crate::log!("library:db", "applying migration {target}");
        conn.execute_batch(sql)
            .map_err(|e| format!("migration {target} failed: {e}"))?;
        conn.execute(
            "INSERT INTO schema_version(version) VALUES (?1)",
            params![target],
        )
        .map_err(|e| format!("record migration {target}: {e}"))?;
    }
    Ok(())
}

/// Convenience: read a single key from the settings table. Returns None
/// when the key isn't set (caller decides the default).
pub fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT value FROM library_settings WHERE key = ?1",
        params![key],
        |r| r.get::<_, String>(0),
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(format!("get_setting {key}: {other}")),
    })
}

/// Convenience: upsert a key/value pair into the settings table.
pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO library_settings(key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|e| format!("set_setting {key}: {e}"))?;
    Ok(())
}
