mod autosnip;
mod commands;
mod console_attach;
mod fingerprint;
mod library;
#[macro_use]
mod logging;
mod peaks;
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
    // First-statement init: if FVP was launched from a terminal, attach
    // to that terminal's console + reroute stdout/stderr so eprintln!
    // calls become visible. No-op (and invisible) when double-clicked
    // from Explorer. Must run before any other code does I/O.
    console_attach::init();

    // Loud startup banner — gives the user something obvious to anchor
    // the rest of the log to. Every subsequent log line carries a
    // timestamp via the `log!` macro.
    log!("startup", "==== Freedom Video Player v{} starting ====", env!("CARGO_PKG_VERSION"));
    log!("startup", "pid={} args={:?}", std::process::id(), std::env::args().collect::<Vec<_>>());

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
            log!("startup", "second instance attempted with argv={argv:?}");
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            if let Some(path) = first_existing_file_arg(&argv) {
                log!("startup", "forwarding file to existing instance: {path}");
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

            // Open the Library SQLite store at the standard app-local
            // location and run any pending migrations. Stored in app state
            // so commands can grab it via `State<LibraryDb>`. If init
            // fails (e.g. unwritable AppData), log loudly and continue —
            // Library Mode just won't work; Player Mode is unaffected.
            match app.path().app_local_data_dir() {
                Ok(dir) => {
                    let db_path = dir.join("library.db");
                    match library::LibraryDb::open(&db_path) {
                        Ok(db) => {
                            log!(
                                "library",
                                "opened DB at {} ({} files indexed)",
                                db_path.display(),
                                {
                                    let conn = db.lock();
                                    conn.query_row::<i64, _, _>(
                                        "SELECT COUNT(*) FROM library_files",
                                        [],
                                        |r| r.get(0),
                                    )
                                    .unwrap_or(0)
                                }
                            );
                            // Spin up the scan orchestrator (watchers +
                            // indexer worker). It reattaches notify
                            // watchers for every folder already in the DB
                            // and queues an initial pass to catch up with
                            // on-disk changes made while the app was
                            // closed.
                            library::orchestrator::init(app.app_handle().clone(), db.clone());
                            // Separate background worker for TMDb metadata
                            // enrichment + poster caching. Throttled +
                            // off-thread; indexer hands off new identity
                            // ids to it via library::enrich::enqueue.
                            library::enrich::init(app.app_handle().clone(), db.clone(), dir);
                            app.manage(db);
                        }
                        Err(e) => {
                            log!(
                                "library",
                                "FAILED to open DB at {}: {e}",
                                db_path.display()
                            );
                        }
                    }
                }
                Err(e) => log!("library", "couldn't resolve app data dir: {e}"),
            }

            // First-launch file-open: if Explorer launched us with a video
            // path in argv (typical for "Open with…" or default-app
            // double-click), emit the same `cli-open-file` event the
            // second-instance handler does so the frontend has one code
            // path for both. Delay slightly so the frontend listener is
            // attached before we fire.
            let argv: Vec<String> = std::env::args().collect();
            if let Some(path) = first_existing_file_arg(&argv) {
                log!("startup", "launch argv contains file: {path} — will emit after frontend mounts");
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
            commands::library::library_add_folder,
            commands::library::library_remove_folder,
            commands::library::library_search_by_filename,
            commands::library::library_relocate_file,
            commands::library::library_remove_broken_links,
            commands::library::library_find_possible_duplicates,
            commands::library::library_rename_file,
            commands::library::library_probe_file,
            commands::library::library_google_image_search,
            commands::library::library_apply_image_url,
            commands::library::library_set_scope_nff,
            commands::library::library_list_folders,
            commands::library::library_set_folder_scan_on_startup,
            commands::library::library_rescan_all,
            commands::library::library_rescan_folder,
            commands::library::library_scan_cancel,
            commands::library::library_scan_throttle,
            commands::library::library_list_items,
            commands::library::library_get_row,
            commands::library::library_get_poster_bytes,
            commands::library::library_refresh_metadata,
            commands::library::library_set_flags,
            commands::library::library_set_tags,
            commands::library::library_set_notes,
            commands::library::library_set_family_rating,
            commands::library::library_set_manual_metadata,
            commands::library::library_roulette_pick,
            commands::library::library_suggest_next,
            commands::library::library_dismiss_suggestion,
            commands::library::library_profile_creator_suggest,
            commands::library::library_clear_drift_warning,
            commands::library::library_find_file_by_path,
            commands::library::library_set_watch_progress,
            commands::library::library_mark_watched,
            commands::library::library_reset_progress,
            commands::library::library_has_pin,
            commands::library::library_verify_pin,
            commands::library::library_set_pin,
            commands::library::library_set_family_view_allowed,
            commands::library::library_set_family_view_enabled,
            commands::library::library_get_settings,
            commands::library::library_set_clock_format,
            commands::library::library_set_delete_default,
            commands::library::library_set_poster_cache_cap,
            commands::library::library_find_probable_pairs,
            commands::library::library_transfer_curation,
            commands::library::library_dismiss_pair,
            commands::library::library_dbg,
            commands::library::library_snooze_pair,
            commands::library::library_find_duplicates,
            commands::library::library_set_custom_thumbnail,
            commands::library::library_reveal_in_explorer,
            commands::library::library_apply_tmdb_id,
            commands::library::library_smart_tmdb_search,
            commands::library::library_remove_files,
            commands::library::library_trash_files,
            commands::library::library_log_open,
            commands::library::library_reorder_collection,
            commands::library::library_reorder_series,
            commands::library::library_reorder_collection_items,
            commands::library::library_reorder_series_items,
            commands::library::library_set_series_has_seasons,
            commands::library::library_set_series_item_season,
            commands::library::library_analytics,
            commands::library::library_list_collections,
            commands::library::library_create_collection,
            commands::library::library_rename_collection,
            commands::library::library_delete_collection,
            commands::library::library_add_to_collection,
            commands::library::library_remove_from_collection,
            commands::library::library_list_series,
            commands::library::library_create_series,
            commands::library::library_rename_series,
            commands::library::library_delete_series,
            commands::library::library_add_to_series,
            commands::library::library_remove_from_series,
            commands::library::library_refresh_profile_status,
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
            commands::tmdb::tmdb_tv_search,
            commands::tmdb::tmdb_tv_season,
            commands::peaks::load_peaks,
            commands::peaks::build_peaks,
        ])
        .run(tauri::generate_context!())
        .expect("error while running FVP");
}
