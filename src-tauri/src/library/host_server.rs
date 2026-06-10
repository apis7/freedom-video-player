//! Library Networking Phase 2 — Host HTTP server.
//!
//! When this install runs as the **Host**, an axum server listens on
//! the LAN for Client requests. Clients hit `POST /v1/ipc/<command>`
//! with a JSON body of args; the server authenticates via the
//! `X-FVP-Auth` header (token shared via the home folder's
//! `auth-token` file) and dispatches to one of an allow-listed set of
//! library commands.
//!
//! Phase 2a (this build) starts the server, exposes a small set of
//! read endpoints + a couple of writes, and writes the
//! `host-discovery.json` Clients use to find us. Phase 2b will widen
//! the allow-list to cover the full IPC surface and add mDNS
//! announcement. Phase 3 layers in the offline-read-only mode.
//!
//! Architectural note: we DO NOT serialize the entire Tauri command
//! surface here. Each allow-listed entry has a small free function
//! that calls the same underlying logic the Tauri command does, but
//! takes plain types so it can run from the HTTP context. Commands
//! that mutate per-install settings (mode, home folder, auth token
//! itself) are deliberately NOT exposed — only the Host's owner
//! should be able to flip those.

use axum::{
    extract::{Path as AxumPath, State as AxumState},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::oneshot;

use crate::library::db::LibraryDb;

/// Default port the Host binds when no other port is configured.
/// Chosen in the IANA ephemeral range so it rarely collides with
/// well-known services. Configurable later via settings if a user
/// has a conflict.
pub const DEFAULT_HOST_PORT: u16 = 42171;

/// Wire version of the host protocol. Phase-2a is v1; we bump this
/// when the request/response shape changes in a non-backward-compatible
/// way. Clients send this in the URL (`/v1/...`); a mismatched Client
/// gets a clear 404 instead of subtle silent breakage.
pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Clone)]
struct HostState {
    db: LibraryDb,
    token: String,
}

/// Live handle to a running host server. Holding it keeps the
/// server alive; dropping it (or calling `shutdown()`) signals
/// graceful shutdown.
pub struct HostServerHandle {
    addr: SocketAddr,
    shutdown_tx: Option<oneshot::Sender<()>>,
}

impl HostServerHandle {
    pub fn addr(&self) -> SocketAddr {
        self.addr
    }
    pub fn shutdown(mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
    }
}

impl Drop for HostServerHandle {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
    }
}

/// Bind a TCP socket and start the axum server in a background task
/// on Tauri's tokio runtime. Returns immediately with the bound
/// address (so we can write `host-discovery.json` synchronously).
pub fn start(
    db: LibraryDb,
    token: String,
    port: u16,
) -> Result<HostServerHandle, String> {
    // Bind synchronously with std so we can fail fast + report the
    // real bound port back to the caller before any async work
    // begins. tokio takes ownership after we set it non-blocking.
    let addr: SocketAddr = ([0u8, 0, 0, 0], port).into();
    let std_listener = std::net::TcpListener::bind(addr)
        .map_err(|e| format!("bind {addr}: {e} (port in use?)"))?;
    std_listener
        .set_nonblocking(true)
        .map_err(|e| format!("set non-blocking: {e}"))?;
    let local_addr = std_listener
        .local_addr()
        .map_err(|e| format!("local_addr: {e}"))?;
    let tokio_listener = tokio::net::TcpListener::from_std(std_listener)
        .map_err(|e| format!("convert to tokio listener: {e}"))?;

    let state = Arc::new(HostState { db, token });
    let app = Router::new()
        .route("/v1/health", get(health))
        .route("/v1/ipc/:command", post(ipc_dispatch))
        .with_state(state);

    let (tx, rx) = oneshot::channel::<()>();

    crate::log!(
        "library:host",
        "starting HTTP server on {} (protocol v{})",
        local_addr,
        PROTOCOL_VERSION
    );

    tauri::async_runtime::spawn(async move {
        let result = axum::serve(tokio_listener, app)
            .with_graceful_shutdown(async move {
                let _ = rx.await;
            })
            .await;
        match result {
            Ok(()) => {
                crate::log!("library:host", "HTTP server exited cleanly");
            }
            Err(e) => {
                crate::log!("library:host", "HTTP server error: {e}");
            }
        }
    });

    Ok(HostServerHandle {
        addr: local_addr,
        shutdown_tx: Some(tx),
    })
}

