//! Tauri commands for profile + fingerprint operations.

use crate::fingerprint;
use crate::profile::format::{FreeFile, Fingerprint};
use crate::profile::{io, signing};
use std::path::{Path, PathBuf};

#[tauri::command]
pub async fn compute_fingerprint(path: String) -> Result<Fingerprint, String> {
    crate::log!("profile", "compute_fingerprint: {path}");
    let started = std::time::Instant::now();
    let result = tauri::async_runtime::spawn_blocking(move || {
        fingerprint::compute_for_file(Path::new(&path))
    })
    .await
    .map_err(|e| format!("join: {e}"))?;
    match &result {
        Ok(fp) => crate::log!(
            "profile",
            "fingerprint OK in {:?} (duration_ms={}, container={}, codec={}, phash_samples={})",
            started.elapsed(),
            fp.duration_ms,
            fp.container,
            fp.codec,
            fp.phash_samples.len()
        ),
        Err(e) => crate::log!(
            "profile",
            "fingerprint FAILED in {:?}: {e}",
            started.elapsed()
        ),
    }
    result
}

#[tauri::command]
pub async fn scan_folder_for_profiles(
    video_path: String,
) -> Result<Vec<fingerprint::MatchResult>, String> {
    crate::log!("profile", "scan_folder_for_profiles for: {video_path}");
    let started = std::time::Instant::now();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(&video_path);
        let video_fp = fingerprint::compute_for_file(&path)?;
        let folder = path
            .parent()
            .ok_or_else(|| "video has no parent folder".to_string())?;
        Ok(fingerprint::scan_folder(folder, &video_fp))
    })
    .await
    .map_err(|e| format!("join: {e}"))?;
    match &result {
        Ok(matches) => {
            crate::log!(
                "profile",
                "scan complete in {:?} — {} match candidate(s)",
                started.elapsed(),
                matches.len()
            );
            for m in matches {
                crate::log!(
                    "profile",
                    "  - {} (quality={:?}, snips={}, reasons={:?})",
                    m.path,
                    m.score.quality,
                    m.profile.payload.snips.len(),
                    m.score.reasons
                );
            }
        }
        Err(e) => crate::log!(
            "profile",
            "scan FAILED in {:?}: {e}",
            started.elapsed()
        ),
    }
    result
}

#[tauri::command]
pub fn load_profile(path: String) -> Result<FreeFile, String> {
    crate::log!("profile", "load_profile: {path}");
    let result = io::load(Path::new(&path)).map_err(|e| e.to_string());
    match &result {
        Ok(p) => crate::log!(
            "profile",
            "loaded {} (schema={}, snips={}, signed={})",
            p.payload.metadata.name,
            p.schema,
            p.payload.snips.len(),
            p.signature.is_some()
        ),
        Err(e) => crate::log!("profile", "load FAILED: {e}"),
    }
    result
}

#[tauri::command]
pub fn save_profile(path: String, profile: FreeFile) -> Result<(), String> {
    crate::log!(
        "profile",
        "save_profile: {path} ({} snips, signed={})",
        profile.payload.snips.len(),
        profile.signature.is_some()
    );
    let target = Path::new(&path);
    if let Err(e) = rotate_backups_if_needed(target) {
        // Backups are a safety net — failure to rotate must not block the
        // real save. Log loudly so a broken filesystem still gets seen.
        crate::log!("profile", "backup rotation FAILED (continuing): {e}");
    }
    let r = io::save(target, &profile).map_err(|e| e.to_string());
    if let Err(e) = &r {
        crate::log!("profile", "save FAILED: {e}");
    } else {
        crate::log!("profile", "save OK");
    }
    r
}

/// Rolling daily backup rotation. Keeps up to three `.bakN` siblings of the
/// current `.free`:
///   .bak1 = most-recent previous editing day
///   .bak2 = day before that
///   .bak3 = three editing days back
///
/// On every save we check `.bak1`'s mtime: if it's on a different LOCAL
/// calendar day than today (or .bak1 doesn't exist yet but a .free does),
/// we rotate down (.bak2 → .bak3, .bak1 → .bak2) and copy the current
/// pre-save .free into .bak1. Same-day re-saves leave the backups alone —
/// so .bak1 always captures the *last save of a previous editing day*,
/// not the previous save of today.
///
/// First save of a brand-new .free: nothing exists yet, so no rotation.
fn rotate_backups_if_needed(free_path: &Path) -> Result<(), String> {
    if !free_path.exists() {
        return Ok(());
    }
    let bak1 = bak_path(free_path, 1);
    let bak2 = bak_path(free_path, 2);
    let bak3 = bak_path(free_path, 3);

    let today = chrono::Local::now().date_naive();
    let bak1_date = if bak1.exists() {
        local_date_of_file(&bak1)?
    } else {
        None
    };
    let should_rotate = match bak1_date {
        // bak1 was last touched on an earlier local day → start a new ring slot
        Some(d) => d != today,
        // .free exists but no .bak1 yet → seed the chain
        None => true,
    };
    if !should_rotate {
        return Ok(());
    }
    crate::log!(
        "profile",
        "rotating backups for {} (bak1 date={:?}, today={today})",
        free_path.display(),
        bak1_date,
    );
    if bak3.exists() {
        std::fs::remove_file(&bak3).map_err(|e| format!("remove .bak3: {e}"))?;
    }
    if bak2.exists() {
        std::fs::rename(&bak2, &bak3).map_err(|e| format!("rename .bak2→.bak3: {e}"))?;
    }
    if bak1.exists() {
        std::fs::rename(&bak1, &bak2).map_err(|e| format!("rename .bak1→.bak2: {e}"))?;
    }
    std::fs::copy(free_path, &bak1).map_err(|e| format!("copy .free→.bak1: {e}"))?;
    Ok(())
}

