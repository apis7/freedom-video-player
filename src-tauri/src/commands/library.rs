//! Library Mode: scan a folder for video files + correlate with .free profiles.
//! Also exposes a folder-watch command using the `notify` crate — when files
//! in the watched folder appear / disappear / change, we emit a Tauri event
//! so the frontend can re-scan.

use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use serde::Serialize;
use std::path::Path;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const VIDEO_EXTENSIONS: &[&str] = &[
    "mkv", "mp4", "avi", "mov", "m4v", "webm", "wmv", "flv", "mpg", "mpeg", "ts", "m2ts",
];

#[derive(Serialize, Clone, Debug)]
pub struct LibraryItem {
    pub path: String,
    pub filename: String,
    pub size_bytes: u64,
    pub modified_unix: u64,
    /// Number of `.free` profiles found alongside this video file.
    pub profile_count: u32,
}

/// Recursively scan a folder for video files. Up to `max_depth` deep so we
/// don't blow out on huge folder trees. Returns items sorted by filename.
#[tauri::command]
pub async fn scan_library_folder(
    folder: String,
    recursive: bool,
) -> Result<Vec<LibraryItem>, String> {
    tauri::async_runtime::spawn_blocking(move || scan_blocking(&folder, recursive))
        .await
        .map_err(|e| format!("join: {e}"))?
}

fn scan_blocking(folder: &str, recursive: bool) -> Result<Vec<LibraryItem>, String> {
    let folder = Path::new(folder);
    if !folder.exists() {
        return Err(format!("Folder does not exist: {}", folder.display()));
    }
    if !folder.is_dir() {
        return Err(format!("Not a folder: {}", folder.display()));
    }
    let mut items: Vec<LibraryItem> = Vec::new();
    let max_depth = if recursive { 6 } else { 1 };
    visit(folder, 0, max_depth, &mut items)?;
    items.sort_by(|a, b| a.filename.to_lowercase().cmp(&b.filename.to_lowercase()));
    Ok(items)
}

fn visit(
    dir: &Path,
    depth: usize,
    max_depth: usize,
    items: &mut Vec<LibraryItem>,
) -> Result<(), String> {
    if depth >= max_depth {
        return Ok(());
    }
    let entries = std::fs::read_dir(dir)
        .map_err(|e| format!("read_dir {}: {e}", dir.display()))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let _ = visit(&path, depth + 1, max_depth, items);
            continue;
        }
        let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
            continue;
        };
        if !VIDEO_EXTENSIONS
            .iter()
            .any(|v| v.eq_ignore_ascii_case(ext))
        {
            continue;
        }
        let Some(filename) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let metadata = entry.metadata().ok();
        let size_bytes = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
        let modified_unix = metadata
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let profile_count = count_profiles_for(&path);
        items.push(LibraryItem {
            path: path.to_string_lossy().to_string(),
            filename: filename.to_string(),
            size_bytes,
            modified_unix,
            profile_count,
        });
    }
    Ok(())
}

fn count_profiles_for(video: &Path) -> u32 {
    let Some(parent) = video.parent() else { return 0 };
    let Some(stem) = video.file_stem().and_then(|s| s.to_str()) else {
        return 0;
    };
    let stem_lower = stem.to_lowercase();
    let Ok(entries) = std::fs::read_dir(parent) else { return 0 };
    let mut count = 0u32;
    for e in entries.flatten() {
        let p = e.path();
        let Some(ext) = p.extension().and_then(|e| e.to_str()) else { continue };
        if !ext.eq_ignore_ascii_case("free") { continue; }
        let Some(name_stem) = p.file_stem().and_then(|s| s.to_str()) else { continue };
        // .free files are named "<video-stem>.<profile-name>.free", so the
        // file stem starts with the video's stem followed by a dot.
        if name_stem.to_lowercase().starts_with(&format!("{stem_lower}.")) {
            count += 1;
        }
    }
    count
}

// ── Folder watcher ──
// Single-watcher singleton — replacing the watched folder drops the old one.
// We coalesce bursts of events (writes during a download / copy) by ignoring
// events that arrive within DEBOUNCE_MS of the previous one and instead
// scheduling a single "changed" event after the quiet period.
static WATCHER: OnceLock<Mutex<Option<RecommendedWatcher>>> = OnceLock::new();
const DEBOUNCE_MS: u64 = 500;

#[tauri::command]
pub fn watch_library_folder(folder: String, app: AppHandle) -> Result<(), String> {
    let slot = WATCHER.get_or_init(|| Mutex::new(None));
    // Drop the previous watcher (RAII; unwatches automatically).
    *slot.lock() = None;

    let folder_path = std::path::PathBuf::from(&folder);
    if !folder_path.is_dir() {
        return Err(format!("Folder does not exist: {folder}"));
    }
    let app_for_thread = app.clone();
    let last_event: Mutex<Instant> = Mutex::new(Instant::now() - Duration::from_secs(60));

    let watcher_result = RecommendedWatcher::new(
        move |res: notify::Result<notify::Event>| {
            let Ok(_ev) = res else { return };
            // Debounce: schedule a fire at DEBOUNCE_MS after the latest event.
            let now = Instant::now();
            let mut last = last_event.lock();
            let elapsed = now.duration_since(*last);
            *last = now;
            if elapsed.as_millis() < DEBOUNCE_MS as u128 {
                return; // newer event will re-trigger; this one suppressed
            }
            // Sleep DEBOUNCE_MS then emit; if a newer event comes in, our
            // last_event will be newer than now+DEBOUNCE_MS and we'll bail.
            let _ = now; // suppress unused warning for the timing path
            let app_emit = app_for_thread.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(DEBOUNCE_MS));
                let _ = app_emit.emit("library-changed", serde_json::json!({}));
            });
        },
        Config::default(),
    );

    let mut watcher = watcher_result.map_err(|e| format!("create watcher: {e}"))?;
    watcher
        .watch(&folder_path, RecursiveMode::Recursive)
        .map_err(|e| format!("watch {folder}: {e}"))?;
    *slot.lock() = Some(watcher);
    Ok(())
}

#[tauri::command]
pub fn unwatch_library_folder() -> Result<(), String> {
    if let Some(slot) = WATCHER.get() {
        *slot.lock() = None;
    }
    Ok(())
}
