//! LRU-evicting on-disk cache for TMDb poster images.
//!
//! Cache files live in `<app_local_data_dir>/poster-cache/<sha-of-url>.jpg`.
//! The cap defaults to 300 MB (user-adjustable via the `poster_cache_cap_bytes`
//! row in `library_settings`). Eviction is **least-recently-accessed**:
//! every cache hit bumps the file's mtime, and when we go over the cap we
//! delete the oldest mtimes until we're back under.

use crate::library::db::{get_setting, set_setting, LibraryDb};
use rusqlite::Connection;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::time::SystemTime;

/// Running cache size in bytes. Initialized lazily on first access by
/// walking the dir once, then maintained incrementally by fetch_to_cache
/// and enforce_cap. SENTINEL `-1` (held as i64) means "not yet
/// initialized." Stored as AtomicI64 so we can distinguish "uninit"
/// from "0 bytes," then the value-returning APIs cast to u64.
static CACHED_SIZE_BYTES: AtomicI64 = AtomicI64::new(-1);

/// Increment / decrement the running cache-size counter. No-op when the
/// counter hasn't been seeded yet (first read does that).
fn bump_cache_size(delta: i64) {
    let cur = CACHED_SIZE_BYTES.load(Ordering::Relaxed);
    if cur >= 0 {
        CACHED_SIZE_BYTES.fetch_add(delta, Ordering::Relaxed);
    }
}

// Used to dedupe concurrent re-walks of the cache dir.
static SEEDING: AtomicU64 = AtomicU64::new(0);

pub const DEFAULT_CAP_BYTES: u64 = 300 * 1024 * 1024;
const SETTING_KEY: &str = "poster_cache_cap_bytes";

/// Get the configured cache cap, falling back to the default when unset.
/// Persists the default on first read so the user can adjust it in Settings.
pub fn get_cap_bytes(conn: &Connection) -> u64 {
    match get_setting(conn, SETTING_KEY).ok().flatten() {
        Some(s) => s.parse::<u64>().unwrap_or(DEFAULT_CAP_BYTES),
        None => {
            let _ = set_setting(conn, SETTING_KEY, &DEFAULT_CAP_BYTES.to_string());
            DEFAULT_CAP_BYTES
        }
    }
}

pub fn set_cap_bytes(conn: &Connection, cap: u64) -> Result<(), String> {
    set_setting(conn, SETTING_KEY, &cap.to_string())
}

/// Cache directory under the app's local data dir. Created lazily.
pub fn cache_dir(app_local_data_dir: &Path) -> PathBuf {
    app_local_data_dir.join("poster-cache")
}

fn url_to_filename(url: &str) -> String {
    // We hash the URL so weird characters / query strings can't poison the
    // filesystem. The TMDb extension is preserved when obvious; otherwise
    // we default to .jpg (TMDb serves jpegs).
    let h = blake3::hash(url.as_bytes()).to_hex().to_string();
    let short = &h[..16];
    let ext = url
        .rsplit('.')
        .next()
        .filter(|e| e.len() <= 5 && e.chars().all(|c| c.is_ascii_alphanumeric()))
        .unwrap_or("jpg")
        .to_lowercase();
    format!("{short}.{ext}")
}

/// Path the cached version of `url` lives at (or would live at if downloaded).
pub fn cache_path_for(app_local_data_dir: &Path, url: &str) -> PathBuf {
    cache_dir(app_local_data_dir).join(url_to_filename(url))
}

/// True when the cache already has this URL. Bumps the file's mtime as a
/// side effect so eviction treats it as "recently used."
pub fn touch_if_present(app_local_data_dir: &Path, url: &str) -> Option<PathBuf> {
    let path = cache_path_for(app_local_data_dir, url);
    if !path.exists() {
        return None;
    }
    // Update access time by re-opening for write of the same content. We
    // can't reliably set atime cross-platform, but mtime works as a stand-in
    // since the only thing we ever do to these files is overwrite/replace.
    // Easiest portable bump: filetime-style — re-set mtime to now.
    let _ = filetime_now(&path);
    Some(path)
}

