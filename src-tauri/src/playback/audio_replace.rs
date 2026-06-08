//! Builds the `--lavfi-complex` filter-graph string that implements true
//! audio overlay for `AudioReplace` snips.
//!
//! ### Architecture (asplit-based)
//!
//! We tee `[aid1]` into N+1 branches with `asplit`: one for the main audio
//! (with volume gating around each snip) and one per snip for the source
//! audio. Each source branch uses `atrim=start=…:end=…` to keep only the
//! file-time range of replacement content, then `asetpts` to shift those
//! frames to the global time at which the source should play, then `afade`
//! to fade in/out around the snip boundaries. `amix` sums all branches.
//!
//! Crossfade timing is OUTSIDE the snip: at snip start, main is already
//! fully muted and source is at 100%; at snip end, source fades out as
//! main fades back in. The full snip itself plays the source at unity.
//!
//! The whole graph is processed by libavfilter inside libmpv — no temp
//! files, no .free bloat, no second decoder. Graph is set via mpv's
//! `lavfi-complex` property; it takes effect on the next file (re)load.
//!
//! ### Graph shape (N snips):
//! ```text
//! [vid1] null [vo];
//! [aid1] asplit=N+1 [main_in] [s1_in] … [sN_in];
//! [main_in] volume(fade_out_window):volume(snip_mute):volume(fade_in_window) … [main];
//! [s1_in] atrim=start=SRC1_S:end=SRC1_E, asetpts=…+PLAY_START1/TB,
//!         afade=in:st=PLAY_START1:d=X1, afade=out:st=E1:d=X1 [src1];
//! …;
//! [main][src1]…[srcN] amix=inputs=N+1:normalize=0:dropout_transition=0 [ao]
//! ```
//!
//! ### Time math (per snip, with FADE OUTSIDE snip)
//! - duration `D = E - S`, crossfade `X = crossfade_ms`
//! - source play length `L = D + 2*X`
//! - global play window: source plays during `[S - X, E + X]`
//! - from_before: source content file range `[S + offset - L, S + offset]`
//!   (offset must be ≤ 0 so the range ends no later than the snip start)
//! - from_after:  source content file range `[E + offset, E + offset + L]`
//!   (offset must be ≥ 0 so the range starts no earlier than the snip end)
//!
//! ### Linear-playback limitation
//!
//! Because source frames flow from the SAME decoder as main (via asplit),
//! the source branch only sees frames when the demuxer linearly passes
//! through the source content's file-time range. If the user seeks PAST
//! the source range, `atrim` never emits for that snip and the source is
//! silent during the snip — main is still fully muted in the snip window,
//! so the user just hears a brief silence (effectively Skip). The
//! overlay-reload preserves position, so normal play-through-snip works.

use crate::profile::format::{Snip, SnipAction};

/// Input to the builder. The caller (Tauri command layer) translates the
/// app's snip list + file path into this and we produce the graph string.
#[derive(Debug, Clone)]
pub struct OverlayInputs<'a> {
    pub file_path: &'a str,
    pub file_duration_ms: u64,
    pub snips: &'a [Snip],
}

/// Outcome of building the graph. `None` means "no audio-replace work to
/// do" — caller should clear any existing overlay rather than apply.
#[derive(Debug, Clone, PartialEq)]
pub enum OverlayGraph {
    /// Filter graph string ready to feed to libmpv's `lavfi-complex`.
    Graph(String),
    /// No applicable audio-replace snips — caller should clear lavfi-complex.
    None,
}

/// Upper bound on an audio-replace snip's length. Longer snips degrade to
/// Skip (apply engine handles it). Beyond ~5 seconds, pulling that much
/// adjacent audio is rarely thematically coherent, and the amovie decoder
/// load + amix bookkeeping start to feel cumbersome.
pub const MAX_AUDIO_REPLACE_DURATION_MS: u64 = 5000;

