pub mod audio_filter;
pub mod audio_replace;

use libmpv2::{
    events::{Event, EventContext, PropertyData},
    Format, Mpv,
};
use libmpv2_sys::{mpv_command, mpv_handle, mpv_request_log_messages};
use std::ffi::CString;
use std::os::raw::c_char;

/// Translate a raw libmpv error code to a human-readable string. The Debug
/// repr of libmpv2's `Error::Raw(-13)` tells you nothing — this turns the
/// code into something a user can act on.
fn explain_mpv_code(code: i32) -> &'static str {
    match code {
        0 => "SUCCESS",
        -1 => "EVENT_QUEUE_FULL — too many events queued without being read",
        -2 => "NOMEM — out of memory",
        -3 => "UNINITIALIZED — libmpv handle isn't initialized",
        -4 => "INVALID_PARAMETER — bad argument; often a file path that doesn't exist or contains characters that libmpv's shell-parser splits on",
        -5 => "OPTION_NOT_FOUND — option name unknown to this libmpv build",
        -6 => "OPTION_FORMAT — option value type wrong",
        -7 => "OPTION_ERROR — option couldn't be set for some other reason",
        -8 => "PROPERTY_NOT_FOUND — property name unknown to this libmpv build",
        -9 => "PROPERTY_FORMAT — property type mismatch",
        -10 => "PROPERTY_UNAVAILABLE — property has no value right now (often no file loaded)",
        -11 => "PROPERTY_ERROR — getting/setting the property failed",
        -12 => "COMMAND — command invocation failed (bad args, libmpv refused)",
        -13 => "LOADING_FAILED — libmpv couldn't load the file (codec / demuxer / VO)",
        -14 => "AO_INIT_FAILED — audio output couldn't initialize",
        -15 => "VO_INIT_FAILED — video output couldn't initialize (wid likely wrong)",
        -16 => "NOTHING_TO_PLAY — file has no playable streams",
        -17 => "UNKNOWN_FORMAT — libmpv couldn't determine the file format",
        -18 => "UNSUPPORTED — operation not supported by this libmpv build",
        -19 => "NOT_IMPLEMENTED — feature not implemented in this libmpv build",
        -20 => "GENERIC — unspecified libmpv failure",
        _ => "unknown libmpv error code",
    }
}

/// Call `mpv_command` directly with the array-of-args form. We can't use
/// libmpv2's `Mpv::command()` for commands whose args may contain spaces —
/// 4.1 builds the string and calls `mpv_command_string` (shell-parser),
/// which mis-splits paths like "C:\Users\User\FVP items\x.mp4" on spaces.
fn mpv_command_array(handle: *mut mpv_handle, args: &[&str]) -> Result<(), String> {
    let cstrs: Vec<CString> = args
        .iter()
        .map(|s| CString::new(*s).map_err(|e| format!("CString conversion: {e}")))
        .collect::<Result<_, _>>()?;
    let mut ptrs: Vec<*const c_char> = cstrs.iter().map(|s| s.as_ptr()).collect();
    ptrs.push(std::ptr::null()); // mpv_command expects a NULL terminator
    let code = unsafe { mpv_command(handle, ptrs.as_ptr() as *mut _) };
    if code == 0 {
        Ok(())
    } else {
        Err(format!(
            "mpv_command code={code} ({})",
            explain_mpv_code(code),
        ))
    }
}
use parking_lot::Mutex;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use tauri::{AppHandle, Emitter};

/// Thin wrapper over libmpv with a backing event loop that pushes property
/// changes to the frontend via Tauri events.
///
/// Architecture note: instead of the frontend polling libmpv every 100 ms,
/// libmpv pushes `PropertyChange` events whenever `time-pos`, `pause`, `speed`,
/// etc. change. A dedicated thread drains those events and emits them as the
/// `mpv-property` Tauri event. This gives the frontend ~60 Hz freshness on the
/// playhead with no polling lag.
///
/// On Windows, libmpv is embedded into an *intermediate* native child window
/// (class STATIC) we create inside the Tauri main window — see `video_subclass`.
pub struct MpvPlayer {
    mpv: Arc<Mutex<Mpv>>,
    event_thread: Mutex<Option<JoinHandle<()>>>,
    shutdown: Arc<AtomicBool>,
}