/// Download `url`, write to the cache, return the local path. If the file
/// already exists we skip the network call. Evicts down to cap afterwards.
pub fn fetch_to_cache(
    db: &LibraryDb,
    app_local_data_dir: &Path,
    url: &str,
) -> Result<PathBuf, String> {
    let dir = cache_dir(app_local_data_dir);
    fs::create_dir_all(&dir).map_err(|e| format!("create cache dir: {e}"))?;
    let dest = cache_path_for(app_local_data_dir, url);
    if dest.exists() {
        let _ = filetime_now(&dest);
        return Ok(dest);
    }
    let bytes = crate::tmdb::fetch_image(url)?;
    let new_size = bytes.len() as i64;
    // Write through a temp path + rename for crash safety.
    let tmp = dest.with_extension("dl-tmp");
    fs::write(&tmp, &bytes).map_err(|e| format!("write poster: {e}"))?;
    fs::rename(&tmp, &dest).map_err(|e| format!("rename poster: {e}"))?;
    bump_cache_size(new_size);

    // Evict if we're now over the cap.
    let cap = {
        let conn = db.lock();
        get_cap_bytes(&conn)
    };
    if let Err(e) = enforce_cap(&dir, cap) {
        crate::log!("library:poster-cache", "eviction FAILED: {e}");
    }

    Ok(dest)
}

fn filetime_now(path: &Path) -> std::io::Result<()> {
    // Touch by re-opening with append + flushing — modifies mtime on every
    // platform. Reading bytes that we don't intend to modify would be
    // cheaper but isn't enough to bump mtime on Windows.
    let now = SystemTime::now();
    let f = std::fs::OpenOptions::new().write(true).open(path)?;
    f.set_modified(now)?;
    Ok(())
}

/// Walk the cache dir and remove the oldest-mtime files until total size
/// is at or under `cap`. Returns the number of files deleted.
pub fn enforce_cap(dir: &Path, cap: u64) -> Result<u32, String> {
    if !dir.exists() {
        return Ok(0);
    }
    let mut entries: Vec<(PathBuf, u64, SystemTime)> = Vec::new();
    let read = fs::read_dir(dir).map_err(|e| format!("read cache dir: {e}"))?;
    let mut total: u64 = 0;
    for entry in read.flatten() {
        let path = entry.path();
        let Ok(md) = entry.metadata() else { continue };
        if !md.is_file() {
            continue;
        }
        let len = md.len();
        let mtime = md.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        total += len;
        entries.push((path, len, mtime));
    }
    if total <= cap {
        return Ok(0);
    }
    // Sort oldest-first. Pop oldest until under cap.
    entries.sort_by_key(|(_, _, mtime)| *mtime);
    let mut deleted = 0u32;
    let mut current = total;
    let mut bytes_removed: i64 = 0;
    for (path, len, _) in entries {
        if current <= cap {
            break;
        }
        if fs::remove_file(&path).is_ok() {
            current = current.saturating_sub(len);
            bytes_removed += len as i64;
            deleted += 1;
        }
    }
    if bytes_removed > 0 {
        bump_cache_size(-bytes_removed);
    }
    Ok(deleted)
}

/// Total bytes currently held in the cache. Used by the Settings panel
/// to show "Cache: 142 / 300 MB".
///
/// Cached in CACHED_SIZE_BYTES; the first call seeds it by walking the
/// dir once, subsequent calls return the running counter. fetch_to_cache
/// and enforce_cap keep the counter in sync as files are added/removed.
pub fn current_size_bytes(dir: &Path) -> u64 {
    let cur = CACHED_SIZE_BYTES.load(Ordering::Relaxed);
    if cur >= 0 {
        return cur as u64;
    }
    // Seed: only one thread should walk the dir; others return 0 until
    // the seeding thread finishes. (The fallback 0 is fine — it'll be
    // correct on the very next call.)
    if SEEDING
        .compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return 0;
    }
    let mut total = 0u64;
    if let Ok(read) = fs::read_dir(dir) {
        for entry in read.flatten() {
            if let Ok(md) = entry.metadata() {
                if md.is_file() {
                    total += md.len();
                }
            }
        }
    }
    CACHED_SIZE_BYTES.store(total as i64, Ordering::Relaxed);
    SEEDING.store(0, Ordering::SeqCst);
    total
}