/// Build the lavfi-complex graph. Skips any audio-replace snips that are
/// invalid, exceed `MAX_AUDIO_REPLACE_DURATION_MS`, or whose source range
/// falls outside the file (all fall back to apply-engine Skip behavior).
///
/// ── SECURITY NOTE — filter-graph injection ──
/// Numeric fields from `SnipAction::AudioReplace` are interpolated into a
/// shell-like filter-graph string. The Rust type system guarantees these
/// are `u32` / `i32` / `u64` (not user-typed strings), and `validate()`
/// in `profile/format.rs` clamps them to safe ranges before we ever get
/// here, so an attacker can't smuggle `;evil_filter;` through these
/// fields. If this code ever starts accepting STRING-typed fields from
/// a profile (e.g. a future per-snip curve name), they MUST be validated
/// against a strict allowlist before embedding — `format!()` does no
/// escaping. Same applies to `escape_path_for_amovie` if amovie usage
/// returns; the file path is internal but anything that comes from the
/// profile (filename label, etc.) needs explicit escape.
pub fn build(inputs: OverlayInputs) -> OverlayGraph {
    let mut planned: Vec<PlannedSnip> = Vec::new();
    let mut dropped_boundary = 0usize;
    let mut dropped_invalid = 0usize;
    let mut dropped_too_long = 0usize;
    let mut skipped_non_replace = 0usize;

    for snip in inputs.snips {
        let SnipAction::AudioReplace {
            from_before,
            offset_ms,
            crossfade_ms,
        } = snip.action
        else {
            skipped_non_replace += 1;
            continue;
        };

        if snip.end_ms <= snip.start_ms {
            crate::log!(
                "overlay",
                "DROP snip {} — invalid (end {} <= start {})",
                snip.id, snip.end_ms, snip.start_ms
            );
            dropped_invalid += 1;
            continue;
        }
        let duration_ms = snip.end_ms - snip.start_ms;

        if duration_ms > MAX_AUDIO_REPLACE_DURATION_MS {
            crate::log!(
                "overlay",
                "DROP snip {} — duration {duration_ms}ms exceeds cap {MAX_AUDIO_REPLACE_DURATION_MS}ms; falling back to Skip",
                snip.id
            );
            dropped_too_long += 1;
            continue;
        }

        let xfade_ms = crossfade_ms as u64;

        // FADE OUTSIDE THE SNIP: the snip itself is fully muted on main and
        // fully covered by source. The fade windows extend OUTWARD from
        // the snip edges so that, at the moment the snip begins, main is
        // already at 0 and source is already at 1 (and symmetrically at
        // snip end). This matches the user's mental model: "I'm cutting
        // out the snip's audio entirely; the crossfade happens around it,
        // not inside it."
        //
        // Source plays during global time [start - xfade, end + xfade].
        // Source content length = snip duration + 2 × xfade.
        // Source content range in file (must NOT overlap the snip itself):
        //   from_before: source ends at  snip_start + offset (offset ≤ 0)
        //   from_after:  source starts at snip_end + offset  (offset ≥ 0)
        let play_length_ms = duration_ms + 2 * xfade_ms;
        let (src_start_ms_signed, src_end_ms_signed) = if from_before {
            let end = snip.start_ms as i64 + offset_ms as i64;
            let start = end - play_length_ms as i64;
            (start, end)
        } else {
            let start = snip.end_ms as i64 + offset_ms as i64;
            let end = start + play_length_ms as i64;
            (start, end)
        };

        // Source range must fit inside the file. snip_start - xfade must
        // also be non-negative (source plays starting there).
        let play_start_signed = snip.start_ms as i64 - xfade_ms as i64;
        if src_start_ms_signed < 0
            || src_end_ms_signed > inputs.file_duration_ms as i64
            || play_start_signed < 0
        {
            crate::log!(
                "overlay",
                "DROP snip {} (from_before={from_before}, offset={offset_ms}ms, xfade={xfade_ms}ms) — source range [{src_start_ms_signed}, {src_end_ms_signed}]ms or play_start {play_start_signed}ms hits file boundary [0, {}]ms; falling back to Skip",
                snip.id,
                inputs.file_duration_ms
            );
            dropped_boundary += 1;
            continue;
        }

        planned.push(PlannedSnip {
            start_ms: snip.start_ms,
            end_ms: snip.end_ms,
            xfade_ms,
            src_start_ms: src_start_ms_signed as u64,
            src_play_length_ms: play_length_ms,
            play_start_ms: play_start_signed as u64,
        });
    }

    crate::log!(
        "overlay",
        "build summary: in={} non_replace={} kept={} dropped_boundary={} dropped_invalid={} dropped_too_long={}",
        inputs.snips.len(),
        skipped_non_replace,
        planned.len(),
        dropped_boundary,
        dropped_invalid,
        dropped_too_long
    );

    if planned.is_empty() {
        return OverlayGraph::None;
    }

    // Sort by start time so the main branch is in temporal order.
    planned.sort_by_key(|p| p.start_ms);

    // Detailed per-snip plan — paste-friendly when debugging audio bugs.
    for (i, p) in planned.iter().enumerate() {
        crate::log!(
            "overlay",
            "PLAN snip{}: main fade-out [{}..{}]ms | snip muted [{}..{}]ms | main fade-in [{}..{}]ms",
            i + 1,
            p.play_start_ms,
            p.start_ms,
            p.start_ms,
            p.end_ms,
            p.end_ms,
            p.end_ms + p.xfade_ms
        );
        crate::log!(
            "overlay",
            "           src content from file [{}..{}]ms ({}ms long) → plays at global [{}..{}]ms",
            p.src_start_ms,
            p.src_start_ms + p.src_play_length_ms,
            p.src_play_length_ms,
            p.play_start_ms,
            p.play_start_ms + p.src_play_length_ms
        );
    }

    OverlayGraph::Graph(render_graph(inputs.file_path, &planned))
}

