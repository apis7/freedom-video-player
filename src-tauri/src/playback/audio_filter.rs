//! Builds the `--lavfi-complex` filter-graph string that implements
//! `MuteDialogue` and `AudioBlur` snips.
//!
//! Architecture: same `asplit` + `amix` pattern as `audio_replace`:
//!
//!   `[aid1]` is split into one MAIN branch + N EFFECT branches (one per
//!   snip). The main branch carries the dry audio with volume-gates that
//!   crossfade to 0 across each snip window. Each effect branch carries
//!   a processed copy of the main audio (mute-dialogue or blur filters
//!   applied) gated to be ACTIVE only across the snip window with
//!   matching crossfades. amix the lot, normalize=0 so the gates' sum
//!   stays at unity.
//!
//! No source-content lookups, no atrim/asetpts, no second decoder —
//! these effects derive entirely from the main audio stream. Much
//! simpler than `audio_replace`. Crossfade is fixed at 200 ms to keep
//! the transition smooth without being noticeably slow.
//!
//! This module is INDEPENDENT of `audio_replace`. For v1, the orchestrator
//! picks one or the other based on which kind of snip dominates the
//! active profile. Mixing both kinds in one profile means the
//! audio_replace path wins and mute/blur snips degrade to silence (the
//! main branch is muted during their windows; no effect branch is
//! produced). That's acceptable degradation — a future v2 can unify.

use crate::profile::format::{Snip, SnipAction};

const CROSSFADE_MS: u64 = 200;

pub struct EffectInputs<'a> {
    pub file_duration_ms: u64,
    pub snips: &'a [Snip],
}

pub enum EffectGraph {
    Graph(String),
    /// No applicable snips — caller should clear lavfi-complex.
    None,
}

#[derive(Debug, Clone)]
struct PlannedEffect {
    start_ms: u64,
    end_ms: u64,
    xfade_ms: u64,
    kind: EffectKind,
}

#[derive(Debug, Clone)]
enum EffectKind {
    MuteDialogue { mode: String, intensity: u8 },
    AudioBlur { mode: String, intensity: u8 },
}

#[derive(Debug, Clone)]
struct PlannedCrop {
    start_ms: u64,
    end_ms: u64,
    x_pct: f32,
    y_pct: f32,
    w_pct: f32,
    h_pct: f32,
}

