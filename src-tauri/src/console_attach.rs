//! Windows GUI-subsystem console reattachment.
//!
//! Tauri release builds are linked with `#![windows_subsystem = "windows"]`
//! so the OS doesn't pop an empty cmd window every time the user launches
//! FVP. Side effect: stdout/stderr have no console at all, and every
//! `eprintln!` in the codebase goes nowhere.
//!
//! `init()` tries to attach to the *parent* process's console — so when
//! the user launches FVP from PowerShell / cmd, live log output appears
//! there. When the user double-clicks the icon, there's no parent
//! console, AttachConsole fails silently, and we stay invisible (no
//! flashing console pops up).
//!
//! Must run before any stdio is used. We call it as the very first
//! statement in `main()`.

#[cfg(windows)]
pub fn init() {
    use std::fs::OpenOptions;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::Console::{
        AttachConsole, GetConsoleWindow, SetStdHandle, ATTACH_PARENT_PROCESS,
        STD_ERROR_HANDLE, STD_OUTPUT_HANDLE,
    };

    unsafe {
        // If the OS already gave us a console (e.g. a future debug build
        // linked as windows_subsystem="console"), there's nothing to do.
        if !GetConsoleWindow().is_null() {
            return;
        }

        // Try to attach the parent process's console. Returns 0 (FALSE) if
        // there isn't one — that's the double-click case; just bail.
        if AttachConsole(ATTACH_PARENT_PROCESS) == 0 {
            return;
        }

        // AttachConsole gives us a console but doesn't update the standard
        // I/O handles — they're still NULL from the GUI-subsystem launch.
        // Open CONOUT$ via std::fs (avoids dragging extra windows-sys
        // features for CreateFileW) and point stdout + stderr at its
        // raw handle. The File is intentionally LEAKED via mem::forget so
        // the handle stays alive for the rest of the process — dropping
        // the File would close the handle out from under SetStdHandle.
        if let Ok(conout) = OpenOptions::new().write(true).open("CONOUT$") {
            let handle = conout.as_raw_handle();
            SetStdHandle(STD_OUTPUT_HANDLE, handle as _);
            SetStdHandle(STD_ERROR_HANDLE, handle as _);
            std::mem::forget(conout);
        }

        // Drop a blank line so our first log isn't glued to the shell's
        // last prompt line — cosmetic, but it makes the boundary obvious.
        eprintln!();
    }
}

#[cfg(not(windows))]
pub fn init() {
    // Non-Windows builds run with regular stdio — nothing to attach.
}
