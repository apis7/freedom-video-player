use crate::autosnip;
use crate::autosnip::srt::SubtitleEntry;
use libmpv2::{events::Event, Mpv};
use libmpv2_sys::mpv_command;
use std::ffi::CString;
use std::os::raw::c_char;
use std::path::PathBuf;

#[tauri::command]
pub async fn autosnip_run(
    video_path: String,
    lang_code: Option<String>,
) -> Result<Vec<autosnip::AutoSnipMatch>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        autosnip::run_for_video(&PathBuf::from(video_path), lang_code.as_deref())
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

/// Match a pre-extracted list of subtitle entries (used when the video has
/// no external .srt but does have an embedded sub track we've already pulled
/// via `extract_embedded_subtitle`).
#[tauri::command]
pub fn autosnip_run_on_entries(
    entries: Vec<autosnip::srt::SubtitleEntry>,
    lang_code: Option<String>,
) -> Vec<autosnip::AutoSnipMatch> {
    autosnip::run_for_entries(&entries, lang_code.as_deref())
}

/// Quick check: is there a subtitle file in the same folder?
/// Returns Some(path-as-string) if found.
#[tauri::command]
pub fn autosnip_find_subtitles(video_path: String) -> Option<String> {
    autosnip::find_subtitle_file(&PathBuf::from(video_path))
        .and_then(|p| p.to_str().map(|s| s.to_string()))
}

/// Parse an SRT (or SRT-like) subtitle file from disk and return its entries.
/// Used by Profile Creator to render subtitle blocks on the Subs row.
#[tauri::command]
pub async fn parse_subtitle_file(path: String) -> Result<Vec<SubtitleEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let content = std::fs::read_to_string(&path)
            .map_err(|e| format!("Couldn't read subtitle file {path}: {e}"))?;
        autosnip::srt::parse(&content).map_err(|e| format!("Couldn't parse subtitle file: {e}"))
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

/// Sidecar cache for extracted embedded subtitles so re-opening the same
/// video doesn't re-run the 1-10s extraction. Keyed per track id.
fn sub_cache_path_for(video_path: &str, track_id: i64) -> Result<PathBuf, String> {
    let p = std::path::Path::new(video_path);
    let parent = p
        .parent()
        .ok_or_else(|| "video path has no parent dir".to_string())?;
    let stem = p
        .file_stem()
        .ok_or_else(|| "video path has no file name".to_string())?;
    let mut name = stem.to_owned();
    name.push(format!(".fvp-subs-cache-t{track_id}.json"));
    Ok(parent.join(name))
}

#[derive(serde::Serialize, serde::Deserialize)]
struct SubCacheFile {
    schema: u32,
    track_id: i64,
    entries: Vec<SubtitleEntry>,
}

/// Extract embedded subtitle entries with caching. First time: spawns a
/// transient libmpv, scans via `sub-seek`, writes a sidecar cache file.
/// Subsequent calls: just reads the cache (fast).
#[tauri::command]
pub async fn extract_embedded_subtitle(
    video_path: String,
    track_id: i64,
) -> Result<Vec<SubtitleEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Cache hit?
        if let Ok(cache_path) = sub_cache_path_for(&video_path, track_id) {
            if let Ok(text) = std::fs::read_to_string(&cache_path) {
                if let Ok(parsed) = serde_json::from_str::<SubCacheFile>(&text) {
                    if parsed.schema == 1 && parsed.track_id == track_id {
                        eprintln!(
                            "[fvp] sub cache hit: {} ({} entries)",
                            cache_path.display(),
                            parsed.entries.len()
                        );
                        return Ok(parsed.entries);
                    }
                }
            }
        }
        let entries = extract_subs_blocking(&video_path, track_id)?;
        // Best-effort write to cache; don't fail extraction if disk is read-only.
        if let Ok(cache_path) = sub_cache_path_for(&video_path, track_id) {
            let cache = SubCacheFile {
                schema: 1,
                track_id,
                entries: entries.clone(),
            };
            if let Ok(text) = serde_json::to_string(&cache) {
                let _ = std::fs::write(&cache_path, text);
            }
        }
        Ok(entries)
    })
    .await
    .map_err(|e| format!("extract spawn: {e}"))?
}