pub fn build(inputs: EffectInputs) -> EffectGraph {
    let mut planned: Vec<PlannedEffect> = Vec::new();
    let mut crops: Vec<PlannedCrop> = Vec::new();
    for snip in inputs.snips {
        if snip.end_ms <= snip.start_ms {
            continue;
        }
        match &snip.action {
            SnipAction::MuteDialogue { mode, intensity } => {
                let half_dur = (snip.end_ms - snip.start_ms) / 2;
                let xfade_ms = CROSSFADE_MS.min(half_dur);
                if snip.start_ms < xfade_ms
                    || snip.end_ms + xfade_ms > inputs.file_duration_ms
                {
                    crate::log!(
                        "overlay",
                        "audio_filter: snip {} at boundary — dropping",
                        snip.id
                    );
                    continue;
                }
                planned.push(PlannedEffect {
                    start_ms: snip.start_ms,
                    end_ms: snip.end_ms,
                    xfade_ms,
                    kind: EffectKind::MuteDialogue {
                        mode: mode.clone(),
                        intensity: *intensity,
                    },
                });
            }
            SnipAction::AudioBlur { mode, intensity } => {
                // garbled_slice is intended to be handled offline via a
                // precompute-at-open pipeline (libmpv encode → in-Rust
                // slice/reverse → audio_replace overlay swap). That
                // pipeline is NOT yet wired — for now the runtime drops
                // garbled_slice snips here, which means the apply
                // engine sees no overlay engaged for them and falls
                // back to plain silence (the existing audio_blur
                // silence-fallback). Logs loudly so users know what's
                // going on.
                if mode == "garbled_slice" {
                    crate::log!(
                        "overlay",
                        "audio_filter: snip {} uses garbled_slice — precompute pipeline NOT YET WIRED, falling back to silence",
                        snip.id
                    );
                    continue;
                }
                let half_dur = (snip.end_ms - snip.start_ms) / 2;
                let xfade_ms = CROSSFADE_MS.min(half_dur);
                if snip.start_ms < xfade_ms
                    || snip.end_ms + xfade_ms > inputs.file_duration_ms
                {
                    crate::log!(
                        "overlay",
                        "audio_filter: snip {} at boundary — dropping",
                        snip.id
                    );
                    continue;
                }
                planned.push(PlannedEffect {
                    start_ms: snip.start_ms,
                    end_ms: snip.end_ms,
                    xfade_ms,
                    kind: EffectKind::AudioBlur {
                        mode: mode.clone(),
                        intensity: *intensity,
                    },
                });
            }
            SnipAction::CropVideo {
                x_pct,
                y_pct,
                w_pct,
                h_pct,
            } => {
                crops.push(PlannedCrop {
                    start_ms: snip.start_ms,
                    end_ms: snip.end_ms,
                    x_pct: *x_pct,
                    y_pct: *y_pct,
                    w_pct: *w_pct,
                    h_pct: *h_pct,
                });
            }
            _ => continue,
        }
    }

    if planned.is_empty() && crops.is_empty() {
        return EffectGraph::None;
    }
    planned.sort_by_key(|p| p.start_ms);
    crops.sort_by_key(|c| c.start_ms);

    crate::log!(
        "overlay",
        "audio_filter: planning {} effect snip(s) + {} crop snip(s)",
        planned.len(),
        crops.len()
    );
    EffectGraph::Graph(render_graph(&planned, &crops))
}

