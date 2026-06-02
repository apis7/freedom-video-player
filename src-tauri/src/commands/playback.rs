use crate::playback::audio_replace::{build as build_overlay, OverlayGraph, OverlayInputs};
use crate::playback::{AudioDevice, MpvPlayer, PlayerState, SubtitleTrack};
use crate::profile::format::Snip;
use tauri::State;

#[tauri::command]
pub fn open_file(player: State<'_, MpvPlayer>, path: String) -> Result<(), String> {
    player.load_file(&path)?;
    player.play()
}

#[tauri::command]
pub fn play(player: State<'_, MpvPlayer>) -> Result<(), String> {
    player.play()
}

#[tauri::command]
pub fn pause(player: State<'_, MpvPlayer>) -> Result<(), String> {
    player.pause()
}

#[tauri::command]
pub fn set_play_direction(
    player: State<'_, MpvPlayer>,
    direction: String,
) -> Result<(), String> {
    if direction != "forward" && direction != "backward" {
        return Err(format!(
            "invalid direction {direction:?}; expected \"forward\" or \"backward\""
        ));
    }
    player.set_play_direction(&direction)
}

#[tauri::command]
pub fn get_play_direction(player: State<'_, MpvPlayer>) -> String {
    player.get_play_direction()
}

#[tauri::command]
pub fn set_aspect_ratio(
    player: State<'_, MpvPlayer>,
    value: String,
) -> Result<(), String> {
    if value.chars().count() > 32 {
        return Err("aspect ratio value too long".into());
    }
    player.set_aspect_ratio(&value)
}

#[tauri::command]
pub fn toggle_pause(player: State<'_, MpvPlayer>) -> Result<bool, String> {
    player.toggle_pause()
}

#[tauri::command]
pub fn set_volume(player: State<'_, MpvPlayer>, volume: f64) -> Result<(), String> {
    player.set_volume(volume)
}

#[tauri::command]
pub fn set_muted(player: State<'_, MpvPlayer>, muted: bool) -> Result<(), String> {
    player.set_muted(muted)
}

#[tauri::command]
pub fn seek(player: State<'_, MpvPlayer>, seconds: f64) -> Result<(), String> {
    player.seek_absolute(seconds)
}

#[tauri::command]
pub fn frame_step_forward(player: State<'_, MpvPlayer>) -> Result<(), String> {
    player.frame_step_forward()
}

#[tauri::command]
pub fn frame_step_back(player: State<'_, MpvPlayer>) -> Result<(), String> {
    player.frame_step_back()
}

#[tauri::command]
pub fn stop(player: State<'_, MpvPlayer>) -> Result<(), String> {
    player.stop()
}

#[tauri::command]
pub fn screenshot(player: State<'_, MpvPlayer>) -> Result<String, String> {
    player.screenshot_data_url()
}

#[tauri::command]
pub fn set_speed(player: State<'_, MpvPlayer>, rate: f64) -> Result<(), String> {
    player.set_speed(rate)
}

#[tauri::command]
pub fn get_state(player: State<'_, MpvPlayer>) -> PlayerState {
    player.state()
}

#[tauri::command]
pub fn add_subtitle(player: State<'_, MpvPlayer>, path: String) -> Result<(), String> {
    player.add_subtitle(&path)
}

#[tauri::command]
pub fn set_subtitle_track(
    player: State<'_, MpvPlayer>,
    id: Option<i64>,
) -> Result<(), String> {
    player.set_subtitle_track(id)
}

#[tauri::command]
pub fn toggle_subtitle_visibility(player: State<'_, MpvPlayer>) -> Result<(), String> {
    player.toggle_subtitle_visibility()
}

#[tauri::command]
pub fn set_subtitle_visibility(
    player: State<'_, MpvPlayer>,
    visible: bool,
) -> Result<(), String> {
    player.set_subtitle_visibility(visible)
}

#[tauri::command]
pub fn get_subtitle_visibility(player: State<'_, MpvPlayer>) -> bool {
    player.get_subtitle_visibility()
}