/// Try to pick the LAN IPv4 to advertise in `host-discovery.json`.
/// Falls back to `127.0.0.1` if we can't determine an interface — in
/// that case Client devices on other machines won't reach us, but the
/// Host still runs (and a local Client on the same box still works).
pub fn detect_lan_ip() -> String {
    match local_ip_address::local_ip() {
        Ok(ip) => ip.to_string(),
        Err(e) => {
            crate::log!(
                "library:host",
                "detect_lan_ip: falling back to 127.0.0.1 ({e})"
            );
            "127.0.0.1".to_string()
        }
    }
}

#[derive(Serialize)]
struct DiscoveryFile<'a> {
    version: u32,
    host: &'a str,
    port: u16,
    protocol: u32,
    fvp_version: &'a str,
    updated_at: i64,
}

/// Write `host-discovery.json` into the home folder so Clients can
/// find us without manual configuration. Overwrites any existing file
/// (the placeholder Phase 1 writes, or a stale entry from a previous
/// Host instance).
pub fn write_discovery_file(
    home: &std::path::Path,
    host_ip: &str,
    port: u16,
) -> std::io::Result<()> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let payload = DiscoveryFile {
        version: 1,
        host: host_ip,
        port,
        protocol: PROTOCOL_VERSION,
        fvp_version: env!("CARGO_PKG_VERSION"),
        updated_at: now,
    };
    let json = serde_json::to_string_pretty(&payload).unwrap_or_default();
    std::fs::write(home.join("host-discovery.json"), json)?;
    crate::log!(
        "library:host",
        "wrote host-discovery.json: host={host_ip} port={port} protocol=v{PROTOCOL_VERSION}"
    );
    Ok(())
}

// ── HTTP handlers ────────────────────────────────────────────────────

async fn health(
    AxumState(state): AxumState<Arc<HostState>>,
) -> impl IntoResponse {
    // Health is intentionally UNAUTHENTICATED — Clients use it to
    // verify reachability before they have a token configured. It
    // exposes only the protocol version + product version, nothing
    // sensitive. We also report whether we have a valid token loaded
    // so a Client misconfiguration ("Host is up but I get 401") is
    // easier to triage.
    let payload = json!({
        "ok": true,
        "product": "fvp",
        "fvp_version": env!("CARGO_PKG_VERSION"),
        "protocol": PROTOCOL_VERSION,
        "auth_configured": !state.token.is_empty(),
    });
    (StatusCode::OK, Json(payload))
}

