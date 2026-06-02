//! Compute a `Fingerprint` for a video file.
//!
//! Filename + size + container + codec + duration from libmpv metadata, plus
//! pHash samples at 5 / 25 / 50 / 75 / 95 % of the timeline. pHash sampling
//! adds ~1-3s per file (5 seeks + 5 screenshots + 5 image decodes) but lets
//! us match the same video across re-encodings / renames.

use crate::fingerprint::phash;
use crate::profile::format::{Fingerprint, PhashSample};
use libmpv2::Mpv;
use libmpv2_sys::mpv_command;
use std::ffi::CString;
use std::os::raw::c_char;
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

const LOAD_TIMEOUT: Duration = Duration::from_secs(8);
const POLL_INTERVAL: Duration = Duration::from_millis(40);
const SEEK_SETTLE: Duration = Duration::from_millis(120);
const SAMPLE_POSITIONS: &[f64] = &[0.05, 0.25, 0.50, 0.75, 0.95];

pub fn compute_for_file(path: &Path) -> Result<Fingerprint, String> {
    let metadata = std::fs::metadata(path).map_err(|e| format!("file metadata: {e}"))?;
    let size_bytes = metadata.len();
    let filename = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let path_str = path.to_str().ok_or_else(|| "path is not valid utf-8".to_string())?;

    // Transient libmpv just for property extraction. Audio + video disabled.
    let mpv = Mpv::with_initializer(|init| {
        init.set_option("vo", "null")?;
        init.set_option("ao", "null")?;
        init.set_option("pause", true)?;
        Ok(())
    })
    .map_err(|e| format!("libmpv init: {e:?}"))?;
    mpv.set_property("msg-level", "all=fatal").ok();

    let handle = mpv.ctx.as_ptr();
    cmd_array(handle, &["loadfile", path_str])
        .map_err(|e| format!("loadfile {path_str}: {e}"))?;

    // Wait for libmpv to populate metadata. duration becomes available
    // shortly after the demuxer reads the header.
    let deadline = Instant::now() + LOAD_TIMEOUT;
    let mut duration_s: f64 = 0.0;
    while Instant::now() < deadline {
        if let Ok(d) = mpv.get_property::<f64>("duration") {
            if d > 0.0 {
                duration_s = d;
                break;
            }
        }
        thread::sleep(POLL_INTERVAL);
    }

    let duration_ms = (duration_s * 1000.0) as u64;
    let container: String = mpv.get_property("file-format").unwrap_or_default();
    let codec: String = mpv.get_property("video-codec").unwrap_or_default();

    // pHash sampling — only attempt when we know the duration and the file
    // actually has video (otherwise screenshots fail).
    let mut phash_samples: Vec<PhashSample> = Vec::new();
    if duration_s > 0.5 && !codec.is_empty() {
        let temp = std::env::temp_dir().join(format!("fvp_phash_{}.jpg", std::process::id()));
        let temp_str = temp.to_string_lossy().to_string();
        for &pct in SAMPLE_POSITIONS {
            let pos_s = duration_s * pct;
            if cmd_array(handle, &["seek", &pos_s.to_string(), "absolute"]).is_err() {
                continue;
            }
            thread::sleep(SEEK_SETTLE);
            if cmd_array(handle, &["screenshot-to-file", &temp_str, "video"]).is_err() {
                continue;
            }
            let Ok(hash) = phash::dhash_image_file(&temp) else {
                continue;
            };
            phash_samples.push(PhashSample {
                position: pct,
                hash: phash::format_hash(hash),
            });
        }
        let _ = std::fs::remove_file(&temp);
    }

    Ok(Fingerprint {
        filename,
        size_bytes,
        container,
        codec,
        duration_ms,
        phash_samples,
    })
}

/// Call `mpv_command` directly with the array-of-args form so paths with
/// spaces don't get shell-split (libmpv2's `Mpv::command()` uses
/// `mpv_command_string` which splits on whitespace).
fn cmd_array(handle: *mut libmpv2_sys::mpv_handle, args: &[&str]) -> Result<(), String> {
    let cstrs: Vec<CString> = args
        .iter()
        .map(|s| CString::new(*s).map_err(|e| format!("CString: {e}")))
        .collect::<Result<_, _>>()?;
    let mut ptrs: Vec<*const c_char> = cstrs.iter().map(|s| s.as_ptr()).collect();
    ptrs.push(std::ptr::null());
    let code = unsafe { mpv_command(handle, ptrs.as_ptr() as *mut _) };
    if code == 0 {
        Ok(())
    } else {
        Err(format!("mpv_command code={code}"))
    }
}
