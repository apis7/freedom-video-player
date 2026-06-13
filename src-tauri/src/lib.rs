mod autosnip;
mod commands;
mod console_attach;
mod fingerprint;
mod library;
#[macro_use]
pub mod logging;
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
            // ────────────────────────────────────────────────────────
            // SYNCHRONOUS BOOT — RULES OF THE ROAD
            //
            // The body of this setup() callback runs on the Tauri
            // main thread and BLOCKS the UI mount until it returns.
            // Every line here must be local-IO only:
            //   - libmpv DLL load       (unavoidable, ~500ms)
            //   - local SQLite          (<100ms)
            //   - AppData reads/writes  (<10ms)
            //   - HashMap / Vec init    (instant)
            //
            // Anything that touches SMB, remote shares, network
            // sockets, or registers a `notify` watcher on a UNC path
            // MUST go through `library::boot::defer_startup(...)` so
            // the user gets a snappy UI mount even on a flaky NAS.
            //
            // Every phase below is wrapped in `library::boot::phase(...)`
            // which logs its wall-clock duration. If startup ever
            // regresses, the slow phase shows up as a single
            // unmissable log line.
            //
            // The contract is checked at the end with
            // `boot::log_total(...)` — if the total prints anything
            // above ~1 second on a healthy machine, something on the
            // sync path drifted out of compliance.
            // ────────────────────────────────────────────────────────
            let boot_started = std::time::Instant::now();

            let window = library::boot::phase("window_handle", || {
                app.get_webview_window("main")
                    .ok_or_else(|| "main window not found".to_string())
            })?;

            #[cfg(target_os = "windows")]
            let hwnd: Option<i64> = library::boot::phase("hwnd_extract", || {
                let h = window
                    .hwnd()
                    .map_err(|e| format!("hwnd extraction failed: {e}"))?;
                Ok::<Option<i64>, String>(Some(h.0 as i64))
            })?;
            #[cfg(not(target_os = "windows"))]
            let hwnd: Option<i64> = None;

            #[cfg(target_os = "windows")]
            library::boot::phase("video_subclass", || {
                playback::video_subclass::init(app.app_handle().clone());
            });

            let player = library::boot::phase("mpv_init", || {
                MpvPlayer::new(hwnd, app.app_handle().clone())
                    .map_err(|e| format!("MpvPlayer init failed: {e}"))
            })?;
            app.manage(player);

            // Open the Library SQLite store at the standard app-local
            // location and run any pending migrations. Stored in app state
            // so commands can grab it via `State<LibraryDb>`. If init
            // fails (e.g. unwritable AppData), log loudly and continue —
            // Library Mode just won't work; Player Mode is unaffected.
            let mut library_db_opened = false;
            match library::boot::phase("app_local_data_dir", || app.path().app_local_data_dir()) {
                Ok(dir) => {
                    let db_path = dir.join("library.db");
                    // Restore marker (from Settings → Restore from
                    // snapshot, OR from sync.rs scheduling a pull).
                    // Wrapped in a 500ms reachability probe — if the
                    // snapshot file lives on an SMB share that's
                    // currently unresponsive, we abandon the restore
                    // for this launch instead of stalling startup for
                    // 30+ seconds on a kernel SMB timeout. The marker
                    // file is left in place so the next launch
                    // retries.
                    library::boot::phase("consume_restore_marker", || {
                        match library::boot::consume_restore_marker_with_probe(&db_path) {
                            Ok(true) => log!(
                                "library:snapshot",
                                "restore-from-snapshot completed at {}",
                                db_path.display()
                            ),
                            Ok(false) => {}
                            Err(e) => log!(
                                "library:snapshot",
                                "restore marker consumption FAILED: {e} (continuing with existing DB)"
                            ),
                        }
                    });
                    match library::boot::phase("library_db_open", || library::LibraryDb::open(&db_path)) {
                        Ok(db) => {
                            library_db_opened = true;
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
                            // Sync-mode restore (consume_restore_marker just above)
                            // overwrites the local DB with library-sync.db from the
                            // home folder — including any phantom rows that live
                            // inside `#recycle` / `$RECYCLE.BIN` / `.Trash` etc. The
                            // walk() now skips those folders going forward, but the
                            // restored DB still contains them, so the user sees the
                            // same NAS-recycle ghosts re-appear after every delete.
                            // Strip them out unconditionally on open — the scan
                            // would never have added them in the first place.
                            library::boot::phase("recycle_bin_purge", || {
                                let conn = db.lock();
                                let rows: Vec<(i64, String)> = conn
                                    .prepare("SELECT id, path FROM library_files")
                                    .and_then(|mut s| {
                                        s.query_map([], |r| {
                                            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
                                        })
                                        .and_then(|it| it.collect())
                                    })
                                    .unwrap_or_default();
                                let to_purge: Vec<i64> = rows
                                    .into_iter()
                                    .filter(|(_, p)| {
                                        library::index::path_is_in_recycle_bin(p)
                                    })
                                    .map(|(id, _)| id)
                                    .collect();
                                if !to_purge.is_empty() {
                                    let placeholders =
                                        std::iter::repeat("?").take(to_purge.len())
                                            .collect::<Vec<_>>().join(",");
                                    let sql = format!(
                                        "DELETE FROM library_files WHERE id IN ({placeholders})"
                                    );
                                    let params: Vec<&dyn rusqlite::ToSql> = to_purge
                                        .iter()
                                        .map(|i| i as &dyn rusqlite::ToSql)
                                        .collect();
                                    match conn.execute(&sql, params.as_slice()) {
                                        Ok(n) => log!(
                                            "library",
                                            "recycle-bin purge: removed {n} row(s) whose path lives under #recycle / $RECYCLE.BIN / .Trash (would have been re-added otherwise via sync restore)"
                                        ),
                                        Err(e) => log!(
                                            "library",
                                            "recycle-bin purge: DELETE failed: {e}"
                                        ),
                                    }
                                }
                            });
                            // Move-duplicate purge: an older indexer (before
                            // the MOVE-AUTO-REBIND fix) used to leave the
                            // old is_missing row alongside the new row when
                            // it detected a moved file. The user then had to
                            // right-click the broken thumbnail every launch
                            // to merge it. Those stale rows live inside the
                            // restored sync DB, so they reappear after each
                            // pull. Sweep them out unconditionally on open:
                            // for any identity that has BOTH a present row
                            // AND an is_missing row, the is_missing row is
                            // a leftover and the present row already owns
                            // the user's watch_progress / tags / etc.
                            library::boot::phase("move_duplicate_purge", || {
                                let conn = db.lock();
                                match conn.execute(
                                    "DELETE FROM library_files
                                      WHERE is_missing = 1
                                        AND identity_id IN (
                                          SELECT identity_id FROM library_files
                                            WHERE is_missing = 0
                                            GROUP BY identity_id
                                        )",
                                    [],
                                ) {
                                    Ok(n) if n > 0 => log!(
                                        "library",
                                        "move-duplicate purge: removed {n} stale is_missing row(s) whose identity already has a present row (legacy MOVE-LIKELY leftovers)"
                                    ),
                                    Ok(_) => {}
                                    Err(e) => log!(
                                        "library",
                                        "move-duplicate purge: DELETE failed: {e}"
                                    ),
                                }
                            });
                            // Spin up the scan orchestrator. The synchronous
                            // part is just channel + worker-thread + cadence
                            // heartbeat spawn (~<5ms); the SMB-heavy
                            // watcher reattach + boot ScanAll run on a
                            // background thread spawned from inside
                            // orchestrator::init.
                            library::boot::phase("orchestrator_init", || {
                                library::orchestrator::init(app.app_handle().clone(), db.clone());
                            });
                            // Separate background worker for TMDb metadata
                            // enrichment + poster caching. Just a thread spawn.
                            library::boot::phase("enrich_init", || {
                                library::enrich::init(app.app_handle().clone(), db.clone(), dir);
                            });
                            // Background refind worker — quietly tries to
                            // recover any is_missing row by stat-ing its
                            // path, looking for a sibling at a new
                            // location, and walking watched folders for
                            // a same-basename match. So when the user
                            // moves a folder, by the time they look at
                            // the broken thumbnails the worker has
                            // already rebound them in place. Throttled
                            // so it doesn't fight the foreground scan
                            // for SMB bandwidth.
                            library::boot::phase("refind_worker_init", || {
                                library::refind_worker::init(
                                    app.app_handle().clone(),
                                    db.clone(),
                                );
                            });
                            // Host supervisor — synchronous part reads
                            // local settings. When mode==host this also
                            // used to call bring_up which binds a TCP
                            // socket AND writes host-discovery.json to a
                            // possibly-SMB home folder. Now bring_up is
                            // deferred to a background thread so a slow
                            // home folder doesn't stall startup; the local
                            // settings read stays here.
                            let supervisor = commands::library::HostSupervisor::default();
                            library::boot::phase("supervisor_boot", || {
                                commands::library::supervisor_boot(
                                    &db,
                                    &supervisor,
                                    app.app_handle(),
                                );
                            });
                            app.manage(supervisor);
                            // Snapshot backup tick — just a thread spawn.
                            library::boot::phase("snapshot_init", || {
                                library::snapshot::init(db.clone());
                            });
                            // Sync mode tick — just a thread spawn.
                            library::boot::phase("sync_init", || {
                                library::sync::init(db.clone());
                            });
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

            // Final boot anchor — one log line that gives the total
            // wall-clock duration of synchronous boot. If this ever
            // prints anything beyond ~1 second on a healthy machine,
            // something on the sync path has drifted out of compliance
            // with the "no remote IO on the boot thread" contract at
            // the top of this file.
            library::boot::log_total(boot_started, library_db_opened);

            Ok(())
        })
        .on_window_event(|window, event| {
            // Belt-and-suspenders sync push on close. The 1-min sync
            // tick already pushes every cadence_min minutes, but if
            // the user creates a series + closes the app inside that
            // window the cadence push wouldn't have fired yet and the
            // work would only live in the local DB. Force a push here
            // so the share is always current up to the moment of
            // close. Best-effort: if the share isn't reachable (NAS
            // offline) we log and proceed - blocking the close on a
            // dead network share would feel worse than the data risk.
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if window.label() != "main" {
                    return;
                }
                let app = window.app_handle();
                let db = app.state::<library::LibraryDb>();
                match library::sync::force_push(&db) {
                    Ok(p) => log!(
                        "library:sync",
                        "close-push: wrote {} (force-push on window close)",
                        p.display()
                    ),
                    Err(e) => log!(
                        "library:sync",
                        "close-push: SKIPPED ({e}) - local edits stay in local DB only until next launch's cadence tick"
                    ),
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::diagnostics::get_recent_log_lines,
            commands::diagnostics::submit_report,
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
            commands::library::library_skip_suggestion_for_months,
            commands::library::library_add_to_want_to_watch,
            commands::library::library_profile_creator_suggest,
            commands::library::library_clear_drift_warning,
            commands::library::library_find_file_by_path,
            commands::library::library_save_actual_resolution,
            commands::library::library_remove_identity_metadata,
            commands::library::library_generate_thumbnail_from_random_frame,
            commands::library::library_try_refind_file,
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
            commands::library::library_set_mode,
            commands::library::library_set_home_folder,
            commands::library::library_set_home_folder_from_marker,
            commands::library::library_scan_share_for_watchable_dirs,
            commands::library::library_set_host_address,
            commands::library::library_rotate_auth_token,
            commands::library::library_host_server_status,
            commands::library::library_test_host_connection,
            commands::library::library_read_home_discovery,
            commands::library::library_diagnose_home_folder,
            commands::library::library_snapshot_status,
            commands::library::library_snapshot_set_enabled,
            commands::library::library_snapshot_set_keep_count,
            commands::library::library_snapshot_set_cadence_days,
            commands::library::library_snapshot_take_now,
            commands::library::library_snapshot_reveal_dir,
            commands::library::library_snapshot_schedule_restore,
            commands::library::library_first_run_status,
            commands::library::library_first_run_complete,
            commands::library::library_sync_status,
            commands::library::library_sync_push_now,
            commands::library::library_sync_pull_now,
            commands::library::library_sync_set_cadence,
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