async fn ipc_dispatch(
    AxumState(state): AxumState<Arc<HostState>>,
    AxumPath(command): AxumPath<String>,
    headers: HeaderMap,
    Json(args): Json<Value>,
) -> impl IntoResponse {
    // Auth — constant-time compare to avoid leaking the token via a
    // timing side-channel. Token misses log at WARN so the Host owner
    // can see repeated unauthorized attempts (could indicate a stale
    // Client OR something more nefarious).
    let provided = headers
        .get("x-fvp-auth")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !ct_eq(provided.as_bytes(), state.token.as_bytes()) {
        crate::log!(
            "library:host",
            "ipc {command}: unauthorized (token mismatch; provided_len={})",
            provided.len()
        );
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"bad auth token"})),
        )
            .into_response();
    }

    let started = std::time::Instant::now();
    let result = match command.as_str() {
        // ── reads ────────────────────────────────────────────────────
        "list_items" => call_list_items(&state.db, args),
        "list_folders" => call_list_folders(&state.db, args),
        "list_collections" => call_list_collections(&state.db, args),
        "list_series" => call_list_series(&state.db, args),
        "get_settings" => call_get_settings(&state.db, args),
        "get_row" => call_get_row(&state.db, args),
        // ── watch / progress ─────────────────────────────────────────
        "mark_watched" => call_mark_watched(&state.db, args),
        "set_watch_progress" => call_set_watch_progress(&state.db, args),
        "reset_progress" => call_reset_progress(&state.db, args),
        "log_open" => call_log_open(&state.db, args),
        // ── identity edits ───────────────────────────────────────────
        "set_tags" => call_set_tags(&state.db, args),
        "set_notes" => call_set_notes(&state.db, args),
        "set_flags" => call_set_flags(&state.db, args),
        "set_family_rating" => call_set_family_rating(&state.db, args),
        "set_manual_metadata" => call_set_manual_metadata(&state.db, args),
        "refresh_metadata" => call_refresh_metadata(&state.db, args),
        // ── collections ──────────────────────────────────────────────
        "create_collection" => call_create_collection(&state.db, args),
        "rename_collection" => call_rename_collection(&state.db, args),
        "delete_collection" => call_delete_collection(&state.db, args),
        "add_to_collection" => call_add_to_collection(&state.db, args),
        "remove_from_collection" => call_remove_from_collection(&state.db, args),
        "reorder_collection" => call_reorder_collection(&state.db, args),
        // ── series ───────────────────────────────────────────────────
        "create_series" => call_create_series(&state.db, args),
        "rename_series" => call_rename_series(&state.db, args),
        "delete_series" => call_delete_series(&state.db, args),
        "add_to_series" => call_add_to_series(&state.db, args),
        "remove_from_series" => call_remove_from_series(&state.db, args),
        "reorder_series" => call_reorder_series(&state.db, args),
        // ── settings ─────────────────────────────────────────────────
        "set_clock_format" => call_set_clock_format(&state.db, args),
        "set_delete_default" => call_set_delete_default(&state.db, args),
        _ => {
            crate::log!(
                "library:host",
                "ipc {command}: not allow-listed (Phase 2a)"
            );
            return (
                StatusCode::NOT_FOUND,
                Json(json!({
                    "error": format!("command '{command}' is not exposed by this Host \
                                      (Phase 2a allow-list is intentionally small; \
                                      we'll widen it in 2b)")
                })),
            )
                .into_response();
        }
    };

    match result {
        Ok(v) => {
            crate::log!(
                "library:host",
                "ipc {command}: OK in {:?}",
                started.elapsed()
            );
            (StatusCode::OK, Json(v)).into_response()
        }
        Err(e) => {
            crate::log!(
                "library:host",
                "ipc {command}: FAILED in {:?}: {e}",
                started.elapsed()
            );
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error":e})),
            )
                .into_response()
        }
    }
}

// ── Dispatcher backends ──────────────────────────────────────────────
// Each `call_*` is the thin glue between the HTTP boundary (untyped
// JSON) and the underlying library logic. We deliberately keep these
// SMALL — the actual implementations live in `library::index`,
// `library::db`, etc., and are shared with the Tauri command path.

fn call_list_items(db: &LibraryDb, _args: Value) -> Result<Value, String> {
    let rows = crate::commands::library::list_items_core(db)?;
    serde_json::to_value(rows).map_err(|e| format!("serialize list_items: {e}"))
}

fn call_list_folders(db: &LibraryDb, _args: Value) -> Result<Value, String> {
    // Mirror the SELECT in library_list_folders. Kept inline because
    // it's tiny; a future refactor can pull it into library::db.
    let conn = db.lock();
    let mut stmt = conn
        .prepare(
            "SELECT id, path, recursive, added_at, scan_on_startup
             FROM watched_folders ORDER BY added_at",
        )
        .map_err(|e| format!("prepare folders: {e}"))?;
    let rows: Vec<Value> = stmt
        .query_map([], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "path": r.get::<_, String>(1)?,
                "recursive": r.get::<_, i64>(2)? != 0,
                "added_at": r.get::<_, i64>(3)?,
                "scan_on_startup": r.get::<_, i64>(4)? != 0,
            }))
        })
        .map_err(|e| format!("query folders: {e}"))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(Value::Array(rows))
}

