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
        "list_items" => call_list_items(&state.db, args),
        "list_folders" => call_list_folders(&state.db, args),
        "get_settings" => call_get_settings(&state.db, args),
        "mark_watched" => call_mark_watched(&state.db, args),
        "set_watch_progress" => call_set_watch_progress(&state.db, args),
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
    let rows = crate::library::index::list_files_with_identity(db)?;
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