impl Drop for MpvPlayer {
    fn drop(&mut self) {
        // Signal the event loop and join it BEFORE Mpv is dropped — otherwise
        // the thread's EventContext (which holds a raw pointer to the mpv
        // handle) would dereference freed memory.
        self.shutdown.store(true, Ordering::SeqCst);
        if let Some(handle) = self.event_thread.lock().take() {
            let _ = handle.join();
        }
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct AudioDevice {
    pub name: String,
    pub description: String,
    pub selected: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct SubtitleTrack {
    pub id: i64,
    pub title: Option<String>,
    pub lang: Option<String>,
    pub selected: bool,
    pub external: bool,
}

#[derive(Serialize)]
pub struct PlayerState {
    pub position: f64,
    pub duration: f64,
    pub paused: bool,
    pub volume: f64,
    pub muted: bool,
    pub has_file: bool,
    pub speed: f64,
}

#[derive(Serialize, Clone)]
struct PropertyEvent {
    name: String,
    value: serde_json::Value,
}

/// Convert a libmpv `PropertyChange` event into a JSON payload we can emit.
/// Returns `None` for property types we don't handle (Node, OsdStr, etc.).
fn extract_property(ev: &Event<'_>) -> Option<PropertyEvent> {
    match ev {
        Event::PropertyChange { name, change, .. } => {
            let value = match change {
                PropertyData::Double(v) => serde_json::json!(*v),
                PropertyData::Flag(v) => serde_json::json!(*v),
                PropertyData::Int64(v) => serde_json::json!(*v),
                PropertyData::Str(s) => serde_json::json!(*s),
                _ => return None,
            };
            Some(PropertyEvent {
                name: (*name).to_string(),
                value,
            })
        }
        _ => None,
    }
}

impl MpvPlayer {
    pub fn new(parent_hwnd: Option<i64>, app: AppHandle) -> Result<Self, String> {
        #[cfg(target_os = "windows")]
        let wid: Option<i64> = parent_hwnd.map(|p| {
            video_subclass::create_intermediate(p) as i64
        });
        #[cfg(not(target_os = "windows"))]
        let wid: Option<i64> = parent_hwnd;

        // libmpv distinguishes between OPTIONS (must be set before
        // mpv_initialize — these affect how the player starts up, like which
        // video output to use and which window to embed into) and PROPERTIES
        // (can be set anytime — playback state, OSD, input bindings, etc.).
        // Using set_property for `wid` / `vo` after init produces unpredictable
        // results: some libmpv builds silently ignore them, leaving the VO in
        // a state where loadfile returns MPV_ERROR_LOADING_FAILED.
        //
        // Only set `wid` / `vo` as init-time options — those are the ones
        // that genuinely must precede mpv_initialize (they decide which
        // video output backend libmpv picks). Everything else is a runtime
        // property and set after.
        crate::log!("playback", "init: wid={wid:?}");
        let mut mpv = Mpv::with_initializer(|init| {
            if let Some(h) = wid {
                init.set_option("wid", h)?;
                // Force vo=gpu instead of letting libmpv default to gpu-next
                // (libplacebo). gpu-next has known issues with embedded child
                // HWNDs on Windows: it initializes, the decoder produces
                // frames, but the swap-chain never makes them visible inside
                // the parent webview window — symptom is "audio plays, video
                // is black, no error in logs". vo=gpu is the older Direct3D11
                // path that has worked reliably with `wid` since mpv 0.31.
                init.set_option("vo", "gpu")?;
                init.set_option("gpu-context", "d3d11")?;
            } else {
                init.set_option("vo", "null")?;
            }
            Ok(())
        })
        .map_err(|e| format!("libmpv init failed: {e:?}"))?;
        crate::log!("playback", "mpv initialized");

        mpv.set_property("keep-open", "yes")
            .map_err(|e| format!("set keep-open failed: {e:?}"))?;
        // msg-level: get vo/decoder-level info so we can SEE when the
        // render pipeline silently rejects frames (which presents as
        // "audio plays, video is black"). Was "warn" — bumping to
        // "info" for the vo + ffmpeg modules specifically so the
        // signal-to-noise stays reasonable.
        mpv.set_property("msg-level", "all=warn,vo=info,vd=info,ffmpeg=info")
            .map_err(|e| format!("set msg-level failed: {e:?}"))?;
        // Hardware decoding: auto-safe tries DXVA2 / D3D11VA first and
        // FALLS BACK to software when the codec/profile combination
        // isn't supported by the driver. Without this set, mpv defaults
        // to `no` (always software) on some builds — which is safe but
        // slow — or to `auto` on others — which can silently fail to
        // render frames when the chosen accelerator rejects the file.
        // auto-safe is the documented "use hardware when it'll work,
        // software when it won't" mode.
        mpv.set_property("hwdec", "auto-safe")
            .map_err(|e| format!("set hwdec failed: {e:?}"))?;
        mpv.set_property("osd-level", 0i64)
            .map_err(|e| format!("set osd-level=0 failed: {e:?}"))?;
        mpv.set_property("osd-bar", "no")
            .map_err(|e| format!("set osd-bar=no failed: {e:?}"))?;
        mpv.set_property("osc", "no")
            .map_err(|e| format!("set osc=no failed: {e:?}"))?;
        mpv.set_property("input-default-bindings", "no")
            .map_err(|e| format!("set input-default-bindings=no failed: {e:?}"))?;
        mpv.set_property("input-vo-keyboard", "no")
            .map_err(|e| format!("set input-vo-keyboard=no failed: {e:?}"))?;
        mpv.set_property("input-cursor", "no")
            .map_err(|e| format!("set input-cursor=no failed: {e:?}"))?;
        mpv.set_property("hr-seek", "yes")
            .map_err(|e| format!("set hr-seek=yes failed: {e:?}"))?;
        mpv.set_property("hr-seek-framedrop", "yes")
            .map_err(|e| format!("set hr-seek-framedrop=yes failed: {e:?}"))?;

        // Demuxer cache — enable a small back-buffer so the Creator-mode
        // reverse-play button has something to walk through. We keep both
        // cache and back-buffer modest so the demuxer never out-runs the
        // pipeline (an earlier 256MiB cap caused video packets to pile up
        // against the cap and stall playback). 32MiB back ≈ ~8s of 1080p.
        mpv.set_property("cache", "yes")
            .map_err(|e| format!("set cache=yes failed: {e:?}"))?;
        mpv.set_property("demuxer-max-back-bytes", 32i64 * 1024 * 1024)
            .map_err(|e| format!("set demuxer-max-back-bytes failed: {e:?}"))?;

        // Request libmpv's internal log messages so we can see WHY loadfile
        // fails when it returns the generic MPV_ERROR_LOADING_FAILED code.
        // Level "warn" catches initialization, demuxer, and codec problems
        // without flooding stderr with verbose info.
        unsafe {
            let level = CString::new("warn").unwrap();
            mpv_request_log_messages(mpv.ctx.as_ptr(), level.as_ptr());
        }

        // Register property observers. Each observation triggers an initial
        // event with the current value, then again on every change.
        {
            let ec = mpv.event_context_mut();
            for (name, format, id) in [
                ("time-pos", Format::Double, 1u64),
                ("duration", Format::Double, 2),
                ("pause", Format::Flag, 3),
                ("speed", Format::Double, 4),
                ("volume", Format::Double, 5),
                ("mute", Format::Flag, 6),
                ("idle-active", Format::Flag, 7),
                ("play-direction", Format::String, 8),
            ] {
                ec.observe_property(name, format, id)
                    .map_err(|e| format!("observe {name} failed: {e:?}"))?;
            }
        }

        // Build a separate EventContext for the worker thread by copying the
        // raw handle. Both contexts share the same event queue; the worker is
        // the only thread that calls wait_event.
        let mut thread_event_ctx = EventContext::new(mpv.ctx);

        let shutdown = Arc::new(AtomicBool::new(false));
        let shutdown_for_thread = shutdown.clone();
        let app_for_thread = app.clone();

        let event_thread = std::thread::spawn(move || {
            while !shutdown_for_thread.load(Ordering::SeqCst) {
                match thread_event_ctx.wait_event(0.25) {
                    Some(Ok(ev)) => {
                        // Print libmpv's internal log messages so we can see
                        // demuxer/codec/init errors when loadfile fails.
                        if let Event::LogMessage { prefix, level, text, .. } = &ev {
                            crate::log!("mpv", "{level} {prefix}: {}", text.trim_end());
                        }
                        if matches!(ev, Event::Shutdown) {
                            break;
                        }
                        if let Some(payload) = extract_property(&ev) {
                            let _ = app_for_thread.emit("mpv-property", payload);
                        }
                    }
                    Some(Err(e)) => {
                        crate::log!("mpv", "event error: {e:?}");
                    }
                    None => {}
                }
            }
        });

        Ok(Self {
            mpv: Arc::new(Mutex::new(mpv)),
            event_thread: Mutex::new(Some(event_thread)),
            shutdown,
        })
    }

    pub fn load_file(&self, path: &str) -> Result<(), String> {
        crate::log!("playback", "loadfile: {path}");
        if !std::path::Path::new(path).exists() {
            return Err(format!(
                "The file does not exist on disk:\n  {path}\n\
                 (Was it moved or deleted between picking it and loading?)"
            ));
        }
        let metadata = std::fs::metadata(path)
            .map_err(|e| format!("Couldn't read file metadata for {path}: {e}"))?;
        crate::log!("playback", "file exists, size={} bytes", metadata.len());
        // Mute the library's notify watchers while libmpv has a file
        // open — SMB reads otherwise trigger Modify::Data events that
        // would re-fire the watched-folder scan we just finished and
        // steal bandwidth from the active playback.
        crate::library::orchestrator::set_playback_holds_file(true);
        {
            let mpv = self.mpv.lock();
            mpv_command_array(mpv.ctx.as_ptr(), &["loadfile", path]).map_err(|e| {
                format!(
                    "libmpv refused to load the file.\n\
                     Path: {path}\n\
                     Error: {e}\n\
                     Look for [mpv:warn] / [mpv:error] lines in the dev terminal \
                     for the specific reason (codec, demuxer, hardware accel, etc.)."
                )
            })?;
        }
        #[cfg(target_os = "windows")]
        std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_millis(120));
            video_subclass::ensure_subclassed();
        });
        // Post-load video-state diagnostic. First sample at 1.5s (gives
        // libmpv time to demux, pick a decoder, and report dimensions),
        // second sample at 4s after playback has had a chance to advance
        // so we can see whether frames are actually being PRESENTED
        // (not just decoded).
        let mpv_arc = self.mpv.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(1500));
            {
                let mpv = mpv_arc.lock();
                let w: i64 = mpv.get_property("dwidth").unwrap_or(-1);
                let h: i64 = mpv.get_property("dheight").unwrap_or(-1);
                let codec: String = mpv
                    .get_property::<String>("video-codec")
                    .unwrap_or_else(|_| "<none>".into());
                let hwdec_current: String = mpv
                    .get_property::<String>("hwdec-current")
                    .unwrap_or_else(|_| "<none>".into());
                let vo: String = mpv
                    .get_property::<String>("current-vo")
                    .unwrap_or_else(|_| "<none>".into());
                crate::log!(
                    "playback",
                    "post-load video state @1.5s: {w}x{h} codec={codec:?} hwdec={hwdec_current:?} vo={vo:?}"
                );
                #[cfg(target_os = "windows")]
                video_subclass::dump_hwnd_geometry("@1.5s");
            }
            // Sample again at 4s — if dropped-vo-frame-count is climbing
            // or frames-presented (vo-passes proxy) is 0, frames are being
            // produced but not displayed (render-surface problem).
            std::thread::sleep(std::time::Duration::from_millis(2500));
            {
                let mpv = mpv_arc.lock();
                let pos: f64 = mpv.get_property("time-pos").unwrap_or(-1.0);
                let frame_drops: i64 = mpv
                    .get_property("frame-drop-count")
                    .unwrap_or(-1);
                let decoder_drops: i64 = mpv
                    .get_property("decoder-frame-drop-count")
                    .unwrap_or(-1);
                let est_vf_fps: f64 = mpv
                    .get_property("estimated-vf-fps")
                    .unwrap_or(-1.0);
                let est_display_fps: f64 = mpv
                    .get_property("estimated-display-fps")
                    .unwrap_or(-1.0);
                let paused: bool = mpv.get_property("pause").unwrap_or(true);
                crate::log!(
                    "playback",
                    "post-load presentation @4s: time-pos={pos:.2} paused={paused} \
                     decoder_drops={decoder_drops} vo_drops={frame_drops} \
                     est_vf_fps={est_vf_fps:.1} est_display_fps={est_display_fps:.1}"
                );
                if pos > 0.2 && est_display_fps <= 0.0 {
                    crate::log!(
                        "playback",
                        "WARN: time advancing but display_fps=0 — decoder is producing frames but the VO is NOT presenting them (HWND/swap-chain issue)."
                    );
                }
                #[cfg(target_os = "windows")]
                video_subclass::dump_hwnd_geometry("@4s");
            }
        });
        Ok(())
    }

    pub fn play(&self) -> Result<(), String> {
        crate::log!("playback", "play");
        let mpv = self.mpv.lock();
        mpv.set_property("pause", false)
            .map_err(|e| format!("play failed: {e:?}"))
    }

    pub fn pause(&self) -> Result<(), String> {
        crate::log!("playback", "pause");
        let mpv = self.mpv.lock();
        mpv.set_property("pause", true)
            .map_err(|e| format!("pause failed: {e:?}"))
    }

    /// Set the direction libmpv plays in. "forward" is the default; "backward"
    /// plays in reverse using mpv's internal frame cache. Reverse playback is
    /// CPU-intensive (full GOP decode per displayed frame) so it's best used
    /// for short scrubbing-style review in Creator mode rather than long
    /// sustained playback.
    pub fn set_play_direction(&self, direction: &str) -> Result<(), String> {
        crate::log!("playback", "set_play_direction: {direction}");
        let mpv = self.mpv.lock();
        mpv_command_array(mpv.ctx.as_ptr(), &["set", "play-direction", direction])
            .map_err(|e| format!("set play-direction={direction} failed: {e}"))
    }

    /// Read the current play-direction value back from libmpv. Used after
    /// `set_play_direction` to confirm the change took, or by the state
    /// snapshot to populate the initial frontend state.
    pub fn get_play_direction(&self) -> String {
        let mpv = self.mpv.lock();
        mpv.get_property::<String>("play-direction")
            .unwrap_or_else(|_| "forward".to_string())
    }

    /// Override the video's displayed aspect ratio. Accepts strings like
    /// "16:9", "4:3", "2.35:1", "21:9", or "1.7778". Pass "no" (or the
    /// empty string) to clear the override and let libmpv use the video's
    /// native ratio. Persisted per-profile in the `.free` file's metadata.
    pub fn set_aspect_ratio(&self, value: &str) -> Result<(), String> {
        crate::log!("playback", "set_aspect_ratio: {value:?}");
        let mpv = self.mpv.lock();
        // Map our "auto"/"" / null sentinels to libmpv's "no" disable
        // value. Anything else passes through verbatim.
        let mpv_value = if value.is_empty() || value.eq_ignore_ascii_case("auto") {
            "no"
        } else {
            value
        };
        mpv_command_array(
            mpv.ctx.as_ptr(),
            &["set", "video-aspect-override", mpv_value],
        )
        .map_err(|e| format!("set video-aspect-override={mpv_value} failed: {e}"))
    }

    pub fn toggle_pause(&self) -> Result<bool, String> {
        let mpv = self.mpv.lock();
        let paused: bool = mpv
            .get_property("pause")
            .map_err(|e| format!("get pause failed: {e:?}"))?;
        let new_state = !paused;
        mpv.set_property("pause", new_state)
            .map_err(|e| format!("set pause failed: {e:?}"))?;
        Ok(!new_state)
    }

    pub fn set_volume(&self, v: f64) -> Result<(), String> {
        let mpv = self.mpv.lock();
        mpv.set_property("volume", v)
            .map_err(|e| format!("set volume failed: {e:?}"))
    }

    pub fn set_muted(&self, m: bool) -> Result<(), String> {
        let mpv = self.mpv.lock();
        mpv.set_property("mute", m)
            .map_err(|e| format!("set mute failed: {e:?}"))
    }

    pub fn seek_absolute(&self, seconds: f64) -> Result<(), String> {
        let mpv = self.mpv.lock();
        let secs = seconds.to_string();
        mpv_command_array(mpv.ctx.as_ptr(), &["seek", &secs, "absolute"])
            .map_err(|e| format!("seek to {seconds}s failed: {e}"))
    }

    pub fn frame_step_forward(&self) -> Result<(), String> {
        let mpv = self.mpv.lock();
        mpv.command("frame-step", &[])
            .map_err(|e| format!("frame-step failed: {e:?}"))
    }

    pub fn frame_step_back(&self) -> Result<(), String> {
        let mpv = self.mpv.lock();
        mpv.command("frame-back-step", &[])
            .map_err(|e| format!("frame-back-step failed: {e:?}"))
    }

    pub fn stop(&self) -> Result<(), String> {
        crate::library::orchestrator::set_playback_holds_file(false);
        let mpv = self.mpv.lock();
        mpv_command_array(mpv.ctx.as_ptr(), &["stop"])
            .map_err(|e| format!("stop command failed: {e}"))
    }

    /// Add an external subtitle file (.srt / .vtt / .ass / .ssa) to the current
    /// playback. The `"select"` flag makes mpv immediately switch to it.
    pub fn add_subtitle(&self, path: &str) -> Result<(), String> {
        crate::log!("playback", "add_subtitle: {path}");
        if !std::path::Path::new(path).exists() {
            return Err(format!("Subtitle file does not exist:\n  {path}"));
        }
        let mpv = self.mpv.lock();
        mpv_command_array(mpv.ctx.as_ptr(), &["sub-add", path, "select"])
            .map_err(|e| format!("sub-add ({path}) failed: {e}"))
    }

    /// Switch active subtitle track by libmpv track id. Pass `None` to turn
    /// subtitles off entirely.
    pub fn set_subtitle_track(&self, id: Option<i64>) -> Result<(), String> {
        let mpv = self.mpv.lock();
        let value = match id {
            Some(n) => n.to_string(),
            None => "no".to_string(),
        };
        mpv_command_array(mpv.ctx.as_ptr(), &["set", "sid", &value])
            .map_err(|e| format!("set sid={value} failed: {e}"))
    }

    /// Toggle whether subtitles are currently rendered (separate from track
    /// selection — turning this off keeps the track selected but hides it).
    pub fn toggle_subtitle_visibility(&self) -> Result<(), String> {
        let mpv = self.mpv.lock();
        mpv_command_array(mpv.ctx.as_ptr(), &["cycle", "sub-visibility"])
            .map_err(|e| format!("cycle sub-visibility failed: {e}"))
    }

    /// Explicitly set whether subtitles render. Used by the menu checkbox.
    pub fn set_subtitle_visibility(&self, visible: bool) -> Result<(), String> {
        let mpv = self.mpv.lock();
        let v = if visible { "yes" } else { "no" };
        mpv_command_array(mpv.ctx.as_ptr(), &["set", "sub-visibility", v])
            .map_err(|e| format!("set sub-visibility={v} failed: {e}"))
    }

    pub fn get_subtitle_visibility(&self) -> bool {
        let mpv = self.mpv.lock();
        mpv.get_property("sub-visibility").unwrap_or(true)
    }

    /// Snapshot tracks of a given mpv type (`"sub"`, `"audio"`, `"video"`).
    fn tracks_of_kind(&self, want_kind: &str) -> Vec<SubtitleTrack> {
        let mpv = self.mpv.lock();
        let count: i64 = mpv.get_property("track-list/count").unwrap_or(0);
        let mut tracks = Vec::with_capacity(count as usize);
        for i in 0..count {
            let kind: String = mpv
                .get_property(&format!("track-list/{i}/type"))
                .unwrap_or_default();
            if kind != want_kind {
                continue;
            }
            tracks.push(SubtitleTrack {
                id: mpv
                    .get_property(&format!("track-list/{i}/id"))
                    .unwrap_or(0),
                title: mpv.get_property(&format!("track-list/{i}/title")).ok(),
                lang: mpv.get_property(&format!("track-list/{i}/lang")).ok(),
                selected: mpv
                    .get_property(&format!("track-list/{i}/selected"))
                    .unwrap_or(false),
                external: mpv
                    .get_property(&format!("track-list/{i}/external"))
                    .unwrap_or(false),
            });
        }
        tracks
    }

    pub fn subtitle_tracks(&self) -> Result<Vec<SubtitleTrack>, String> {
        Ok(self.tracks_of_kind("sub"))
    }

    pub fn audio_tracks(&self) -> Result<Vec<SubtitleTrack>, String> {
        Ok(self.tracks_of_kind("audio"))
    }

    pub fn video_tracks(&self) -> Result<Vec<SubtitleTrack>, String> {
        Ok(self.tracks_of_kind("video"))
    }

    pub fn set_audio_track(&self, id: Option<i64>) -> Result<(), String> {
        crate::log!("playback", "set_audio_track: {id:?}");
        let mpv = self.mpv.lock();
        let value = match id {
            Some(n) => n.to_string(),
            None => "no".to_string(),
        };
        mpv_command_array(mpv.ctx.as_ptr(), &["set", "aid", &value])
            .map_err(|e| format!("set aid={value} failed: {e}"))
    }

    pub fn set_video_track(&self, id: Option<i64>) -> Result<(), String> {
        crate::log!("playback", "set_video_track: {id:?}");
        let mpv = self.mpv.lock();
        let value = match id {
            Some(n) => n.to_string(),
            None => "no".to_string(),
        };
        mpv_command_array(mpv.ctx.as_ptr(), &["set", "vid", &value])
            .map_err(|e| format!("set vid={value} failed: {e}"))
    }

    /// Set the deinterlace flag (libmpv property `deinterlace`).
    pub fn set_deinterlace(&self, on: bool) -> Result<(), String> {
        let mpv = self.mpv.lock();
        let v = if on { "yes" } else { "no" };
        mpv_command_array(mpv.ctx.as_ptr(), &["set", "deinterlace", v])
            .map_err(|e| format!("set deinterlace={v} failed: {e}"))
    }

    pub fn get_deinterlace(&self) -> bool {
        let mpv = self.mpv.lock();
        mpv.get_property("deinterlace").unwrap_or(false)
    }

    /// Snapshot the list of available audio output devices reported by mpv.
    /// Reads `audio-device-list/count` + `audio-device-list/N/name` /
    /// `description` similar to track-list. The currently-selected one is
    /// marked `selected`.
    pub fn audio_devices(&self) -> Vec<AudioDevice> {
        let mpv = self.mpv.lock();
        let count: i64 = mpv.get_property("audio-device-list/count").unwrap_or(0);
        let current: String = mpv.get_property("audio-device").unwrap_or_default();
        let mut out = Vec::with_capacity(count as usize);
        for i in 0..count {
            let name: String = mpv
                .get_property(&format!("audio-device-list/{i}/name"))
                .unwrap_or_default();
            let description: String = mpv
                .get_property(&format!("audio-device-list/{i}/description"))
                .unwrap_or_default();
            let selected = name == current;
            out.push(AudioDevice {
                name,
                description,
                selected,
            });
        }
        out
    }

    pub fn set_audio_device(&self, name: &str) -> Result<(), String> {
        crate::log!("playback", "set_audio_device: {name}");
        let mpv = self.mpv.lock();
        mpv_command_array(mpv.ctx.as_ptr(), &["set", "audio-device", name])
            .map_err(|e| format!("set audio-device={name} failed: {e}"))
    }

    /// Take a JPG screenshot of the current video frame (no OSD/subs) and
    /// return it as a `data:image/jpeg;base64,…` URL. Used by Freeze-frame.
    pub fn screenshot_data_url(&self) -> Result<String, String> {
        use base64::Engine;
        let pid = std::process::id();
        let temp = std::env::temp_dir().join(format!("fvp_freeze_{pid}.jpg"));
        let temp_str = temp
            .to_str()
            .ok_or_else(|| "Screenshot temp path is not valid UTF-8".to_string())?
            .to_string();
        {
            let mpv = self.mpv.lock();
            mpv_command_array(mpv.ctx.as_ptr(), &["screenshot-to-file", &temp_str, "video"])
                .map_err(|e| format!("screenshot-to-file ({temp_str}) failed: {e}"))?;
        }
        let bytes = std::fs::read(&temp)
            .map_err(|e| format!("Couldn't read screenshot at {}: {e}", temp.display()))?;
        let _ = std::fs::remove_file(&temp);
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        Ok(format!("data:image/jpeg;base64,{b64}"))
    }

    /// One-shot state snapshot. Kept for the initial fetch on startup; the
    /// streaming event bridge takes over after that.
    pub fn state(&self) -> PlayerState {
        let mpv = self.mpv.lock();
        let position: f64 = mpv.get_property("time-pos").unwrap_or(0.0);
        let duration: f64 = mpv.get_property("duration").unwrap_or(0.0);
        let paused: bool = mpv.get_property("pause").unwrap_or(true);
        let volume: f64 = mpv.get_property("volume").unwrap_or(100.0);
        let muted: bool = mpv.get_property("mute").unwrap_or(false);
        let idle: bool = mpv.get_property("idle-active").unwrap_or(true);
        let speed: f64 = mpv.get_property("speed").unwrap_or(1.0);
        PlayerState {
            position,
            duration,
            paused,
            volume,
            muted,
            has_file: !idle,
            speed,
        }
    }

    pub fn set_speed(&self, rate: f64) -> Result<(), String> {
        let mpv = self.mpv.lock();
        let r = format!("{rate}");
        mpv_command_array(mpv.ctx.as_ptr(), &["set", "speed", &r])
            .map_err(|e| format!("set speed to {rate}× failed: {e}"))
    }

    /// Get the absolute path of the currently loaded file, if any.
    pub fn current_path(&self) -> Option<String> {
        let mpv = self.mpv.lock();
        mpv.get_property::<String>("path").ok()
    }

    /// Set the `lavfi-complex` filter graph and reload the current file so it
    /// takes effect. Preserves playback position and pause state.
    ///
    /// `graph` is the full filter-graph string as produced by
    /// `audio_replace::build`. Passing an empty string clears the overlay.
    pub fn apply_lavfi_complex(&self, graph: &str) -> Result<(), String> {
        let mpv = self.mpv.lock();

        // Snapshot state we need to restore after the reload.
        let path: String = mpv
            .get_property("path")
            .map_err(|_| "no file is currently loaded".to_string())?;

        // EARLY EXIT — if the requested graph is identical to the current
        // graph, skip the reload entirely. The expensive reload was
        // racing the initial loadfile on slow network shares and causing
        // the demuxer to read the file's header twice in rapid
        // succession — producing "missing mandatory atoms / broken
        // header" errors. Most clear-overlay calls (e.g. the frontend's
        // useAudioReplaceOverlay hook firing on every file change) come
        // in WHEN THE GRAPH IS ALREADY EMPTY, so this short-circuits
        // the unnecessary work.
        let current_graph: String = mpv
            .get_property::<String>("lavfi-complex")
            .unwrap_or_default();
        if current_graph == graph {
            crate::log!(
                "playback:lavfi",
                "apply: graph unchanged (len={} bytes) — skipping reload (path={path})",
                graph.len()
            );
            return Ok(());
        }

        let position: f64 = mpv.get_property("time-pos").unwrap_or(0.0);
        let paused: bool = mpv.get_property("pause").unwrap_or(false);

        // Diagnostic — write the full graph string so we can see what
        // libavfilter is actually being handed. Wrapped in <<< … >>> so the
        // boundaries are unambiguous even if the graph itself contains
        // newlines or terminal-special chars.
        crate::log!(
            "playback:lavfi",
            "apply: path={path} pos={position:.3}s paused={paused} graph_len={} bytes",
            graph.len()
        );
        crate::log!("playback:lavfi", ">>>BEGIN GRAPH<<<\n{graph}\n>>>END GRAPH<<<");

        // lavfi-complex must be set BEFORE the loadfile that should pick it up.
        // Set it via `set` command so libmpv treats it as an option update.
        mpv_command_array(mpv.ctx.as_ptr(), &["set", "lavfi-complex", graph])
            .map_err(|e| format!("set lavfi-complex failed: {e}"))?;

        // Echo back what mpv now has for the property so we can spot any
        // unwanted parsing/mangling between us and libavfilter.
        let echoed: String = mpv
            .get_property::<String>("lavfi-complex")
            .unwrap_or_else(|_| "<unreadable>".into());
        if echoed != graph {
            crate::log!(
                "playback:lavfi",
                "WARN: echoed back DIFFERENT from sent. sent_len={} echoed_len={}",
                graph.len(),
                echoed.len()
            );
            crate::log!("playback:lavfi", "echoed:\n{echoed}");
        } else {
            crate::log!(
                "playback:lavfi",
                "echoed back identical ({} bytes)",
                echoed.len()
            );
        }

        // Reload the same file with start=<position> so the seek happens as
        // part of the load and we don't get a black flash.
        let start_opt = format!("start={position:.3}");
        mpv_command_array(
            mpv.ctx.as_ptr(),
            &["loadfile", &path, "replace", "-1", &start_opt],
        )
        .map_err(|e| format!("loadfile (overlay reload) failed: {e}"))?;

        // Restore pause state — loadfile defaults to playing.
        if paused {
            let _ = mpv.set_property("pause", true);
        }

        Ok(())
    }
}