fn call_get_settings(db: &LibraryDb, _args: Value) -> Result<Value, String> {
    // We expose a SUBSET of settings to Clients — specifically NOT
    // the Host's PIN hash or its own networking config. A Client
    // sees: clock_format, delete_default, family_view_allowed/enabled,
    // poster_cache cap+size. Mode/host_address/token are
    // per-install state and never travel over the wire.
    let conn = db.lock();
    let mut h = std::collections::HashMap::<String, String>::new();
    let mut stmt = conn
        .prepare(
            "SELECT key, value FROM library_settings
             WHERE key IN ('family_view_allowed', 'family_view_enabled',
                           'clock_format', 'delete_default')",
        )
        .map_err(|e| format!("prepare: {e}"))?;
    for row in stmt
        .query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|e| format!("query: {e}"))?
    {
        if let Ok((k, v)) = row {
            h.insert(k, v);
        }
    }
    Ok(json!({
        "clock_format": h.get("clock_format").cloned().unwrap_or_else(|| "12h".into()),
        "delete_default": h.get("delete_default").cloned().unwrap_or_else(|| "remove".into()),
        "family_view_allowed": h.get("family_view_allowed").map(|s| s == "1").unwrap_or(false),
        "family_view_enabled": h.get("family_view_enabled").map(|s| s == "1").unwrap_or(false),
    }))
}

fn call_mark_watched(db: &LibraryDb, args: Value) -> Result<Value, String> {
    let file_id = args
        .get("file_id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| "missing or non-integer 'file_id'".to_string())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let conn = db.lock();
    conn.execute(
        "UPDATE library_files
         SET watched_at = ?1, watch_progress_ms = NULL
         WHERE id = ?2",
        rusqlite::params![now, file_id],
    )
    .map_err(|e| format!("mark_watched: {e}"))?;
    crate::log!("library:host", "ipc mark_watched: file_id={file_id} ok");
    Ok(json!({"ok": true}))
}

fn call_set_watch_progress(db: &LibraryDb, args: Value) -> Result<Value, String> {
    let file_id = args
        .get("file_id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| "missing or non-integer 'file_id'".to_string())?;
    let progress_ms = args
        .get("progress_ms")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| "missing or non-integer 'progress_ms'".to_string())?;
    let conn = db.lock();
    conn.execute(
        "UPDATE library_files
         SET watch_progress_ms = ?1
         WHERE id = ?2",
        rusqlite::params![progress_ms, file_id],
    )
    .map_err(|e| format!("set_watch_progress: {e}"))?;
    Ok(json!({"ok": true}))
}

// ── More dispatcher backends ────────────────────────────────────────

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn arg_i64(args: &Value, key: &str) -> Result<i64, String> {
    args.get(key)
        .and_then(|v| v.as_i64())
        .ok_or_else(|| format!("missing or non-integer '{key}'"))
}
fn arg_str(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("missing or non-string '{key}'"))
}
fn arg_opt_i64(args: &Value, key: &str) -> Option<i64> {
    args.get(key).and_then(|v| v.as_i64())
}
fn arg_opt_str(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
}
fn arg_opt_bool(args: &Value, key: &str) -> Option<bool> {
    args.get(key).and_then(|v| v.as_bool())
}
fn arg_str_array(args: &Value, key: &str) -> Result<Vec<String>, String> {
    args.get(key)
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .ok_or_else(|| format!("missing or non-array '{key}'"))
}
fn arg_i64_array(args: &Value, key: &str) -> Result<Vec<i64>, String> {
    args.get(key)
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_i64()).collect())
        .ok_or_else(|| format!("missing or non-array '{key}'"))
}

fn call_get_row(db: &LibraryDb, args: Value) -> Result<Value, String> {
    let file_id = arg_i64(&args, "file_id")?;
    // Reuse list_items_core then filter. Slightly wasteful for huge
    // libraries on a single-row request, but bulk-load lets us reuse
    // tag/collection/series assembly without duplicating SQL. Phase 2c
    // can promote this to a per-row variant if profiling justifies it.
    let rows = crate::commands::library::list_items_core(db)?;
    let row = rows.into_iter().find(|r| r.file.id == file_id);
    serde_json::to_value(row).map_err(|e| format!("serialize: {e}"))
}

