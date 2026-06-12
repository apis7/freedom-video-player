//! Library Mode — Chapter 3.
//!
//! Module structure:
//!   - `db`         — SQLite handle, migrations, connection management
//!   - `model`      — Rust types mirroring the DB schema; serde-serializable
//!                    for IPC to the frontend
//!   - `fingerprint`— Cheap (partial-hash + size + duration) and strong
//!                    (full-file BLAKE3) content fingerprints
//!   - `index`      — Scanner that walks watched folders, computes
//!                    fingerprints, upserts rows, and runs the match-
//!                    confidence engine on new files
//!   - `metadata`   — Filename parsing (title/year extraction) + TMDb
//!                    enrichment pipeline (deferred to the indexer)
//!   - `reconcile`  — Match-confidence engine + reconciliation primitives
//!
//! All library work runs on background threads — Player Mode must never be
//! blocked by an indexer pass or a fingerprint compute.

pub mod boot;
pub mod db;
pub mod enrich;
pub mod fingerprint;
pub mod folder_sig;
pub mod host_server;
pub mod index;
pub mod metadata;
pub mod model;
pub mod orchestrator;
pub mod poster_cache;
pub mod reconcile;
pub mod refind_worker;
pub mod snapshot;
pub mod suggestions;
pub mod sync;

pub use db::LibraryDb;