fn bak_path(free_path: &Path, n: u8) -> PathBuf {
    // .free → .free.bak1 / .free.bak2 / .free.bak3
    let mut s = free_path.as_os_str().to_owned();
    s.push(format!(".bak{n}"));
    PathBuf::from(s)
}

fn local_date_of_file(p: &Path) -> Result<Option<chrono::NaiveDate>, String> {
    let md = match std::fs::metadata(p) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("stat {}: {e}", p.display())),
    };
    let modified = md.modified().map_err(|e| format!("mtime: {e}"))?;
    let dt: chrono::DateTime<chrono::Local> = modified.into();
    Ok(Some(dt.date_naive()))
}

#[tauri::command]
pub fn verify_profile(profile: FreeFile) -> Result<bool, String> {
    match signing::verify(&profile) {
        Ok(()) => Ok(true),
        Err(signing::ProfileError::Unsigned) => Ok(false),
        Err(signing::ProfileError::VerifyFailed) => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

/// Compute the sidecar autosave-profile path for a given video file:
///   `/dir/movie.mp4` → `/dir/movie.fvp-autosave.free`
///
/// We use the `.free` extension so the profile scanner picks the autosave
/// up alongside manually-exported profiles. The `.fvp-autosave` infix
/// keeps it visually distinct from a user's "real" export (which might
/// be named `movie Family.free`, `movie Strict.free`, etc.).
///
/// The contents at this path are a full `FreeFile` JSON (same schema as
/// manually-exported profiles) so the scanner can match by fingerprint
/// and the loader can read it without a special code path.
fn draft_path_for(video_path: &str) -> Result<PathBuf, String> {
    let p = Path::new(video_path);
    let parent = p
        .parent()
        .ok_or_else(|| "video path has no parent dir".to_string())?;
    let stem = p
        .file_stem()
        .ok_or_else(|| "video path has no file name".to_string())?;
    let mut name = stem.to_owned();
    name.push(".fvp-autosave.free");
    Ok(parent.join(name))
}

/// Legacy autosave path from before `.fvp-autosave.free`. Kept ONLY so we
/// can read and migrate old drafts on file-open; never written to anymore.
fn legacy_draft_path_for(video_path: &str) -> Option<PathBuf> {
    let p = Path::new(video_path);
    let parent = p.parent()?;
    let stem = p.file_stem()?;
    let mut name = stem.to_owned();
    name.push(".fvp-draft.json");
    Some(parent.join(name))
}

#[tauri::command]
pub fn save_draft(video_path: String, json: String) -> Result<(), String> {
    let draft = draft_path_for(&video_path)?;
    std::fs::write(&draft, json).map_err(|e| format!("write draft: {e}"))
}

#[tauri::command]
pub fn load_draft(video_path: String) -> Result<Option<String>, String> {
    let draft = draft_path_for(&video_path)?;
    match std::fs::read_to_string(&draft) {
        Ok(s) => return Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("read draft: {e}")),
    }
    // Fallback: look for the pre-rename legacy draft at
    // `.fvp-draft.json`. Lets users carrying old drafts recover them once;
    // the frontend will re-save in the new format and orphan the old file.
    if let Some(legacy) = legacy_draft_path_for(&video_path) {
        match std::fs::read_to_string(&legacy) {
            Ok(s) => return Ok(Some(s)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("read legacy draft: {e}")),
        }
    }
    Ok(None)
}

#[tauri::command]
pub fn delete_draft(video_path: String) -> Result<(), String> {
    let draft = draft_path_for(&video_path)?;
    match std::fs::remove_file(&draft) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("delete draft: {e}")),
    }
}

/// Does this path exist on disk? Used by the Export modal so we can warn
/// before overwriting an existing .free.
#[tauri::command]
pub fn file_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

/// Is this path a directory? Used by drag-drop so we can reject folders
/// with a helpful message instead of trying (and failing) to play them.
#[tauri::command]
pub fn is_directory(path: String) -> bool {
    std::path::Path::new(&path).is_dir()
}

/// Generic text-file write. Used by Save Playlist (.m3u) so we don't need to
/// pull in the @tauri-apps/plugin-fs plugin just for one writer.
#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| format!("write {path}: {e}"))
}