fn call_list_collections(db: &LibraryDb, _args: Value) -> Result<Value, String> {
    let conn = db.lock();
    let mut stmt = conn
        .prepare(
            "SELECT c.id, c.name, c.created_at,
                    (SELECT COUNT(*) FROM library_collection_items ci WHERE ci.collection_id = c.id),
                    c.non_family_friendly
             FROM library_collections c
             ORDER BY (c.sort_position IS NULL), c.sort_position, c.name COLLATE NOCASE",
        )
        .map_err(|e| format!("prepare: {e}"))?;
    let rows: Vec<Value> = stmt
        .query_map([], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "name": r.get::<_, String>(1)?,
                "created_at": r.get::<_, i64>(2)?,
                "item_count": r.get::<_, i64>(3)?,
                "non_family_friendly": r.get::<_, i64>(4)? != 0,
            }))
        })
        .map_err(|e| format!("query: {e}"))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(Value::Array(rows))
}

fn call_list_series(db: &LibraryDb, _args: Value) -> Result<Value, String> {
    let conn = db.lock();
    let mut stmt = conn
        .prepare(
            "SELECT s.id, s.name, s.has_seasons, s.created_at,
                    (SELECT COUNT(*) FROM library_series_items si WHERE si.series_id = s.id),
                    (SELECT COUNT(*) FROM library_series_items si
                                       JOIN library_files f ON f.identity_id = si.identity_id
                                       WHERE si.series_id = s.id AND f.watched = 1),
                    s.non_family_friendly
             FROM library_series s
             ORDER BY (s.sort_position IS NULL), s.sort_position, s.name COLLATE NOCASE",
        )
        .map_err(|e| format!("prepare: {e}"))?;
    let rows: Vec<Value> = stmt
        .query_map([], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "name": r.get::<_, String>(1)?,
                "has_seasons": r.get::<_, i64>(2)? != 0,
                "created_at": r.get::<_, i64>(3)?,
                "item_count": r.get::<_, i64>(4)?,
                "watched_count": r.get::<_, i64>(5)?,
                "non_family_friendly": r.get::<_, i64>(6)? != 0,
            }))
        })
        .map_err(|e| format!("query: {e}"))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(Value::Array(rows))
}

fn call_reset_progress(db: &LibraryDb, args: Value) -> Result<Value, String> {
    let file_id = arg_i64(&args, "file_id")?;
    let conn = db.lock();
    conn.execute(
        "UPDATE library_files SET watch_progress_ms = NULL, watched_at = NULL, watched = 0 WHERE id = ?1",
        rusqlite::params![file_id],
    ).map_err(|e| format!("reset_progress: {e}"))?;
    Ok(json!({"ok": true}))
}

fn call_log_open(db: &LibraryDb, args: Value) -> Result<Value, String> {
    let file_id = arg_i64(&args, "file_id")?;
    let now = now_unix();
    let conn = db.lock();
    conn.execute(
        "INSERT INTO library_watch_log(file_id, started_at, event_type) VALUES (?1, ?2, 'opened')",
        rusqlite::params![file_id, now],
    ).map_err(|e| format!("log_open: {e}"))?;
    Ok(json!({"ok": true}))
}

fn call_set_tags(db: &LibraryDb, args: Value) -> Result<Value, String> {
    let identity_id = arg_i64(&args, "identity_id")?;
    let tags = arg_str_array(&args, "tags")?;
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let cleaned: Vec<String> = tags
        .into_iter()
        .filter_map(|t| {
            let trimmed = t.trim();
            if trimmed.is_empty() || trimmed.len() > 32 {
                return None;
            }
            let key = trimmed.to_lowercase();
            if seen.insert(key) {
                Some(trimmed.to_string())
            } else {
                None
            }
        })
        .collect();
    let mut conn = db.lock();
    let tx = conn.transaction().map_err(|e| format!("tx: {e}"))?;
    tx.execute("DELETE FROM library_tags WHERE identity_id = ?1", rusqlite::params![identity_id])
        .map_err(|e| format!("clear tags: {e}"))?;
    for tag in cleaned {
        tx.execute(
            "INSERT INTO library_tags(identity_id, tag) VALUES (?1, ?2)",
            rusqlite::params![identity_id, tag],
        )
        .map_err(|e| format!("insert tag: {e}"))?;
    }
    tx.commit().map_err(|e| format!("commit: {e}"))?;
    Ok(json!({"ok": true}))
}