#[cfg(target_os = "windows")]
pub(crate) mod video_subclass {
    //! Two responsibilities on Windows:
    //!
    //! 1. **Intermediate window**: a STATIC-class child of the Tauri main
    //!    window that libmpv embeds into via `wid`. We resize this from the
    //!    frontend's reported video-area rect; libmpv tracks the intermediate
    //!    and renders to fit.
    //!
    //! 2. **Right-click forwarding**: libmpv's render window is itself a child
    //!    of the intermediate. We subclass it (replace WNDPROC) to catch
    //!    WM_RBUTTONUP and emit a Tauri event with the local coords. The
    //!    React layer then opens its own context menu at the right spot.
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::OnceLock;
    use tauri::{AppHandle, Emitter};
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, EnumChildWindows, GetClientRect, GetWindowLongW,
        GetWindowRect, IsWindowVisible, SetWindowLongPtrW, SetWindowPos, GWL_STYLE, GWLP_WNDPROC,
        SWP_NOACTIVATE, SWP_NOZORDER, WM_LBUTTONUP, WM_RBUTTONUP, WS_CHILD, WS_VISIBLE,
    };

    type WndProcFn = unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT;

    static ORIG_WNDPROC: AtomicUsize = AtomicUsize::new(0);
    static SUBCLASSED_HWND: AtomicUsize = AtomicUsize::new(0);
    static INTERMEDIATE_HWND: AtomicUsize = AtomicUsize::new(0);
    static APP: OnceLock<AppHandle> = OnceLock::new();

    pub fn init(app: AppHandle) {
        let _ = APP.set(app);
    }

    pub fn create_intermediate(parent_raw: i64) -> usize {
        let parent = parent_raw as HWND;

        let mut rect = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        unsafe { GetClientRect(parent, &mut rect); }
        let width = (rect.right - rect.left).max(100);
        let height = (rect.bottom - rect.top).max(100);

        let class: Vec<u16> = "STATIC".encode_utf16().chain(std::iter::once(0)).collect();

        let intermediate = unsafe {
            CreateWindowExW(
                0,
                class.as_ptr(),
                std::ptr::null(),
                WS_CHILD | WS_VISIBLE,
                0,
                0,
                width,
                height,
                parent,
                std::ptr::null_mut(),
                GetModuleHandleW(std::ptr::null()),
                std::ptr::null(),
            )
        };
        INTERMEDIATE_HWND.store(intermediate as usize, Ordering::Release);
        intermediate as usize
    }

    /// Read back the intermediate HWND + the mpv-created grandchild HWND
    /// geometry, visibility, and style. If width or height is 0, the
    /// frontend's useVideoAreaReporter never sized the slot — that's the
    /// "decoder running, screen black" case. If WS_VISIBLE is missing,
    /// the HWND was created hidden and ShowWindow was never called.
    pub fn dump_hwnd_geometry(label: &str) {
        let intermediate = INTERMEDIATE_HWND.load(Ordering::Acquire) as HWND;
        if intermediate.is_null() {
            crate::log!("playback:hwnd", "{label} no intermediate HWND");
            return;
        }
        let mut wr = windows_sys::Win32::Foundation::RECT { left: 0, top: 0, right: 0, bottom: 0 };
        let mut cr = windows_sys::Win32::Foundation::RECT { left: 0, top: 0, right: 0, bottom: 0 };
        let (visible, style) = unsafe {
            GetWindowRect(intermediate, &mut wr);
            GetClientRect(intermediate, &mut cr);
            (IsWindowVisible(intermediate) != 0, GetWindowLongW(intermediate, GWL_STYLE))
        };
        crate::log!(
            "playback:hwnd",
            "{label} intermediate={:p} visible={visible} style=0x{:08x} screen_rect=({},{})-({},{}) [{}x{}] client=({}x{})",
            intermediate,
            style as u32,
            wr.left, wr.top, wr.right, wr.bottom,
            wr.right - wr.left, wr.bottom - wr.top,
            cr.right - cr.left, cr.bottom - cr.top,
        );

        let mut mpv_child: HWND = std::ptr::null_mut();
        unsafe {
            EnumChildWindows(
                intermediate,
                Some(find_first_child),
                &mut mpv_child as *mut HWND as LPARAM,
            );
        }
        if mpv_child.is_null() {
            crate::log!("playback:hwnd", "{label} NO mpv child HWND found inside intermediate — libmpv hasn't created its render window");
            return;
        }
        let mut mwr = windows_sys::Win32::Foundation::RECT { left: 0, top: 0, right: 0, bottom: 0 };
        let mut mcr = windows_sys::Win32::Foundation::RECT { left: 0, top: 0, right: 0, bottom: 0 };
        let (mvisible, mstyle) = unsafe {
            GetWindowRect(mpv_child, &mut mwr);
            GetClientRect(mpv_child, &mut mcr);
            (IsWindowVisible(mpv_child) != 0, GetWindowLongW(mpv_child, GWL_STYLE))
        };
        crate::log!(
            "playback:hwnd",
            "{label} mpv_child={:p} visible={mvisible} style=0x{:08x} screen_rect=({},{})-({},{}) [{}x{}] client=({}x{})",
            mpv_child,
            mstyle as u32,
            mwr.left, mwr.top, mwr.right, mwr.bottom,
            mwr.right - mwr.left, mwr.bottom - mwr.top,
            mcr.right - mcr.left, mcr.bottom - mcr.top,
        );
    }

    pub fn resize_intermediate(x: i32, y: i32, width: i32, height: i32) {
        let h = INTERMEDIATE_HWND.load(Ordering::Acquire) as HWND;
        if h.is_null() {
            return;
        }
        unsafe {
            SetWindowPos(
                h,
                std::ptr::null_mut(),
                x,
                y,
                width,
                height,
                SWP_NOZORDER | SWP_NOACTIVATE,
            );
        }
    }

    pub fn ensure_subclassed() {
        let intermediate = INTERMEDIATE_HWND.load(Ordering::Acquire) as HWND;
        if intermediate.is_null() {
            return;
        }

        let mut found: HWND = std::ptr::null_mut();
        unsafe {
            EnumChildWindows(
                intermediate,
                Some(find_first_child),
                &mut found as *mut HWND as LPARAM,
            );
        }
        if found.is_null() {
            return;
        }

        let existing = SUBCLASSED_HWND.load(Ordering::Acquire);
        if existing == found as usize {
            return;
        }

        unsafe {
            let orig = SetWindowLongPtrW(found, GWLP_WNDPROC, video_wndproc as isize);
            if orig != 0 && orig != video_wndproc as isize {
                ORIG_WNDPROC.store(orig as usize, Ordering::Release);
            }
            SUBCLASSED_HWND.store(found as usize, Ordering::Release);
        }
    }

    unsafe extern "system" fn find_first_child(hwnd: HWND, lparam: LPARAM) -> i32 {
        let out = lparam as *mut HWND;
        unsafe { *out = hwnd; }
        0
    }

    unsafe extern "system" fn video_wndproc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if msg == WM_RBUTTONUP {
            let x = (lparam & 0xFFFF) as i16 as i32;
            let y = ((lparam >> 16) & 0xFFFF) as i16 as i32;
            if let Some(app) = APP.get() {
                let _ = app.emit("video-context-menu", serde_json::json!({ "x": x, "y": y }));
            }
        }
        // Left-click on the libmpv HWND → forward to frontend as a Tauri
        // event. Player Mode uses this to toggle pause/play. The frontend
        // decides whether to act on it (it's a no-op in Creator Mode).
        if msg == WM_LBUTTONUP {
            if let Some(app) = APP.get() {
                let _ = app.emit("video-click", serde_json::json!({}));
            }
        }

        let orig = ORIG_WNDPROC.load(Ordering::Acquire);
        if orig != 0 {
            let orig_proc: WndProcFn = unsafe { std::mem::transmute(orig) };
            unsafe { orig_proc(hwnd, msg, wparam, lparam) }
        } else {
            unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
        }
    }
}