/// A snip that has passed validation and is going to actually contribute
/// to the filter graph.
#[derive(Debug, Clone)]
struct PlannedSnip {
    start_ms: u64,
    end_ms: u64,
    xfade_ms: u64,
    src_start_ms: u64,
    src_play_length_ms: u64,
    play_start_ms: u64,
}

fn render_graph(_file_path: &str, snips: &[PlannedSnip]) -> String {
    // Architecture: ASPLIT-based source branching.
    //
    // We had been using `amovie` to open the file a second time as an
    // independent source for the replacement audio. That broke for two
    // reasons:
    //   1. amovie's decoder produced frames at its own pace (file I/O
    //      speed), independent of main playback. With the shifted PTS,
    //      amix should have buffered them until output time caught up —
    //      but in practice it was emitting them immediately, so the user
    //      heard the source content layered on top of main audio at
    //      random times (1129–1133s of audio playing at 0–4s, 4–8s, etc.).
    //   2. The path needed quoting/escaping inside the filter graph,
    //      which was a moving target across libavfilter versions.
    //
    // The asplit design avoids both. We tee the main aid1 stream into
    // N+1 branches: one for main, one per snip. Each source branch uses
    // `atrim=start=…:end=…` to keep ONLY the file-time range of the
    // replacement content, then `asetpts` to shift those frames to play
    // at the global time corresponding to the snip window. All branches
    // share the same decoder and timebase, so amix aligns them cleanly.
    //
    // Limitation: this is linear-playback-only. If the user seeks
    // PAST the source content's file-time range before the snip is
    // reached, atrim never emits frames for that snip and the source
    // branch stays silent (main is still muted during the snip → user
    // hears a brief Skip-like silence). The overlay-reload preserves
    // playback position via `loadfile … start=<pos>`, so playing through
    // snips works; only manual seek-past-then-play-forward exposes the
    // limitation.
    let mut out = String::new();

    // Video: straight pass-through.
    out.push_str("[vid1] null [vo];\n");

    // Split [aid1] into one main branch + N source branches.
    out.push_str(&format!("[aid1] asplit={}", snips.len() + 1));
    out.push_str(" [main_in]");
    for idx in 0..snips.len() {
        out.push_str(&format!(" [s{}_in]", idx + 1));
    }
    out.push_str(";\n");

    // Main audio: chain of `volume` filters per snip — three per snip
    // (fade-out, silent middle, fade-in). We use `volume` with `enable`
    // (instead of afade) because afade's gain persists FOREVER outside its
    // window: an afade=out at snip 1 leaves the chain at gain=0, and the
    // afade=in for snip 1's end then multiplies that 0 by its 0→1 ramp,
    // producing 0. Result: main goes silent permanently after the first
    // snip. `volume` with `enable` passes through (gain=1) outside its
    // window, so the original audio resumes cleanly between snips.
    //
    // Gain expressions are written in PAREN-FREE linear form
    // (`K - t/D` for fade-out, `t/D - K` for fade-in) — when wrapped in
    // single quotes, the quotes weren't being stripped before libavfilter's
    // expression parser saw them, producing NaN (which volume clips to 0,
    // killing the fade). Without parens we don't need quotes around the
    // volume expression, dodging the quote-stripping issue entirely.
    // `enable` still uses single quotes because `between(t,…,…)` contains
    // commas that would otherwise split the filter at the graph level.
    // `eval=frame` makes the gain expression re-evaluate every audio frame
    // so the ramps work.
    out.push_str("[main_in] ");
    let mut first = true;
    for p in snips {
        let xfade_s = ms_to_secs_str(p.xfade_ms);
        // Fade windows are OUTSIDE the snip now (per user spec):
        //   fade-out: [snip_start - xfade, snip_start]
        //   muted:    [snip_start, snip_end]            ← the snip itself
        //   fade-in:  [snip_end, snip_end + xfade]
        let fade_out_start = ms_to_secs_str(p.play_start_ms);
        let fade_out_end_ms = p.start_ms;
        let fade_out_end = ms_to_secs_str(fade_out_end_ms);
        let mute_start = fade_out_end.clone();
        let mute_end = ms_to_secs_str(p.end_ms);
        let fade_in_start_ms = p.end_ms;
        let fade_in_start = mute_end.clone();
        let fade_in_end = ms_to_secs_str(p.end_ms + p.xfade_ms);

        // Paren-free linear ramps:
        //   fade-out: gain(t) = (snip_start - t)/xfade   = K_out - t/xfade
        //   fade-in:  gain(t) = (t - snip_end)/xfade     = t/xfade - K_in
        let xfade_secs = p.xfade_ms as f64 / 1000.0;
        let k_out = fade_out_end_ms as f64 / 1000.0 / xfade_secs;
        let k_in = fade_in_start_ms as f64 / 1000.0 / xfade_secs;

        if !first {
            out.push_str(", ");
        }
        first = false;

        // Fade-out (1 → 0) ending exactly at snip start.
        out.push_str(&format!(
            "volume=eval=frame:enable='between(t,{fade_out_start},{fade_out_end})':volume={k_out:.6}-t/{xfade_s}, ",
        ));
        // Full mute across the entire snip.
        out.push_str(&format!(
            "volume=eval=frame:enable='between(t,{mute_start},{mute_end})':volume=0, ",
        ));
        // Fade-in (0 → 1) starting exactly at snip end.
        out.push_str(&format!(
            "volume=eval=frame:enable='between(t,{fade_in_start},{fade_in_end})':volume=t/{xfade_s}-{k_in:.6}",
        ));
    }
    out.push_str(" [main];\n");

    // One source branch per snip. Each branch:
    //   1. atrim=start=SRC_START:end=SRC_END  — keep only frames from the
    //      source content's file-time range (frames outside are dropped,
    //      so amix never sees them).
    //   2. asetpts=PTS-STARTPTS+PLAY_START/TB — shift first kept frame's
    //      PTS to the global time the source should begin playing
    //      (snip_start - xfade). Subsequent frames increment normally.
    //   3. afade in/out  — fade gain over the xfade windows OUTSIDE the
    //      snip itself, so at snip_start source is already at full and
    //      stays there through snip_end.
    //
    // Source fade timings (fade outside the snip):
    //   fade-in:  [snip_start - xfade, snip_start]   — source ramps 0 → 1
    //   full:     [snip_start, snip_end]             — source at 100%
    //   fade-out: [snip_end, snip_end + xfade]       — source ramps 1 → 0
    for (idx, p) in snips.iter().enumerate() {
        let src_start_s = ms_to_secs_str(p.src_start_ms);
        let src_end_s = ms_to_secs_str(p.src_start_ms + p.src_play_length_ms);
        let shift_s = ms_to_secs_str(p.play_start_ms);
        let xfade_s = ms_to_secs_str(p.xfade_ms);
        let fade_in_st = ms_to_secs_str(p.play_start_ms);
        let fade_out_st = ms_to_secs_str(p.end_ms);
        out.push_str(&format!(
            "[s{n}_in] atrim=start={src_start_s}:end={src_end_s}, \
             asetpts=PTS-STARTPTS+{shift_s}/TB, \
             afade=t=in:st={fade_in_st}:d={xfade_s}:curve=tri, \
             afade=t=out:st={fade_out_st}:d={xfade_s}:curve=tri \
             [src{n}];\n",
            n = idx + 1,
        ));
    }

    // Mix main + every source.
    out.push_str("[main]");
    for idx in 0..snips.len() {
        out.push_str(&format!("[src{}]", idx + 1));
    }
    out.push_str(&format!(
        " amix=inputs={}:normalize=0:dropout_transition=0 [ao]",
        snips.len() + 1,
    ));

    out
}