#[tauri::command]
pub fn subtitle_tracks(player: State<'_, MpvPlayer>) -> Result<Vec<SubtitleTrack>, String> {
    player.subtitle_tracks()
}

#[tauri::command]
pub fn audio_tracks(player: State<'_, MpvPlayer>) -> Result<Vec<SubtitleTrack>, String> {
    player.audio_tracks()
}

#[tauri::command]
pub fn video_tracks(player: State<'_, MpvPlayer>) -> Result<Vec<SubtitleTrack>, String> {
    player.video_tracks()
}

#[tauri::command]
pub fn set_audio_track(player: State<'_, MpvPlayer>, id: Option<i64>) -> Result<(), String> {
    player.set_audio_track(id)
}

#[tauri::command]
pub fn set_video_track(player: State<'_, MpvPlayer>, id: Option<i64>) -> Result<(), String> {
    player.set_video_track(id)
}

#[tauri::command]
pub fn set_deinterlace(player: State<'_, MpvPlayer>, on: bool) -> Result<(), String> {
    player.set_deinterlace(on)
}

#[tauri::command]
pub fn get_deinterlace(player: State<'_, MpvPlayer>) -> bool {
    player.get_deinterlace()
}

#[tauri::command]
pub fn audio_devices(player: State<'_, MpvPlayer>) -> Vec<AudioDevice> {
    player.audio_devices()
}

#[tauri::command]
pub fn set_audio_device(player: State<'_, MpvPlayer>, name: String) -> Result<(), String> {
    player.set_audio_device(&name)
}

/// Apply (or clear) the audio-replace overlay for the currently loaded file.
///
/// Builds a `--lavfi-complex` filter graph from the supplied snip list and
/// asks libmpv to reload the current file with that graph in place. Passing
/// an empty `snips` list (or a list with no usable audio-replace snips)
/// clears the overlay and reloads the file in plain mode.
///
/// Returns true if an overlay was applied, false if cleared.
#[tauri::command]
pub fn apply_audio_overlay(
    player: State<'_, MpvPlayer>,
    snips: Vec<Snip>,
    file_duration_ms: u64,
) -> Result<bool, String> {
    let ar_count = snips
        .iter()
        .filter(|s| matches!(s.action, crate::profile::format::SnipAction::AudioReplace { .. }))
        .count();
    eprintln!(
        "[fvp:overlay] apply_audio_overlay called: total_snips={} audio_replace={} duration_ms={}",
        snips.len(),
        ar_count,
        file_duration_ms,
    );

    let path = player.current_path().ok_or_else(|| {
        eprintln!("[fvp:overlay] ERROR: no file currently loaded");
        "no file currently loaded".to_string()
    })?;
    eprintln!("[fvp:overlay] target file: {path}");

    let graph = build_overlay(OverlayInputs {
        file_path: &path,
        file_duration_ms,
        snips: &snips,
    });

    match graph {
        OverlayGraph::Graph(g) => {
            eprintln!("[fvp:overlay] graph built ({} bytes) — applying", g.len());
            player.apply_lavfi_complex(&g)?;
            eprintln!("[fvp:overlay] apply_audio_overlay OK (overlay engaged)");
            Ok(true)
        }
        OverlayGraph::None => {
            eprintln!(
                "[fvp:overlay] no usable audio_replace snips after validation \
                 (all dropped — boundary or invalid) — clearing overlay"
            );
            player.apply_lavfi_complex("")?;
            Ok(false)
        }
    }
}

/// Clear the audio-replace overlay without rebuilding it from snips. Calls
/// the same reload path with an empty filter graph.
#[tauri::command]
pub fn clear_audio_overlay(player: State<'_, MpvPlayer>) -> Result<(), String> {
    eprintln!("[fvp:overlay] clear_audio_overlay called");
    if player.current_path().is_none() {
        eprintln!("[fvp:overlay] no file loaded — nothing to clear");
        return Ok(());
    }
    let r = player.apply_lavfi_complex("");
    match &r {
        Ok(()) => eprintln!("[fvp:overlay] clear_audio_overlay OK"),
        Err(e) => eprintln!("[fvp:overlay] clear_audio_overlay FAILED: {e}"),
    }
    r
}
