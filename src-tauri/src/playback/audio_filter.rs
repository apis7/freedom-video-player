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

pub fn build(inputs: EffectInputs) -> EffectGraph {
    let mut planned: Vec<PlannedEffect> = Vec::new();
    for snip in inputs.snips {
        if snip.end_ms <= snip.start_ms {
            continue;
        }
        let kind = match &snip.action {
            SnipAction::MuteDialogue { mode, intensity } => EffectKind::MuteDialogue {
                mode: mode.clone(),
                intensity: *intensity,
            },
            SnipAction::AudioBlur { mode, intensity } => EffectKind::AudioBlur {
                mode: mode.clone(),
                intensity: *intensity,
            },
            _ => continue,
        };
        // Clamp the crossfade if the snip is short.
        let half_dur = (snip.end_ms - snip.start_ms) / 2;
        let xfade_ms = CROSSFADE_MS.min(half_dur);
        // Need room for the OUTSIDE crossfade on both edges.
        if snip.start_ms < xfade_ms || snip.end_ms + xfade_ms > inputs.file_duration_ms {
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
            kind,
        });
    }

    if planned.is_empty() {
        return EffectGraph::None;
    }
    planned.sort_by_key(|p| p.start_ms);

    crate::log!(
        "overlay",
        "audio_filter: planning {} effect snip(s)",
        planned.len()
    );
    EffectGraph::Graph(render_graph(&planned))
}

fn render_graph(snips: &[PlannedEffect]) -> String {
    let mut out = String::new();

    // Video: pass-through.
    out.push_str("[vid1] null [vo];\n");

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

/// Audio-blur chain. Three presets.
///
/// - "muffled"       → lowpass + reverb. Most natural; least obvious.
/// - "garbled_grain" → aggressive modulation that mangles phonemes
///   (chorus + flanger + vibrato cluster — TRUE granular reversal
///   requires custom DSP, this approximates the destructive effect).
/// - "garbled_phase" → FFT phase scramble. Spectral envelope preserved.
fn audio_blur_chain(mode: &str, intensity: u8) -> String {
    let i = (intensity as f64 / 100.0).clamp(0.0, 1.0);
    match mode {
        "garbled_grain" => {
            // Aggressive modulation cluster — vibrato + flanger + chorus.
            // Speech intelligibility collapses fast; music survives as
            // a smeared, drunken texture.
            //  - vibrato: pitch warble (depth scales with intensity)
            //  - flanger: comb-filter sweep
            //  - chorus:  triple-voice smear
            let depth = 0.3 + 0.7 * i; // 0.3 → 1.0
            let f_hz = 5.0 + 10.0 * i; // 5 → 15 Hz
            format!(
                "vibrato=f={f_hz:.2}:d={depth:.3},\
                 flanger=delay=5:depth=2:width=70:speed=0.6,\
                 chorus=0.5:0.9:60|70|80:0.4|0.45|0.5:0.4|0.5|0.6:2|2.5|3"
            )
        }
        "garbled_phase" => {
            // FFT phase scramble — randomize the phase of each bin while
            // keeping the magnitude. Magnitude → timbre survives. Phase
            // → temporal structure (phoneme onsets) destroyed.
            //
            // afftfilt's expressions: `real` and `imag` get a per-bin
            // complex-pair output. We compute magnitude=hypot(re,im) and
            // re-emit with a random phase (random(0) → uniform [0,1] per
            // bin). `i` mixes between original (i=0) and full scramble
            // (i=1) by interpolating phase.
            //
            // Implementation note: afftfilt evaluates real/imag at
            // every frame for every bin; expressions can reference
            // `re`, `im`, and helpers like `random(n)`.
            let _ = i; // intensity reserved for partial-scramble; full for v1
            "afftfilt=real='hypot(re,im)*cos(random(0)*2*PI)':\
             imag='hypot(re,im)*sin(random(0)*2*PI)'"
                .to_string()
        }
        _ => {
            // muffled — lowpass + echo (reverb-ish).
            // Cutoff slides 1600 Hz at intensity 0 → 300 Hz at intensity 100.
            // Below ~800 Hz, consonants are gone and speech is
            // unintelligible while music character largely survives.
            let cutoff = (1600.0 - 1300.0 * i).round() as u32;
            // Reverb delay + decay scale with intensity.
            let delay_ms = (30.0 + 50.0 * i).round() as u32;
            let decay = 0.4 + 0.4 * i;
            format!(
                "lowpass=f={cutoff},aecho=0.7:0.7:{delay_ms}:{decay:.2}"
            )
        }
    }
}

fn ms_to_secs_str(ms: u64) -> String {
    let whole = ms / 1000;
    let frac = ms % 1000;
    format!("{whole}.{frac:03}")
}
