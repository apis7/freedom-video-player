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

#[macro_export]
macro_rules! log {
    ($tag:literal, $($arg:tt)*) => {{
        let now = chrono::Local::now();
        eprintln!("[{} fvp:{}] {}", now.format("%H:%M:%S%.3f"), $tag, format!($($arg)*));
    }};
}
