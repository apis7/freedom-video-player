pub mod compute;
pub mod phash;
pub mod scoring;

pub use compute::compute_for_file;
pub use scoring::{scan_folder, score_against, MatchQuality, MatchResult, MatchScore};