fn render_graph(snips: &[PlannedEffect], crops: &[PlannedCrop]) -> String {
    let mut out = String::new();

    // Video branch — crop snips.
    //
    // First implementation chained
    //     [vid1] crop=...:enable='between(t,A,B)' [vo]
    // but ffmpeg refuses that:
    //     "Timeline ('enable' option) not supported with filter 'crop'"
    // because crop CHANGES the output dimensions and timeline editing
    // requires the output size to be constant across the timeline.
    //
    // The fix: split the video, run crop+scale-back on the side
    // branch (producing a "zoomed view" that's the same dimensions as
    // the main branch), then OVERLAY the zoomed branch on top of main
    // with enable='between(t,A,B)'. overlay DOES support timeline
    // editing, so when the snip window is active the user sees the
    // zoomed view; outside the window they see the original frame.
    // Output dimensions are constant (= main input dimensions), so
    // ffmpeg accepts the graph.
    //
    // For N crops we split into N+1 branches, build a zoomed view per
    // crop, then chain N overlays — each gated by its own enable
    // window. Non-overlapping snips means at most one overlay is
    // active at any t; an overlap (UI prevents) means the last one in
    // the chain wins.
    if crops.is_empty() {
        out.push_str("[vid1] null [vo];\n");
    } else {
        // 1. split into 1 main + N crop branches.
        out.push_str(&format!("[vid1] split={}", crops.len() + 1));
        out.push_str(" [vmain]");
        for idx in 0..crops.len() {
            out.push_str(&format!(" [c{}_in]", idx + 1));
        }
        out.push_str(";\n");
        // 2. per crop: crop then scale BACK to original dimensions.
        // After crop, current iw = orig_iw * w_pct; dividing by w_pct
        // brings us back to orig_iw. trunc(.../2)*2 keeps dimensions
        // even — required by many codecs / scalers and harmless on
        // already-even inputs.
        for (idx, c) in crops.iter().enumerate() {
            out.push_str(&format!(
                "[c{n}_in] crop=w='iw*{w:.4}':h='ih*{h:.4}':x='iw*{x:.4}':y='ih*{y:.4}',\
                 scale=w='trunc(iw/{w:.4}/2)*2':h='trunc(ih/{h:.4}/2)*2',\
                 setsar=1 [czoom{n}];\n",
                n = idx + 1,
                w = c.w_pct,
                h = c.h_pct,
                x = c.x_pct,
                y = c.y_pct,
            ));
        }
        // 3. overlay chain. Each overlay places its czoom on top of
        // the running stream, gated by its time window. Output of
        // the final overlay is [vo].
        let mut prev = String::from("vmain");
        for (idx, c) in crops.iter().enumerate() {
            let start = ms_to_secs_str(c.start_ms);
            let end = ms_to_secs_str(c.end_ms);
            let next = if idx + 1 == crops.len() {
                String::from("vo")
            } else {
                format!("ov{}", idx + 1)
            };
            out.push_str(&format!(
                "[{prev}][czoom{n}] overlay=x=0:y=0:enable='between(t,{start},{end})' [{next}];\n",
                n = idx + 1
            ));
            prev = next;
        }
    }

    // If we have ONLY crops and no audio effects, the rest of the
    // graph collapses to a simple audio pass-through.
    if snips.is_empty() {
        out.push_str("[aid1] anull [ao]");
        return out;
    }

    // Split [aid1] into 1 main + N effect branches.
    out.push_str(&format!("[aid1] asplit={}", snips.len() + 1));
    out.push_str(" [main_in]");
    for idx in 0..snips.len() {
        out.push_str(&format!(" [e{}_in]", idx + 1));
    }
    out.push_str(";\n");

    // Build a single piecewise volume envelope per snip. Each envelope
    // evaluates to:
    //   0                          when t is outside [snip_start - xfade,
    //                                                 snip_end   + xfade]
    //   ramp 0→1 over xfade_ms     during the lead-in
    //   1                          during the snip itself
    //   ramp 1→0 over xfade_ms     during the lead-out
    //
    // Critical: we evaluate the WHOLE envelope inside a single volume
    // filter (no `enable=between(...)` wrapping). A volume filter with
    // `enable=false` PASSES THROUGH at unity gain, which is the wrong
    // direction for the effect branch — we'd leak the processed audio
    // (afftfilt / vibrato / chorus / ...) outside the snip window and
    // amix would double it up with the main signal forever. The
    // `if(between(t,…),…,0)` form explicitly returns 0 outside the
    // window so the effect branch is silent except when intended.
    let envelopes: Vec<String> = snips.iter().map(effect_envelope_expr).collect();

    // Main branch carries the DRY audio and ducks down to 0 inside each
    // snip window. main_env = clip(1 − Σ effect_env, 0, 1). The snips are
    // sorted by the planner; clipping defends against any future overlap.
    let main_expr = if envelopes.is_empty() {
        "1".to_string()
    } else {
        format!("clip(1-({}),0,1)", envelopes.join("+"))
    };
    out.push_str(&format!(
        "[main_in] volume=eval=frame:volume='{main_expr}' [main];\n"
    ));

    // One effect branch per snip: run the effect chain, then apply this
    // snip's envelope so the branch contributes audio ONLY inside its
    // own [start − xfade, end + xfade] window.
    for (idx, p) in snips.iter().enumerate() {
        let effect_chain = effect_filter_chain(&p.kind);
        let env_expr = &envelopes[idx];
        out.push_str(&format!(
            "[e{n}_in] {effect_chain}, \
             volume=eval=frame:volume='{env_expr}' \
             [eff{n}];\n",
            n = idx + 1,
        ));
    }

    // Mix main + all effect branches. normalize=0 because our envelopes
    // already sum to 1 across every t — the post-amix level matches
    // the dry signal everywhere.
    out.push_str("[main]");
    for idx in 0..snips.len() {
        out.push_str(&format!("[eff{}]", idx + 1));
    }
    out.push_str(&format!(
        " amix=inputs={}:normalize=0:dropout_transition=0 [ao]",
        snips.len() + 1,
    ));

    out
}

