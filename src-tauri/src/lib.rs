mod autosnip;
mod commands;
mod fingerprint;
mod playback;
mod profile;
mod tmdb;

use playback::MpvPlayer;
use tauri::{Emitter, Manager};

/// Scan a process argv list (or one from a re-launch) for the first entry
/// that points at an existing file on disk. Used to detect a video path
/// passed by Explorer when the user double-clicks a file. Returns `None`
/// if no argument is a real file — the user just launched the exe plain.
fn first_existing_file_arg(argv: &[String]) -> Option<String> {
    // argv[0] is conventionally the exe path; skip it so we don't try to
    // "open" fvp.exe as a video.
    argv.iter().skip(1).find_map(|a| {
        let p = std::path::Path::new(a);
        if p.is_file() {
            Some(a.clone())
        } else {
            None
        }
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Enforce one running FVP at a time. When a second launch happens,
        // this callback runs in the FIRST instance with the new launch's
        // argv — we focus the existing window AND, if argv contains a
        // video path (typical when the user double-clicks a file in
        // Explorer while FVP is already running), emit a `cli-open-file`
        // event so the frontend can route it through openVideoPath.
        // The second instance exits immediately so the user only ever
        // sees one FVP.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            eprintln!("[fvp] second instance attempted with argv={argv:?}");
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            if let Some(path) = first_existing_file_arg(&argv) {
                eprintln!("[fvp] forwarding file to existing instance: {path}");
                let _ = app.emit("cli-open-file", path);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .ok_or_else(|| "main window not found".to_string())?;

            #[cfg(target_os = "windows")]
            let hwnd: Option<i64> = {
                let h = window
                    .hwnd()
                    .map_err(|e| format!("hwnd extraction failed: {e}"))?;
                Some(h.0 as i64)
            };
            #[cfg(not(target_os = "windows"))]
            let hwnd: Option<i64> = None;

            #[cfg(target_os = "windows")]
            playback::video_subclass::init(app.app_handle().clone());

            let player = MpvPlayer::new(hwnd, app.app_handle().clone())
                .map_err(|e| format!("MpvPlayer init failed: {e}"))?;
            app.manage(player);

            // First-launch file-open: if Explorer launched us with a video
            // path in argv (typical for "Open with…" or default-app
            // double-click), emit the same `cli-open-file` event the
            // second-instance handler does so the frontend has one code
            // path for both. Delay slightly so the frontend listener is
            // attached before we fire.
            let argv: Vec<String> = std::env::args().collect();
            if let Some(path) = first_existing_file_arg(&argv) {
                eprintln!("[fvp] launch argv contains file: {path} — will emit after frontend mounts");
                let app_handle = app.app_handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    let _ = app_handle.emit("cli-open-file", path);
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::playback::open_file,
            commands::playback::play,
            commands::playback::pause,
            commands::playback::toggle_pause,
            commands::playback::set_play_direction,
            commands::playback::get_play_direction,
            commands::playback::set_aspect_ratio,
            commands::playback::set_volume,
            commands::playback::set_muted,
            commands::playback::seek,
            commands::playback::frame_step_forward,
            commands::playback::frame_step_back,
            commands::playback::stop,
            commands::playback::screenshot,
            commands::playback::set_speed,
            commands::playback::get_state,
            commands::playback::add_subtitle,
            commands::playback::set_subtitle_track,
            commands::playback::toggle_subtitle_visibility,
            commands::playback::set_subtitle_visibility,
            commands::playback::get_subtitle_visibility,
            commands::playback::subtitle_tracks,
            commands::playback::audio_tracks,
            commands::playback::video_tracks,
            commands::playback::set_audio_track,
            commands::playback::set_video_track,
            commands::playback::set_deinterlace,
            commands::playback::get_deinterlace,
            commands::playback::audio_devices,
            commands::playback::set_audio_device,
            commands::playback::apply_audio_overlay,
            commands::playback::clear_audio_overlay,
            commands::autosnip::parse_subtitle_file,
            commands::autosnip::extract_embedded_subtitle,
            commands::autosnip::autosnip_run_on_entries,
            commands::autosnip::load_autosnip_whitelist,
            commands::autosnip::save_autosnip_whitelist,
            commands::library::scan_library_folder,
            commands::library::watch_library_folder,
            commands::library::unwatch_library_folder,
            commands::window::set_fullscreen,
            commands::window::is_fullscreen,
            commands::window::set_video_area,
            commands::profile::compute_fingerprint,
            commands::profile::scan_folder_for_profiles,
            commands::profile::load_profile,
            commands::profile::save_profile,
            commands::profile::verify_profile,
            commands::profile::save_draft,
            commands::profile::load_draft,
            commands::profile::delete_draft,
            commands::profile::file_exists,
            commands::profile::is_directory,
            commands::profile::write_text_file,
            commands::autosnip::autosnip_run,
            commands::autosnip::autosnip_find_subtitles,
            commands::autosnip::open_external_url,
            commands::tmdb::tmdb_search,
            commands::tmdb::tmdb_movie_details,
        ])
        .run(tauri::generate_context!())
        .expect("error while running FVP");
}