fn call_set_notes(db: &LibraryDb, args: Value) -> Result<Value, String> {
    let identity_id = arg_i64(&args, "identity_id")?;
    let notes = arg_str(&args, "notes")?;
    let trimmed = notes.chars().take(5000).collect::<String>();
    let stored = if trimmed.is_empty() { None } else { Some(trimmed) };
    let conn = db.lock();
    conn.execute(
        "UPDATE library_identities SET notes = ?1, last_updated_at = ?2 WHERE id = ?3",
        rusqlite::params![stored, now_unix(), identity_id],
    ).map_err(|e| format!("set_notes: {e}"))?;
    Ok(json!({"ok": true}))
}

fn call_set_flags(db: &LibraryDb, args: Value) -> Result<Value, String> {
    let identity_id = arg_i64(&args, "identity_id")?;
    let now = now_unix();
    let conn = db.lock();
    let pairs: &[(&str, Option<bool>)] = &[
        ("no_profile_necessary", arg_opt_bool(&args, "no_profile_necessary")),
        ("priority_for_profile", arg_opt_bool(&args, "priority_for_profile")),
        ("non_family_friendly", arg_opt_bool(&args, "non_family_friendly")),
        ("is_3d", arg_opt_bool(&args, "is_3d")),
        ("is_extended", arg_opt_bool(&args, "is_extended")),
    ];
    for (col, val) in pairs {
        if let Some(v) = val {
            let sql = format!(
                "UPDATE library_identities SET {col} = ?1, last_updated_at = ?2 WHERE id = ?3"
            );
            conn.execute(&sql, rusqlite::params![*v as i64, now, identity_id])
                .map_err(|e| format!("set {col}: {e}"))?;
        }
    }
    Ok(json!({"ok": true}))
}

fn call_set_family_rating(db: &LibraryDb, args: Value) -> Result<Value, String> {
    let identity_id = arg_i64(&args, "identity_id")?;
    let rating: Option<i64> = arg_opt_i64(&args, "rating").map(|r| r.clamp(-10, 10));
    let conn = db.lock();
    conn.execute(
        "UPDATE library_identities SET family_rating = ?1, last_updated_at = ?2 WHERE id = ?3",
        rusqlite::params![rating, now_unix(), identity_id],
    ).map_err(|e| format!("set_family_rating: {e}"))?;
    Ok(json!({"ok": true}))
}

fn call_set_manual_metadata(db: &LibraryDb, args: Value) -> Result<Value, String> {
    let identity_id = arg_i64(&args, "identity_id")?;
    let field = arg_str(&args, "field")?;
    let value = arg_opt_str(&args, "value");
    // Whitelist of allowed manual fields (matches the Tauri command).
    let (col, flag_col) = match field.as_str() {
        "title" => ("movie_title", "manual_title"),
        "year" => ("movie_year", "manual_year"),
        "director" => ("movie_director", "manual_director"),
        "plot" => ("movie_plot", "manual_plot"),
        _ => return Err(format!("set_manual_metadata: unknown field '{field}'")),
    };
    let now = now_unix();
    let conn = db.lock();
    if value.is_some() {
        let sql = format!(
            "UPDATE library_identities SET {col} = ?1, {flag_col} = 1, last_updated_at = ?2 WHERE id = ?3"
        );
        conn.execute(&sql, rusqlite::params![value, now, identity_id])
            .map_err(|e| format!("set {col}: {e}"))?;
    } else {
        let sql = format!(
            "UPDATE library_identities SET {col} = NULL, {flag_col} = 0, last_updated_at = ?1 WHERE id = ?2"
        );
        conn.execute(&sql, rusqlite::params![now, identity_id])
            .map_err(|e| format!("clear {col}: {e}"))?;
    }
    Ok(json!({"ok": true}))
}

fn call_refresh_metadata(_db: &LibraryDb, args: Value) -> Result<Value, String> {
    let identity_id = arg_i64(&args, "identity_id")?;
    crate::library::enrich::enqueue_force(identity_id);
    Ok(json!({"ok": true}))
}

fn call_create_collection(db: &LibraryDb, args: Value) -> Result<Value, String> {
    let name = arg_str(&args, "name")?;
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Collection name can't be empty.".into());
    }
    let conn = db.lock();
    conn.execute(
        "INSERT INTO library_collections(name, created_at) VALUES (?1, ?2)",
        rusqlite::params![trimmed, now_unix()],
    ).map_err(|e| format!("create: {e}"))?;
    Ok(json!(conn.last_insert_rowid()))
}