/// Returns the piecewise envelope expression for a single planned effect:
/// 0 outside the [start − xfade, end + xfade] window, linear ramps at the
/// edges, 1 inside the snip itself. Suitable as the inner `volume=`
/// expression of a single volume filter (no enable= needed).
fn effect_envelope_expr(p: &PlannedEffect) -> String {
    let fade_in_start = ms_to_secs_str(p.start_ms - p.xfade_ms);
    let snip_start = ms_to_secs_str(p.start_ms);
    let snip_end = ms_to_secs_str(p.end_ms);
    let fade_out_end = ms_to_secs_str(p.end_ms + p.xfade_ms);
    let xfade_s = ms_to_secs_str(p.xfade_ms);
    format!(
        "if(between(t,{fis},{ss}),(t-{fis})/{xf},if(between(t,{ss},{se}),1,if(between(t,{se},{foe}),({foe}-t)/{xf},0)))",
        fis = fade_in_start,
        ss = snip_start,
        se = snip_end,
        foe = fade_out_end,
        xf = xfade_s,
    )
}

/// Produce the FFmpeg filter chain for a single effect kind. Returned
/// string is the chain ONLY (no input/output label brackets) — caller
/// wraps it with the input label and the gate chain.
fn effect_filter_chain(kind: &EffectKind) -> String {
    match kind {
        EffectKind::MuteDialogue { mode, intensity } => mute_dialogue_chain(mode, *intensity),
        EffectKind::AudioBlur { mode, intensity } => audio_blur_chain(mode, *intensity),
    }
}

/// Mute-dialogue chain. Best-effort dialogue removal.
///
/// - "auto"           → use stereo_cancel; falls back gracefully on mono
///   (subtracts the signal from itself producing silence, which is
///   acceptable degradation).
/// - "center_channel" → downmix that drops the center channel. Requires
///   a multichannel input (channelmap drops if mono/stereo).
/// - "stereo_cancel"  → subtract one channel from the other. Best on
///   stereo with centered dialogue.
fn mute_dialogue_chain(mode: &str, intensity: u8) -> String {
    // Intensity scales the SUBTRACTION amount for stereo_cancel modes.
    // 100 → full subtract; 50 → half-subtract (gentler, less collateral).
    let i = (intensity as f64 / 100.0).clamp(0.0, 1.0);
    match mode {
        "center_channel" => {
            // Drop the center channel from a 5.1 layout, downmix to stereo.
            // pan supports a per-output expression. If input is already
            // stereo, this just passes L/R through (no-op).
            // 5.1 channel order in FFmpeg: FL, FR, FC, LFE, BL, BR
            // We weight FL/FR full + back channels mixed in for ambience.
            "pan=stereo|c0=FL+0.5*BL+0.5*SL|c1=FR+0.5*BR+0.5*SR".to_string()
        }
        _ => {
            // stereo_cancel / auto — subtract opposite channel.
            // intensity I: c0' = c0 - I*c1  ; c1' = c1 - I*c0
            // Normalize gain back up by 1/(1+I*0.5) so the result isn't
            // noticeably quieter at high intensity.
            let gain = 1.0 / (1.0 + i * 0.5);
            format!(
                "pan=stereo|c0={g:.4}*c0-{gi:.4}*c1|c1={g:.4}*c1-{gi:.4}*c0",
                g = gain,
                gi = gain * i
            )
        }
    }
}