/// Format milliseconds as a seconds string with three decimal places. We
/// avoid scientific notation so ffmpeg parses cleanly.
fn ms_to_secs_str(ms: u64) -> String {
    let whole = ms / 1000;
    let frac = ms % 1000;
    format!("{whole}.{frac:03}")
}

// `escape_path_for_amovie` was removed when we switched from amovie to
// asplit. The graph no longer references the file path at all — source
// audio comes from the same decoder as main, just time-shifted.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile::format::Snip;

    fn ar_snip(start: u64, end: u64, from_before: bool, offset_ms: i32, xfade: u32) -> Snip {
        Snip {
            id: "x".into(),
            start_ms: start,
            end_ms: end,
            categories: vec![],
            action: SnipAction::AudioReplace {
                from_before,
                offset_ms,
                crossfade_ms: xfade,
            },
            group_id: None,
            note: None,
        }
    }

    fn skip_snip(start: u64, end: u64) -> Snip {
        Snip {
            id: "x".into(),
            start_ms: start,
            end_ms: end,
            categories: vec![],
            action: SnipAction::Skip,
            group_id: None,
            note: None,
        }
    }

    #[test]
    fn no_audio_replace_snips_returns_none() {
        let snips = [skip_snip(1000, 2000)];
        let result = build(OverlayInputs {
            file_path: "/x.mkv",
            file_duration_ms: 100_000,
            snips: &snips,
        });
        assert_eq!(result, OverlayGraph::None);
    }

    #[test]
    fn empty_snip_list_returns_none() {
        let result = build(OverlayInputs {
            file_path: "/x.mkv",
            file_duration_ms: 100_000,
            snips: &[],
        });
        assert_eq!(result, OverlayGraph::None);
    }

    #[test]
    fn boundary_snips_get_dropped() {
        // Snip 0-3s with from_before needs source from before t=0 — invalid.
        let snips = [ar_snip(0, 3000, true, 0, 1500)];
        let result = build(OverlayInputs {
            file_path: "/x.mkv",
            file_duration_ms: 100_000,
            snips: &snips,
        });
        assert_eq!(result, OverlayGraph::None);
    }

    #[test]
    fn snips_longer_than_cap_are_dropped() {
        // Snip > MAX_AUDIO_REPLACE_DURATION_MS (5000ms) should drop and fall
        // back to apply-engine Skip behavior.
        let snips = [ar_snip(20_000, 50_000, true, 0, 1500)]; // 30s — way over
        let result = build(OverlayInputs {
            file_path: "/x.mkv",
            file_duration_ms: 100_000,
            snips: &snips,
        });
        assert_eq!(result, OverlayGraph::None);
    }

    #[test]
    fn snip_at_cap_is_kept() {
        // Exactly at the cap — should still build.
        let snips = [ar_snip(20_000, 25_000, true, 0, 1500)]; // 5s exactly
        let result = build(OverlayInputs {
            file_path: "/x.mkv",
            file_duration_ms: 100_000,
            snips: &snips,
        });
        assert!(matches!(result, OverlayGraph::Graph(_)));
    }

    #[test]
    fn fade_windows_are_outside_snip() {
        // Snip @ [10s, 12s] with xfade 1.5s. Fade-out window should be
        // [8.5, 10] (before snip), mute window [10, 12] (the snip itself),
        // fade-in window [12, 13.5] (after snip).
        let snips = [ar_snip(10_000, 12_000, true, 0, 1500)];
        let result = build(OverlayInputs {
            file_path: "/x.mkv",
            file_duration_ms: 100_000,
            snips: &snips,
        });
        match result {
            OverlayGraph::Graph(s) => {
                let main_branch = s
                    .split_once("[aid1]")
                    .and_then(|(_, rest)| rest.split_once("[main];"))
                    .map(|(b, _)| b)
                    .expect("main branch not found");
                // Fade-out: starts at 8.500, ends at 10.000
                assert!(
                    main_branch.contains("between(t,8.500,10.000)"),
                    "fade-out window must be [snip_start - xfade, snip_start]: {main_branch}",
                );
                // Mute: full snip [10.000, 12.000]
                assert!(
                    main_branch.contains("between(t,10.000,12.000)"),
                    "mute window must equal the snip itself: {main_branch}",
                );
                // Fade-in: starts at 12.000, ends at 13.500
                assert!(
                    main_branch.contains("between(t,12.000,13.500)"),
                    "fade-in window must be [snip_end, snip_end + xfade]: {main_branch}",
                );
            }
            _ => panic!("expected Graph"),
        }
    }

    #[test]
    fn boundary_snip_dropped_but_others_kept() {
        let snips = [
            ar_snip(0, 3000, true, 0, 1500),         // drops
            ar_snip(50_000, 55_000, true, 0, 1500),  // keeps
        ];
        let result = build(OverlayInputs {
            file_path: "/x.mkv",
            file_duration_ms: 100_000,
            snips: &snips,
        });
        match result {
            OverlayGraph::Graph(s) => {
                assert!(s.contains("[src1]"));
                assert!(!s.contains("[src2]"));
            }
            _ => panic!("expected Graph"),
        }
    }

    #[test]
    fn from_after_source_range_is_after_snip() {
        // Snip 10-13s, from_after, offset=0, xfade=1.5s.
        // New model: source plays during [start - xfade, end + xfade]
        //          = [8.5s, 14.5s], length = 6.0s.
        // For from_after with offset=0, source content starts at snip_end:
        //   src_start = 13.000s, src_end = 13 + 6 = 19.000s.
        // asplit-based: atrim selects this range from main's timeline,
        // asetpts shifts to play starting at 8.500s.
        let snips = [ar_snip(10_000, 13_000, false, 0, 1500)];
        let result = build(OverlayInputs {
            file_path: "/x.mkv",
            file_duration_ms: 100_000,
            snips: &snips,
        });
        match result {
            OverlayGraph::Graph(s) => {
                assert!(
                    s.contains("atrim=start=13.000:end=19.000"),
                    "graph was: {s}"
                );
                assert!(
                    s.contains("asetpts=PTS-STARTPTS+8.500/TB"),
                    "graph was: {s}"
                );
            }
            _ => panic!("expected Graph"),
        }
    }

    #[test]
    fn xfade_is_no_longer_clamped_to_snip_duration() {
        // With fades OUTSIDE the snip, the xfade doesn't have to fit
        // inside the snip. A 0.5s snip with a 1.5s xfade should still
        // produce a 1.5s xfade on each side (1.5s out / 0.5s mute / 1.5s in).
        let snips = [ar_snip(10_000, 10_500, true, 0, 1500)];
        let result = build(OverlayInputs {
            file_path: "/x.mkv",
            file_duration_ms: 100_000,
            snips: &snips,
        });
        match result {
            OverlayGraph::Graph(s) => {
                assert!(s.contains(":d=1.500:curve=tri"), "graph was: {s}");
                // Volume ramp uses 1.500 as the divisor (full xfade).
                assert!(s.contains("/1.500"), "graph was: {s}");
            }
            _ => panic!("expected Graph"),
        }
    }

    #[test]
    fn main_branch_uses_volume_with_enable_not_afade() {
        // Regression: chained afade on main was setting gain=0 permanently
        // after the first snip's fade-out and silencing all later snips.
        // The fix is to use `volume eval=frame enable=between(...)` so the
        // gain returns to 1 outside each snip window.
        let snips = [
            ar_snip(10_000, 13_000, true, 0, 1500),
            ar_snip(50_000, 55_000, true, 0, 1500),
        ];
        let result = build(OverlayInputs {
            file_path: "/x.mkv",
            file_duration_ms: 100_000,
            snips: &snips,
        });
        match result {
            OverlayGraph::Graph(s) => {
                // Find the [main] branch (between "[aid1]" and "[main];").
                let main_branch = s
                    .split_once("[aid1]")
                    .and_then(|(_, rest)| rest.split_once("[main];"))
                    .map(|(b, _)| b)
                    .expect("main branch not found");
                assert!(
                    !main_branch.contains("afade"),
                    "main must NOT use afade (chain bug): {main_branch}",
                );
                // 3 volume filters per snip × 2 snips = 6 volume filters.
                // Each filter writes "volume=" twice (once for the filter
                // name with its `eval` arg, once for the `volume` option).
                assert_eq!(
                    main_branch.matches("volume=").count(),
                    12,
                    "main branch was: {main_branch}",
                );
                // `between()` is single-quoted so its commas don't split
                // the filter at the graph level.
                assert!(
                    main_branch.contains("enable='between(t,"),
                    "between() must be single-quoted: {main_branch}",
                );
            }
            _ => panic!("expected Graph"),
        }
    }

    #[test]
    fn volume_ramp_expression_is_paren_free() {
        // Regression chain (in order):
        //   1. Bare `(expr)` value caused "No option name near '(...)'"
        //   2. Single-quoting the expression made it parse but evaluate
        //      to NaN every frame (quotes weren't stripped before expr eval)
        //   3. Paren-free linear form `K - t/D` sidesteps both: no parens
        //      means no quoting needed, and the expression evaluates cleanly.
        let snips = [ar_snip(10_000, 13_000, true, 0, 1500)];
        let result = build(OverlayInputs {
            file_path: "/x.mkv",
            file_duration_ms: 100_000,
            snips: &snips,
        });
        match result {
            OverlayGraph::Graph(s) => {
                // Find the [main] branch.
                let main_branch = s
                    .split_once("[aid1]")
                    .and_then(|(_, rest)| rest.split_once("[main];"))
                    .map(|(b, _)| b)
                    .expect("main branch not found");
                assert!(
                    !main_branch.contains(":volume='("),
                    "volume expression must NOT be wrapped in single quotes \
                     (causes NaN due to quote-stripping issue): {main_branch}",
                );
                assert!(
                    !main_branch.contains(":volume=("),
                    "volume expression must NOT contain parens \
                     (filter-arg parser rejects bare parens): {main_branch}",
                );
                // Should contain paren-free `…-t/…` form for fade-out.
                assert!(
                    main_branch.contains("-t/1.500"),
                    "expected paren-free fade-out form: {main_branch}",
                );
                // And `t/…-…` form for fade-in.
                assert!(
                    main_branch.contains("volume=t/1.500-"),
                    "expected paren-free fade-in form: {main_branch}",
                );
            }
            _ => panic!("expected Graph"),
        }
    }

    #[test]
    fn graph_uses_asplit_not_amovie() {
        // Regression: when we used amovie, the file path had to be embedded
        // in the graph and frames were produced by an independent decoder
        // that didn't align with main playback timing. The asplit design
        // shares one decoder with main so timing is automatic.
        let snips = [ar_snip(50_000, 53_000, true, 0, 1500)];
        let result = build(OverlayInputs {
            file_path: r"C:\Users\Test User\movie.mkv",
            file_duration_ms: 100_000,
            snips: &snips,
        });
        match result {
            OverlayGraph::Graph(s) => {
                assert!(!s.contains("amovie="), "graph must not reference amovie: {s}");
                // Path should never appear in the graph either.
                assert!(!s.contains("/Users/"), "path must not appear in graph: {s}");
                // Should split aid1 into N+1 branches (main + 1 source).
                assert!(s.contains("asplit=2"), "graph was: {s}");
                assert!(s.contains("[main_in]") && s.contains("[s1_in]"));
            }
            _ => panic!("expected Graph"),
        }
    }

    #[test]
    fn file_path_no_longer_affects_graph() {
        // Path is now ignored by the renderer — different paths should
        // produce identical graphs for identical snip inputs.
        let snips = [ar_snip(50_000, 53_000, true, 0, 1500)];
        let g1 = build(OverlayInputs {
            file_path: "/x.mkv",
            file_duration_ms: 100_000,
            snips: &snips,
        });
        let g2 = build(OverlayInputs {
            file_path: r"C:\videos\foo, bar [1080p]=v2.mkv",
            file_duration_ms: 100_000,
            snips: &snips,
        });
        assert_eq!(g1, g2);
    }

    #[test]
    fn graph_routes_video_through_and_outputs_ao() {
        let snips = [ar_snip(10_000, 13_000, true, 0, 1500)];
        let result = build(OverlayInputs {
            file_path: "/x.mkv",
            file_duration_ms: 100_000,
            snips: &snips,
        });
        match result {
            OverlayGraph::Graph(s) => {
                assert!(s.starts_with("[vid1] null [vo];"));
                assert!(s.contains(" [ao]"));
                assert!(s.contains("amix=inputs=2:normalize=0:dropout_transition=0"));
            }
            _ => panic!("expected Graph"),
        }
    }

    #[test]
    fn multiple_snips_are_sorted_temporally() {
        // Pass snips out of order; rendering should put earliest first.
        // With fade-outside-snip, fade-out windows now start at
        // snip_start - xfade: 18.500, 48.500, 78.500.
        let snips = [
            ar_snip(50_000, 53_000, true, 0, 1500),
            ar_snip(20_000, 23_000, true, 0, 1500),
            ar_snip(80_000, 83_000, true, 0, 1500),
        ];
        let result = build(OverlayInputs {
            file_path: "/x.mkv",
            file_duration_ms: 100_000,
            snips: &snips,
        });
        match result {
            OverlayGraph::Graph(s) => {
                let p20 = s.find("18.500").expect("snip @20 fade-out start");
                let p50 = s.find("48.500").expect("snip @50 fade-out start");
                let p80 = s.find("78.500").expect("snip @80 fade-out start");
                assert!(p20 < p50 && p50 < p80, "main-branch fades out of order");
                // 3 asplit source branches; main + 3 sources → amix=4.
                assert_eq!(s.matches("[s1_in]").count(), 2); // asplit decl + atrim
                assert_eq!(s.matches("[s2_in]").count(), 2);
                assert_eq!(s.matches("[s3_in]").count(), 2);
                assert!(s.contains("asplit=4"));
                assert!(s.contains("amix=inputs=4"));
            }
            _ => panic!("expected Graph"),
        }
    }

    #[test]
    fn offset_shifts_source_range_earlier_for_from_before() {
        // Snip 50-53s, from_before, offset -2000ms, xfade 1500ms.
        // play_length = duration(3000) + 2*xfade(3000) = 6000ms
        // src_end = snip_start + offset = 50000 + (-2000) = 48000
        // src_start = 48000 - 6000 = 42000 → atrim start=42.000:end=48.000
        let snips = [ar_snip(50_000, 53_000, true, -2000, 1500)];
        let result = build(OverlayInputs {
            file_path: "/x.mkv",
            file_duration_ms: 100_000,
            snips: &snips,
        });
        match result {
            OverlayGraph::Graph(s) => {
                assert!(
                    s.contains("atrim=start=42.000:end=48.000"),
                    "graph was: {s}"
                );
            }
            _ => panic!("expected Graph"),
        }
    }
}