fn call_rename_collection(db: &LibraryDb, args: Value) -> Result<Value, String> {
    let collection_id = arg_i64(&args, "collection_id")?;
    let new_name = arg_str(&args, "new_name")?;
    let trimmed = new_name.trim();
    if trimmed.is_empty() {
        return Err("Name can't be empty.".into());
    }
    let conn = db.lock();
    conn.execute(
        "UPDATE library_collections SET name = ?1 WHERE id = ?2",
        rusqlite::params![trimmed, collection_id],
    ).map_err(|e| format!("rename: {e}"))?;
    Ok(json!({"ok": true}))
}

fn call_delete_collection(db: &LibraryDb, args: Value) -> Result<Value, String> {
    let collection_id = arg_i64(&args, "collection_id")?;
    let conn = db.lock();
    conn.execute(
        "DELETE FROM library_collections WHERE id = ?1",
        rusqlite::params![collection_id],
    ).map_err(|e| format!("delete: {e}"))?;
    Ok(json!({"ok": true}))
}

fn call_add_to_collection(db: &LibraryDb, args: Value) -> Result<Value, String> {
    let collection_id = arg_i64(&args, "collection_id")?;
    let identity_ids = arg_i64_array(&args, "identity_ids")?;
    let mut conn = db.lock();
    let tx = conn.transaction().map_err(|e| format!("tx: {e}"))?;
    let max_pos: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(position), -1) FROM library_collection_items WHERE collection_id = ?1",
            rusqlite::params![collection_id],
            |r| r.get(0),
        )
        .unwrap_or(-1);
    for (i, id) in identity_ids.iter().enumerate() {
        let pos = max_pos + (i as i64) + 1;
        tx.execute(
            "INSERT OR IGNORE INTO library_collection_items(collection_id, identity_id, position) VALUES (?1, ?2, ?3)",
            rusqlite::params![collection_id, id, pos],
        ).map_err(|e| format!("add: {e}"))?;
    }
    tx.commit().map_err(|e| format!("commit: {e}"))?;
    Ok(json!({"ok": true}))
}

fn call_remove_from_collection(db: &LibraryDb, args: Value) -> Result<Value, String> {
    let collection_id = arg_i64(&args, "collection_id")?;
    let identity_ids = arg_i64_array(&args, "identity_ids")?;
    let mut conn = db.lock();
    let tx = conn.transaction().map_err(|e| format!("tx: {e}"))?;
    for id in identity_ids {
        tx.execute(
            "DELETE FROM library_collection_items WHERE collection_id = ?1 AND identity_id = ?2",
            rusqlite::params![collection_id, id],
        ).map_err(|e| format!("remove: {e}"))?;
    }
    tx.commit().map_err(|e| format!("commit: {e}"))?;
    Ok(json!({"ok": true}))
}

fn call_reorder_collection(db: &LibraryDb, args: Value) -> Result<Value, String> {
    let ordered = arg_i64_array(&args, "ordered_ids")?;
    let mut conn = db.lock();
    let tx = conn.transaction().map_err(|e| format!("tx: {e}"))?;
    for (pos, id) in ordered.iter().enumerate() {
        tx.execute(
            "UPDATE library_collections SET sort_position = ?1 WHERE id = ?2",
            rusqlite::params![pos as i64, id],
        ).map_err(|e| format!("reorder: {e}"))?;
    }
    tx.commit().map_err(|e| format!("commit: {e}"))?;
    Ok(json!({"ok": true}))
}

// Series — same shape as collections, different tables.

fn call_create_series(db: &LibraryDb, args: Value) -> Result<Value, String> {
    let name = arg_str(&args, "name")?;
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Series name can't be empty.".into());
    }
    let conn = db.lock();
    conn.execute(
        "INSERT INTO library_series(name, has_seasons, created_at) VALUES (?1, 0, ?2)",
        rusqlite::params![trimmed, now_unix()],
    ).map_err(|e| format!("create: {e}"))?;
    Ok(json!(conn.last_insert_rowid()))
}