/// Audio-blur chain. Three presets — all tuned to make SPEECH
/// unrecognizable, not merely "muffled-but-readable." Earlier passes
/// were too gentle and the user could still hear specific words
/// (including the swearing the snip was supposed to scrub). These
/// chains aim for "you can tell something is happening, but you can't
/// identify any word."
///
/// - "muffled"       → very-low lowpass + highpass + dense echo. Kills
///   the 1–4 kHz band where consonants live.
/// - "garbled_grain" → vibrato + flanger + chorus + tremolo + bitcrush.
///   Drunken/swimmy texture; formant structure scrambled per cycle.
/// - "garbled_phase" → FFT scramble of BOTH magnitude AND phase per
///   bin, plus lowpass to nuke fricative bands. Spectral envelope is
///   destroyed (was preserved in v1 — that's why words were still
///   identifiable: timbre survives a phase-only scramble).
fn audio_blur_chain(mode: &str, intensity: u8) -> String {
    let i = (intensity as f64 / 100.0).clamp(0.0, 1.0);
    match mode {
        "garbled_grain" => {
            // Stack of modulators that each shred a different cue:
            //  - vibrato:  pitch warble (formant tracking → chaos)
            //  - flanger:  comb-filter sweep (cancels narrow bands)
            //  - chorus:   multi-voice smear (phoneme onset blur)
            //  - tremolo:  amplitude chop (syllable boundaries gone)
            //  - acrusher: bit-depth reduction (granular harshness)
            // Intensity scales depth + rate aggressively.
            let depth = 0.6 + 0.4 * i; // 0.6 → 1.0 (was 0.3..1.0)
            let f_hz = 9.0 + 11.0 * i; // 9 → 20 Hz (was 5..15)
            let trem_f = 18.0 + 12.0 * i; // 18 → 30 Hz syllable shredder
            let bits = (8.0 - 4.0 * i).round() as u32; // 8 → 4 bit
            format!(
                "vibrato=f={f_hz:.2}:d={depth:.3},\
                 flanger=delay=20:depth=10:width=95:speed=2.5,\
                 chorus=0.6:0.9:50|60|70|80:0.4|0.45|0.5|0.55:0.5|0.6|0.7|0.8:2|2.5|3|3.5,\
                 tremolo=f={trem_f:.2}:d=0.9,\
                 acrusher=level_in=1:level_out=1:bits={bits}:mode=log:mix=0.7"
            )
        }
        "garbled_phase" => {
            // FFT scramble of BOTH magnitude AND phase. The v1 version
            // only randomized phase, which preserves the spectral
            // envelope — the listener's brain reconstructs vowels from
            // the magnitudes and "hears" the word. Multiplying the
            // magnitude by random(1) before re-emitting destroys that
            // cue too. Follow-up lowpass kills the 4–8 kHz fricative
            // band (s/sh/f) so consonants are unrecoverable.
            let _ = i;
            "afftfilt=real='hypot(re,im)*random(1)*cos(random(0)*2*PI)':\
             imag='hypot(re,im)*random(1)*sin(random(0)*2*PI)',\
             lowpass=f=1500,\
             aecho=0.6:0.5:40|80:0.6|0.4"
                .to_string()
        }
        _ => {
            // "muffled" — the underwater preset. Drop the lowpass cutoff
            // hard (down to 220 Hz at full intensity — was 300) and add
            // a highpass so the result isn't a wall of sub-bass. Pile on
            // two echo stages with offset delays for a chamber feel.
            // Net effect at intensity 100: the listener can tell someone
            // is speaking but cannot pick out individual phonemes.
            let cutoff = (1200.0 - 980.0 * i).round() as u32; // 1200 → 220 Hz
            let hp = 90; // remove sub rumble
            let d1 = (40.0 + 60.0 * i).round() as u32; // 40 → 100 ms
            let d2 = (90.0 + 100.0 * i).round() as u32; // 90 → 190 ms
            let decay1 = 0.65 + 0.25 * i;
            let decay2 = 0.45 + 0.35 * i;
            format!(
                "highpass=f={hp},\
                 lowpass=f={cutoff},\
                 aecho=0.75:0.8:{d1}|{d2}:{decay1:.2}|{decay2:.2}"
            )
        }
    }
}

fn ms_to_secs_str(ms: u64) -> String {
    let whole = ms / 1000;
    let frac = ms % 1000;
    format!("{whole}.{frac:03}")
}
