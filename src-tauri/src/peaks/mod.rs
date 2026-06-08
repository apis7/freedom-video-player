//! Audio peak waveform extraction.
//!
//! Builds a `<stem>.fvp-peaks.bin` sidecar next to the video that the Creator
//! timeline can render as a ghost background under the snip lane. Computation
//! runs in libmpv's encode mode — `--no-video --ao=null --o=<temp.wav>` — and
//! we stream-parse the resulting PCM into one peak per 10 ms. Sidecar is
//! mtime-checked so we never recompute when a fresh one exists.
//!
//! Throttled by design: peaks are a nice-to-have, not load-bearing. We pin
//! audio decode to a single thread, skip video decode entirely, and gate all
//! computes behind a global mutex so only one peaks job runs at a time.

use libmpv2::Mpv;
use libmpv2_sys::mpv_command;
use std::ffi::CString;
use std::os::raw::c_char;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// One peak per 10 ms. At 100 px / s timeline zoom this lines up roughly 1:1
/// with screen pixels; at deeper zooms multiple pixels share a peak (fine).
pub const PEAKS_PER_SECOND: u32 = 100;
/// Mono PCM sample rate libmpv resamples to before we bin into peaks. Low
/// enough that audio decode is cheap; high enough that 10 ms buckets get
/// meaningful samples (80 samples per bucket).
const SOURCE_SAMPLE_RATE: u32 = 8000;
const SAMPLES_PER_PEAK: u32 = SOURCE_SAMPLE_RATE / PEAKS_PER_SECOND;
const FORMAT_MAGIC: &[u8; 4] = b"FVPP";
const FORMAT_VERSION: u8 = 1;
const HEADER_LEN: usize = 24;

/// Global single-flight gate. Multiple file-opens in quick succession won't
/// stack concurrent encodes (which would fight for the same CPU + disk). The
/// later compute just waits — by the time it runs, the cache check at the
/// top usually short-circuits because the earlier one finished.
static PEAKS_LOCK: Mutex<()> = Mutex::new(());

/// `/dir/movie.mp4` → `Some("/dir/movie.fvp-peaks.bin")`. Returns None when
/// the path has no parent or stem (rare; root paths or paths ending in `/`).
pub fn peaks_path_for(video_path: &Path) -> Option<PathBuf> {
    let parent = video_path.parent()?;
    let stem = video_path.file_stem()?;
    let mut name = stem.to_owned();
    name.push(".fvp-peaks.bin");
    Some(parent.join(name))
}

/// True when the peaks sidecar exists and is at least as new as the video.
/// Stale peaks (video re-encoded since) are treated as missing.
pub fn peaks_are_fresh(video_path: &Path, peaks_path: &Path) -> bool {
    let (Ok(vmd), Ok(pmd)) = (
        std::fs::metadata(video_path),
        std::fs::metadata(peaks_path),
    ) else {
        return false;
    };
    let (Ok(vmt), Ok(pmt)) = (vmd.modified(), pmd.modified()) else {
        return false;
    };
    pmt >= vmt
}

#[derive(Debug, Clone)]
pub struct LoadedPeaks {
    pub peaks_per_second: u32,
    pub duration_ms: u64,
    pub peaks: Vec<u8>,
}

/// Parse the binary peaks sidecar. Format:
///   [0..4)   magic "FVPP"
///   [4]      version (1)
///   [5]      bytes_per_peak (1)
///   [6..8)   reserved
///   [8..16)  duration_ms (u64 LE)
///   [16..20) peaks_per_second (u32 LE)
///   [20..24) peak_count (u32 LE)
///   [24..)   peaks (one byte each, 0..=255)
pub fn parse_peaks(bytes: &[u8]) -> Result<LoadedPeaks, String> {
    if bytes.len() < HEADER_LEN {
        return Err(format!("peaks file too small ({} bytes)", bytes.len()));
    }
    if &bytes[0..4] != FORMAT_MAGIC {
        return Err("peaks file bad magic".into());
    }
    if bytes[4] != FORMAT_VERSION {
        return Err(format!("peaks file unknown version {}", bytes[4]));
    }
    if bytes[5] != 1 {
        return Err(format!("peaks file unsupported bytes_per_peak {}", bytes[5]));
    }
    let duration_ms = u64::from_le_bytes(bytes[8..16].try_into().unwrap());
    let peaks_per_second = u32::from_le_bytes(bytes[16..20].try_into().unwrap());
    let peak_count = u32::from_le_bytes(bytes[20..24].try_into().unwrap()) as usize;
    if bytes.len() < HEADER_LEN + peak_count {
        return Err(format!(
            "peaks file truncated: header says {peak_count} peaks but only {} bytes after header",
            bytes.len().saturating_sub(HEADER_LEN)
        ));
    }
    Ok(LoadedPeaks {
        peaks_per_second,
        duration_ms,
        peaks: bytes[HEADER_LEN..HEADER_LEN + peak_count].to_vec(),
    })
}

