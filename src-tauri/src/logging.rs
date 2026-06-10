//! Tiny `log!` macro that wraps eprintln with an HH:MM:SS.mmm timestamp
//! and the calling subsystem tag. Goal: when the user reports "it
//! froze," the terminal scroll shows EXACTLY where + when.
//!
//! Usage:
//!     log!("library", "list_items: starting");
//!     log!("library:enrich", "TMDb details fetch begin tmdb_id={}", id);
//!
//! Output looks like:
//!     [20:30:14.123 fvp:library] list_items: starting
//!
//! The macro is `vis pub` so subsystems just `use crate::log;`.
//!
//! In addition to emitting to stderr the macro also pushes each line
//! into a 500-line ring buffer (`LOG_RING`). The
//! `get_recent_log_lines` Tauri command reads from it so the in-app
//! Error Report dialog can attach recent context to the report stub.

use std::sync::Mutex;

const RING_CAP: usize = 500;

static LOG_RING: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Push one rendered log line into the ring buffer. Called by the
/// `log!` macro; you generally won't call this directly.
pub fn push_log_line(line: String) {
    if let Ok(mut guard) = LOG_RING.lock() {
        if guard.len() >= RING_CAP {
            let drop = guard.len() - RING_CAP + 1;
            guard.drain(0..drop);
        }
        guard.push(line);
    }
}

/// Return up to `n` of the most recent log lines, oldest first.
pub fn recent_log_lines(n: usize) -> Vec<String> {
    let guard = match LOG_RING.lock() {
        Ok(g) => g,
        Err(_) => return Vec::new(),
    };
    let start = guard.len().saturating_sub(n);
    guard[start..].to_vec()
}

#[macro_export]
macro_rules! log {
    ($tag:literal, $($arg:tt)*) => {{
        let now = chrono::Local::now();
        let line = format!("[{} fvp:{}] {}", now.format("%H:%M:%S%.3f"), $tag, format!($($arg)*));
        eprintln!("{}", line);
        $crate::logging::push_log_line(line);
    }};
}