fn call_rename_series(db: &LibraryDb, args: Value) -> Result<Value, String> {
    let series_id = arg_i64(&args, "series_id")?;
    let new_name = arg_str(&args, "new_name")?;
    let trimmed = new_name.trim();
    if trimmed.is_empty() {
        return Err("Name can't be empty.".into());
    }
    let conn = db.lock();
    conn.execute(
        "UPDATE library_series SET name = ?1 WHERE id = ?2",
        rusqlite::params![trimmed, series_id],
    ).map_err(|e| format!("rename: {e}"))?;
    Ok(json!({"ok": true}))
}

fn call_delete_series(db: &LibraryDb, args: Value) -> Result<Value, String> {
    let series_id = arg_i64(&args, "series_id")?;
    let conn = db.lock();
    conn.execute(
        "DELETE FROM library_series WHERE id = ?1",
        rusqlite::params![series_id],
    ).map_err(|e| format!("delete: {e}"))?;
    Ok(json!({"ok": true}))
}

fn call_add_to_series(db: &LibraryDb, args: Value) -> Result<Value, String> {
    let series_id = arg_i64(&args, "series_id")?;
    let identity_ids = arg_i64_array(&args, "identity_ids")?;
    let mut conn = db.lock();
    let tx = conn.transaction().map_err(|e| format!("tx: {e}"))?;
    let max_pos: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(position), -1) FROM library_series_items WHERE series_id = ?1",
            rusqlite::params![series_id],
            |r| r.get(0),
        )
        .unwrap_or(-1);
    for (i, id) in identity_ids.iter().enumerate() {
        let pos = max_pos + (i as i64) + 1;
        tx.execute(
            "INSERT OR IGNORE INTO library_series_items(series_id, identity_id, position) VALUES (?1, ?2, ?3)",
            rusqlite::params![series_id, id, pos],
        ).map_err(|e| format!("add: {e}"))?;
    }
    tx.commit().map_err(|e| format!("commit: {e}"))?;
    Ok(json!({"ok": true}))
}

fn call_remove_from_series(db: &LibraryDb, args: Value) -> Result<Value, String> {
    let series_id = arg_i64(&args, "series_id")?;
    let identity_ids = arg_i64_array(&args, "identity_ids")?;
    let mut conn = db.lock();
    let tx = conn.transaction().map_err(|e| format!("tx: {e}"))?;
    for id in identity_ids {
        tx.execute(
            "DELETE FROM library_series_items WHERE series_id = ?1 AND identity_id = ?2",
            rusqlite::params![series_id, id],
        ).map_err(|e| format!("remove: {e}"))?;
    }
    tx.commit().map_err(|e| format!("commit: {e}"))?;
    Ok(json!({"ok": true}))
}

fn call_reorder_series(db: &LibraryDb, args: Value) -> Result<Value, String> {
    let ordered = arg_i64_array(&args, "ordered_ids")?;
    let mut conn = db.lock();
    let tx = conn.transaction().map_err(|e| format!("tx: {e}"))?;
    for (pos, id) in ordered.iter().enumerate() {
        tx.execute(
            "UPDATE library_series SET sort_position = ?1 WHERE id = ?2",
            rusqlite::params![pos as i64, id],
        ).map_err(|e| format!("reorder: {e}"))?;
    }
    tx.commit().map_err(|e| format!("commit: {e}"))?;
    Ok(json!({"ok": true}))
}

fn call_set_clock_format(db: &LibraryDb, args: Value) -> Result<Value, String> {
    let format = arg_str(&args, "format")?;
    if format != "12h" && format != "24h" {
        return Err("format must be '12h' or '24h'".into());
    }
    let conn = db.lock();
    crate::library::db::set_setting(&conn, "clock_format", &format)?;
    Ok(json!({"ok": true}))
}

fn call_set_delete_default(db: &LibraryDb, args: Value) -> Result<Value, String> {
    let default = arg_str(&args, "default")?;
    if default != "remove" && default != "recycle" {
        return Err("default must be 'remove' or 'recycle'".into());
    }
    let conn = db.lock();
    crate::library::db::set_setting(&conn, "delete_default", &default)?;
    Ok(json!({"ok": true}))
}

// ── Helpers ──────────────────────────────────────────────────────────

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}