fn extract_subs_blocking(video_path: &str, track_id: i64) -> Result<Vec<SubtitleEntry>, String> {
    if !std::path::Path::new(video_path).exists() {
        return Err(format!("video file does not exist: {video_path}"));
    }

    let mut mpv = Mpv::with_initializer(|init| {
        init.set_option("vo", "null")?;
        init.set_option("ao", "null")?;
        init.set_option("pause", true)?;
        init.set_option("input-default-bindings", "no")?;
        Ok(())
    })
    .map_err(|e| format!("transient mpv init failed: {e:?}"))?;

    let handle = mpv.ctx.as_ptr();

    cmd_array(handle, &["loadfile", video_path])
        .map_err(|e| format!("loadfile failed: {e}"))?;

    // Wait for FileLoaded before issuing sub commands.
    let ec = mpv.event_context_mut();
    let mut loaded = false;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    while std::time::Instant::now() < deadline {
        match ec.wait_event(0.5) {
            Some(Ok(Event::FileLoaded)) => {
                loaded = true;
                break;
            }
            Some(Ok(Event::EndFile(_))) => {
                return Err("libmpv reported end-of-file before load completed".into());
            }
            Some(Ok(_)) => {}
            Some(Err(e)) => {
                eprintln!("[extract_subs] libmpv event error: {e:?}");
            }
            None => {}
        }
    }
    if !loaded {
        return Err("Timed out waiting for libmpv to load the video".into());
    }

    cmd_array(handle, &["set", "sid", &track_id.to_string()])
        .map_err(|e| format!("set sid={track_id} failed: {e}"))?;

    // Position at the start. sub-seek 1 then moves to the next subtitle after
    // the current position; starting from 0 ensures we capture the first one.
    cmd_array(handle, &["seek", "0", "absolute"])
        .map_err(|e| format!("seek to 0 failed: {e}"))?;

    let mut entries: Vec<SubtitleEntry> = Vec::new();
    let mut last_start_ms: i64 = -1;
    let max_entries = 100_000usize; // hard cap to avoid runaway

    for _ in 0..max_entries {
        // sub-seek 1 advances to the next subtitle event.
        if cmd_array(handle, &["sub-seek", "1"]).is_err() {
            break;
        }

        // Give libmpv a moment to update sub-start / sub-text properties.
        // (sub-seek is async-ish; properties update after a frame.)
        std::thread::sleep(std::time::Duration::from_millis(2));

        let start_s: f64 = mpv.get_property("sub-start").unwrap_or(-1.0);
        let end_s: f64 = mpv.get_property("sub-end").unwrap_or(-1.0);
        let text: String = mpv.get_property("sub-text").unwrap_or_default();

        let start_ms = (start_s * 1000.0) as i64;
        if start_s < 0.0 || start_ms <= last_start_ms {
            break; // wrapped, or no progress — done
        }
        if !text.trim().is_empty() {
            entries.push(SubtitleEntry {
                start_ms: start_ms as u64,
                end_ms: (end_s.max(start_s) * 1000.0) as u64,
                text,
            });
        }
        last_start_ms = start_ms;
    }

    Ok(entries)
}

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

/// Compute the whitelist sidecar path for a video:
///   `/dir/movie.mp4` → `/dir/movie.fvp-whitelist.json`
fn whitelist_path_for(video_path: &str) -> Result<std::path::PathBuf, String> {
    let p = std::path::Path::new(video_path);
    let parent = p
        .parent()
        .ok_or_else(|| "video path has no parent dir".to_string())?;
    let stem = p
        .file_stem()
        .ok_or_else(|| "video path has no file name".to_string())?;
    let mut name = stem.to_owned();
    name.push(".fvp-whitelist.json");
    Ok(parent.join(name))
}

#[tauri::command]
pub fn load_autosnip_whitelist(video_path: String) -> Result<Vec<String>, String> {
    let p = whitelist_path_for(&video_path)?;
    match std::fs::read_to_string(&p) {
        Ok(text) => {
            #[derive(serde::Deserialize)]
            struct Whitelist {
                #[serde(default)]
                keywords: Vec<String>,
            }
            let parsed: Whitelist = serde_json::from_str(&text)
                .map_err(|e| format!("Invalid whitelist file: {e}"))?;
            Ok(parsed.keywords)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("read whitelist: {e}")),
    }
}

#[tauri::command]
pub fn save_autosnip_whitelist(
    video_path: String,
    keywords: Vec<String>,
) -> Result<(), String> {
    let p = whitelist_path_for(&video_path)?;
    let body = serde_json::json!({
        "schema": 1,
        "keywords": keywords,
    });
    let text = serde_json::to_string_pretty(&body)
        .map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(&p, text).map_err(|e| format!("write whitelist: {e}"))
}

/// Open a URL in the user's default browser. Tauri 2 doesn't expose this in
/// the core API; we use the OS shell directly. Used by AutoSnip's
/// "No subtitles found" modal to open OpenSubtitles.com.
#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    // Naive URL validation — refuse anything that isn't an http(s) URL so a
    // hypothetical caller can't trigger `cmd /c start <weird>`.
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("only http(s) URLs are allowed".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", "", &url])
            .spawn()
            .map_err(|e| format!("open url failed: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("open url failed: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("open url failed: {e}"))?;
    }
    Ok(())
}