/// Compute peaks for `video_path` and write the sidecar. Idempotent: if a
/// fresh sidecar exists, returns immediately without touching libmpv.
///
/// Emits `fvp:peaks-progress` events as { video_path, percent } during the
/// encode. Caller is responsible for emitting `fvp:peaks-done` / -failed.
pub fn compute_peaks_for_file(
    app: &AppHandle,
    video_path: &Path,
) -> Result<PathBuf, String> {
    let Some(peaks_path) = peaks_path_for(video_path) else {
        return Err("video path has no parent or file stem".into());
    };
    if peaks_are_fresh(video_path, &peaks_path) {
        crate::log!("peaks", "cache hit: {}", peaks_path.display());
        return Ok(peaks_path);
    }

    // Single-flight. If another compute is mid-run, queue behind it.
    let _guard = PEAKS_LOCK.lock().map_err(|e| format!("peaks lock: {e}"))?;
    // Re-check freshness in case the other compute was for the same file.
    if peaks_are_fresh(video_path, &peaks_path) {
        crate::log!(
            "peaks",
            "cache filled while waiting: {}",
            peaks_path.display()
        );
        return Ok(peaks_path);
    }

    crate::log!(
        "peaks",
        "start compute: {} → {}",
        video_path.display(),
        peaks_path.display()
    );
    let started = Instant::now();

    let path_str = video_path
        .to_str()
        .ok_or_else(|| "video path is not valid utf-8".to_string())?
        .to_string();
    let video_path_for_emit = path_str.clone();

    // Temp WAV with PID + nano-time so concurrent runs (single-flight gate
    // notwithstanding, just in case) don't clobber each other.
    let temp_name = format!(
        "fvp_peaks_{}_{}.wav",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let temp_wav = std::env::temp_dir().join(temp_name);
    let temp_str = temp_wav.to_string_lossy().into_owned();

    let source_duration_ms =
        match run_encode(&app.clone(), &path_str, &temp_str, &video_path_for_emit) {
            Ok(d) => d,
            Err(e) => {
                let _ = std::fs::remove_file(&temp_wav);
                return Err(e);
            }
        };

    let peaks = wav_to_peaks(&temp_wav).map_err(|e| {
        let _ = std::fs::remove_file(&temp_wav);
        e
    })?;
    let _ = std::fs::remove_file(&temp_wav);

    let duration_ms = (peaks.len() as u64) * 1000 / (PEAKS_PER_SECOND as u64);

    // Truncation guard. If we report fewer peaks than ~90% of the
    // source's container duration, the encode bailed early — almost
    // always due to a flaky network read or libmpv eof-reached firing
    // prematurely. Writing the sidecar in that state would poison the
    // cache (mtime check has no way to know it's incomplete; the next
    // load returns a 2-minute waveform for a 90-minute movie). Refuse
    // to write and propagate the error so the frontend stays in
    // "building" state and the user can retry.
    if source_duration_ms > 0 {
        let ratio = duration_ms as f64 / source_duration_ms as f64;
        if ratio < 0.90 {
            return Err(format!(
                "peaks truncated: covered {duration_ms}ms but source is {source_duration_ms}ms \
                 ({:.1}% — needs ≥90%). Refusing to write incomplete sidecar; will rebuild next time.",
                ratio * 100.0
            ));
        }
    }

    write_peaks_file(&peaks_path, &peaks, duration_ms)?;

    crate::log!(
        "peaks",
        "done in {:?} — {} peaks ({} ms duration) → {}",
        started.elapsed(),
        peaks.len(),
        duration_ms,
        peaks_path.display()
    );
    Ok(peaks_path)
}

/// Runs libmpv in encode-mode to dump audio PCM to `temp_wav_path`. Returns
/// the source's container duration in ms (read from libmpv as soon as it
/// becomes available) so the caller can sanity-check that we didn't bail
/// early. Returns Ok(0) if the duration property never resolved.
fn run_encode(
    app: &AppHandle,
    input_path: &str,
    temp_wav_path: &str,
    emit_path: &str,
) -> Result<u64, String> {
    // Transient libmpv tuned for "quietly grind in the background":
    //   - vid=no: never touch the video stream
    //   - ad-lavc-threads=1: single-threaded audio decode (one core max)
    //   - vo=null + ao=null: no display/audio output (encode mode handles it)
    //   - of=wav + oac=pcm_s16le: write s16le mono PCM at SOURCE_SAMPLE_RATE
    //   - lavfi aresample: force the target sample rate (audio-samplerate is
    //     a no-op in encode mode; only the filter graph respects it)
    let af = format!("lavfi=[aresample={SOURCE_SAMPLE_RATE}]");
    let mpv = Mpv::with_initializer(|init| {
        init.set_option("vo", "null")?;
        init.set_option("ao", "null")?;
        init.set_option("vid", "no")?;
        init.set_option("sid", "no")?;
        init.set_option("ad-lavc-threads", "1")?;
        init.set_option("o", temp_wav_path)?;
        init.set_option("of", "wav")?;
        init.set_option("oac", "pcm_s16le")?;
        init.set_option("ovc", "no")?;
        init.set_option("audio-channels", "mono")?;
        init.set_option("af", af.as_str())?;
        init.set_option("msg-level", "all=fatal")?;
        Ok(())
    })
    .map_err(|e| format!("libmpv init: {e:?}"))?;

    let handle = mpv.ctx.as_ptr();
    cmd_array(handle, &["loadfile", input_path])
        .map_err(|e| format!("loadfile {input_path}: {e}"))?;

    // Poll loop. Three completion signals, in order of reliability:
    //   1. eof-reached property flips true (fast path, when libmpv cooperates)
    //   2. Output WAV file size stops growing for >1.5s (most reliable —
    //      no false positives in encode mode; catches files where
    //      eof-reached stays false at end of stream)
    //   3. 30-min hard timeout (safety net)
    //
    // Earlier versions relied on a "playback-time stopped advancing past
    // 90 % of duration" heuristic — that hung at ~97 % on files whose audio
    // stream is shorter than the container-reported duration. The file-size
    // watchdog has no such failure mode.
    let temp_path = std::path::Path::new(temp_wav_path);
    let deadline = Instant::now() + Duration::from_secs(30 * 60);
    let size_idle_threshold = Duration::from_millis(1500);
    let mut last_emit = Instant::now();
    let mut last_pct = u32::MAX;
    let mut last_size: u64 = 0;
    let mut size_stable_since: Option<Instant> = None;
    let mut source_duration_ms: u64 = 0;
    loop {
        if Instant::now() > deadline {
            return Err("peaks encode timed out (>30 min)".into());
        }
        let eof: bool = mpv.get_property("eof-reached").unwrap_or(false);
        if eof {
            std::thread::sleep(Duration::from_millis(150));
            break;
        }

        // Output-size watchdog. Earlier versions trusted "size stable
        // for 1.5s = done" — but libmpv flushes its encode buffer in
        // chunks (1.5 MiB on Windows in practice). Between flushes the
        // file size sits still for several seconds while mpv is still
        // actively decoding the next chunk. Trusting the bare watchdog
        // truncated long files at the first chunk boundary.
        //
        // Now: a stable size only counts as "done" if playback-time is
        // also at least 95% of source duration. Otherwise it's just a
        // between-flush gap — keep polling. A 60s absolute stall ceiling
        // still breaks the loop so a genuinely hung decoder can't run
        // forever.
        let size = std::fs::metadata(temp_path).map(|m| m.len()).unwrap_or(0);
        if size > 0 && size == last_size {
            let started = size_stable_since.get_or_insert_with(Instant::now);
            if started.elapsed() > size_idle_threshold {
                let pos: f64 = mpv.get_property("playback-time").unwrap_or(0.0);
                let dur: f64 = mpv.get_property("duration").unwrap_or(0.0);
                let near_end = dur > 0.0 && pos >= dur * 0.95;
                let stalled_too_long = started.elapsed() > Duration::from_secs(60);
                if near_end || stalled_too_long {
                    let why = if near_end { "near end of source" } else { "60s hard stall ceiling reached" };
                    crate::log!(
                        "peaks",
                        "output size stable at {size} bytes at playback-time={:.1}s/{:.1}s ({why}), finalizing",
                        pos, dur
                    );
                    std::thread::sleep(Duration::from_millis(150));
                    break;
                }
            }
        } else {
            size_stable_since = None;
            last_size = size;
        }

        if last_emit.elapsed() > Duration::from_millis(300) {
            last_emit = Instant::now();
            let pos: f64 = mpv.get_property("playback-time").unwrap_or(0.0);
            let dur: f64 = mpv.get_property("duration").unwrap_or(0.0);
            if dur > 0.0 {
                if source_duration_ms == 0 {
                    source_duration_ms = (dur * 1000.0) as u64;
                }
                let pct = ((pos / dur) * 100.0).clamp(0.0, 99.0) as u32;
                if pct != last_pct {
                    last_pct = pct;
                    let _ = app.emit(
                        "fvp:peaks-progress",
                        serde_json::json!({
                            "video_path": emit_path,
                            "percent": pct,
                        }),
                    );
                }
            }
        }

        // 150 ms polling cadence — slow enough to be effectively idle on the
        // polling thread while libmpv's worker threads do the actual work.
        std::thread::sleep(Duration::from_millis(150));
    }

    drop(mpv);
    Ok(source_duration_ms)
}

fn wav_to_peaks(path: &Path) -> Result<Vec<u8>, String> {
    use std::io::{BufReader, Read, Seek, SeekFrom};
    let f = std::fs::File::open(path).map_err(|e| format!("open temp wav: {e}"))?;
    let mut r = BufReader::with_capacity(64 * 1024, f);
    let mut riff = [0u8; 12];
    r.read_exact(&mut riff).map_err(|e| format!("read RIFF: {e}"))?;
    if &riff[0..4] != b"RIFF" || &riff[8..12] != b"WAVE" {
        return Err("temp file is not WAVE".into());
    }
    // Scan chunks until we hit "data" — libmpv may emit a "fact" or other
    // chunk between "fmt " and "data" depending on codec settings.
    let data_size: u64 = loop {
        let mut hdr = [0u8; 8];
        if r.read_exact(&mut hdr).is_err() {
            return Err("no data chunk in temp wav".into());
        }
        let id = &hdr[0..4];
        let size = u32::from_le_bytes(hdr[4..8].try_into().unwrap()) as u64;
        if id == b"data" {
            break size;
        }
        r.seek_relative(size as i64)
            .map_err(|e| format!("skip chunk {:?}: {e}", std::str::from_utf8(id).ok()))?;
    };

    let samples_per_peak = SAMPLES_PER_PEAK as usize;
    let bytes_per_peak = samples_per_peak * 2; // s16 = 2 bytes
    let total_peaks = (data_size as usize) / bytes_per_peak;
    let mut peaks: Vec<u8> = Vec::with_capacity(total_peaks);
    let mut buf = vec![0u8; bytes_per_peak];

    // Read peak-by-peak. Each iteration consumes exactly bytes_per_peak from
    // the buffered reader; we take abs() of each i16 sample and keep the max,
    // then map 0..=32767 → 0..=255 via shift-right-7.
    for _ in 0..total_peaks {
        if r.read_exact(&mut buf).is_err() {
            // Trailing partial bucket — drop it; the timeline displays the
            // long whole-bucket sequence and a one-bucket gap at EOF is
            // invisible at every zoom level.
            break;
        }
        let mut peak: u16 = 0;
        for chunk in buf.chunks_exact(2) {
            let v = i16::from_le_bytes([chunk[0], chunk[1]]);
            // unsigned_abs returns u16, handling i16::MIN cleanly.
            let a = v.unsigned_abs();
            if a > peak {
                peak = a;
            }
        }
        peaks.push((peak >> 7).min(255) as u8);
    }

    Ok(peaks)
}

fn write_peaks_file(path: &Path, peaks: &[u8], duration_ms: u64) -> Result<(), String> {
    let mut buf = Vec::with_capacity(HEADER_LEN + peaks.len());
    buf.extend_from_slice(FORMAT_MAGIC);
    buf.push(FORMAT_VERSION);
    buf.push(1); // bytes_per_peak
    buf.push(0);
    buf.push(0); // reserved
    buf.extend_from_slice(&duration_ms.to_le_bytes());
    buf.extend_from_slice(&PEAKS_PER_SECOND.to_le_bytes());
    buf.extend_from_slice(&(peaks.len() as u32).to_le_bytes());
    buf.extend_from_slice(peaks);
    std::fs::write(path, &buf).map_err(|e| format!("write peaks file: {e}"))
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
