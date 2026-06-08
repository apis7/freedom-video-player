//! Tauri commands for audio-peak waveform sidecars.

use crate::peaks;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

#[derive(Serialize)]
pub struct LoadedPeaksDto {
    pub peaks_per_second: u32,
    pub duration_ms: u64,
    /// Peaks are 0..=255 amplitude bytes; serialize as a numeric array (Tauri
    /// IPC encodes Vec<u8> as a JS number[]). At 100 peaks/s a 2-hour movie is
    /// ~720k entries → ~2 MB JSON, parsed in <100 ms; acceptable for a load
    /// that happens once on file-open.
    pub peaks: Vec<u8>,
}

impl From<peaks::LoadedPeaks> for LoadedPeaksDto {
    fn from(v: peaks::LoadedPeaks) -> Self {
        Self {
            peaks_per_second: v.peaks_per_second,
            duration_ms: v.duration_ms,
            peaks: v.peaks,
        }
    }
}

/// Read the existing peaks sidecar for a video, if any. Returns None when
/// the sidecar is missing, stale, or unreadable — the frontend treats all
/// three the same way (kick off a background compute).
#[tauri::command]
pub fn load_peaks(video_path: String) -> Result<Option<LoadedPeaksDto>, String> {
    crate::log!("peaks", "load_peaks called for: {video_path}");
    let path = PathBuf::from(&video_path);
    let Some(peaks_path) = peaks::peaks_path_for(&path) else {
        crate::log!("peaks", "load_peaks: no sidecar path derivable");
        return Ok(None);
    };
    if !peaks::peaks_are_fresh(&path, &peaks_path) {
        crate::log!(
            "peaks",
            "load_peaks: sidecar missing or stale at {} → returning None (build will follow)",
            peaks_path.display()
        );
        return Ok(None);
    }
    let bytes = match std::fs::read(&peaks_path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            crate::log!("peaks", "load_peaks: sidecar vanished between fresh-check and read");
            return Ok(None);
        }
        Err(e) => return Err(format!("read peaks: {e}")),
    };
    match peaks::parse_peaks(&bytes) {
        Ok(p) => {
            crate::log!(
                "peaks",
                "load_peaks: cache HIT — {} peaks, {}ms duration",
                p.peaks.len(),
                p.duration_ms
            );
            Ok(Some(p.into()))
        }
        Err(e) => {
            crate::log!("peaks", "sidecar corrupt, ignoring: {e}");
            Ok(None)
        }
    }
}

/// Compute the peaks sidecar in the background. Emits `fvp:peaks-progress`
/// during the run and `fvp:peaks-done` / `fvp:peaks-failed` on completion.
/// Returns immediately to the frontend; result is delivered via events.
#[tauri::command]
pub async fn build_peaks(app: AppHandle, video_path: String) -> Result<(), String> {
    crate::log!("peaks", "build_peaks IPC called for: {video_path}");
    let emit_path = video_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::log!("peaks", "build_peaks worker thread starting for: {video_path}");
        let result = peaks::compute_peaks_for_file(&app, Path::new(&video_path));
        match result {
            Ok(_) => {
                let _ = app.emit(
                    "fvp:peaks-done",
                    serde_json::json!({ "video_path": emit_path }),
                );
            }
            Err(e) => {
                crate::log!("peaks", "build FAILED for {emit_path}: {e}");
                let _ = app.emit(
                    "fvp:peaks-failed",
                    serde_json::json!({
                        "video_path": emit_path,
                        "error": e,
                    }),
                );
            }
        }
    });
    Ok(())
}
