use tauri::{Manager, Runtime};

#[tauri::command]
pub async fn set_fullscreen<R: Runtime>(
    app: tauri::AppHandle<R>,
    fullscreen: bool,
) -> Result<(), String> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    win.set_fullscreen(fullscreen)
        .map_err(|e| format!("set_fullscreen failed: {e}"))
}

#[tauri::command]
pub async fn is_fullscreen<R: Runtime>(app: tauri::AppHandle<R>) -> Result<bool, String> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    win.is_fullscreen().map_err(|e| format!("is_fullscreen failed: {e}"))
}

/// Resize the intermediate window that libmpv renders into, to the given
/// pixel rect relative to the Tauri main client area. All values are physical
/// pixels (frontend multiplies CSS pixels by devicePixelRatio).
#[tauri::command]
pub async fn set_video_area<R: Runtime>(
    _app: tauri::AppHandle<R>,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        crate::playback::video_subclass::resize_intermediate(x, y, width, height);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (x, y, width, height);
    }
    Ok(())
}
