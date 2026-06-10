//! Help-menu diagnostics commands.
//!
//! V1 stubs (no email pipeline yet): each `submit_*` writes a JSON file
//! into the AppData diagnostics folder and logs the path so the
//! developer can pick them up off-box. Later, this becomes an actual
//! HTTPS POST to a hidden endpoint, but the frontend contract stays
//! the same — the modals don't change when the backend wires through.
//!
//! Two surface entry points:
//!   - get_recent_log_lines(n)  → reads the LOG_RING from `logging`
//!   - submit_report(kind, body, tail_lines) → writes the stub file
//!
//! `tail_lines` arrives from the frontend already collected (it
//! includes the JS-side console captures that mirror into the same
//! terminal anyway). We don't try to dedupe — the file is for human
//! eyes, not parsing.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::log;

#[derive(Debug, Serialize, Deserialize)]
pub struct ReportPayload {
    /// "error" or "feature_request" — drives subdir + filename prefix.
    pub kind: String,
    /// Free-form body composed by the modal.
    pub body: String,
    /// Optional bag of structured fields (software area, expected vs.
    /// actual, etc.). The modals fill it; we round-trip as JSON.
    pub fields: serde_json::Value,
    /// Tail of the terminal/log buffer the user agreed to share. Empty
    /// if the user opted out.
    pub tail_lines: Vec<String>,
}

#[tauri::command]
pub fn get_recent_log_lines(n: usize) -> Vec<String> {
    let cap = n.clamp(1, 500);
    crate::logging::recent_log_lines(cap)
}

#[tauri::command]
pub fn submit_report(app: tauri::AppHandle, payload: ReportPayload) -> Result<String, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app data dir: {e}"))?
        .join("diagnostics");
    fs::create_dir_all(&dir).map_err(|e| format!("create diagnostics dir: {e}"))?;

    let ts = chrono::Local::now().format("%Y-%m-%d-%H%M%S").to_string();
    let prefix = match payload.kind.as_str() {
        "feature_request" => "feature-request",
        _ => "error-report",
    };
    let path: PathBuf = dir.join(format!("{prefix}-{ts}.json"));

    let json = serde_json::to_string_pretty(&payload)
        .map_err(|e| format!("serialize report: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("write report: {e}"))?;

    log!(
        "diagnostics",
        "submit_report kind={} fields_keys={} tail_lines={} -> {}",
        payload.kind,
        payload
            .fields
            .as_object()
            .map(|o| o.len())
            .unwrap_or(0),
        payload.tail_lines.len(),
        path.display(),
    );

    Ok(path.display().to_string())
}
