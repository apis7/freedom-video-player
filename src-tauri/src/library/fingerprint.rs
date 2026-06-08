//! Two-tier content fingerprints for the library identity scheme.
//!
//! Cheap (default; used for move detection on every scan):
//!   MD5(first 4 MB) + MD5(last 4 MB) + file size + duration (ms)
//!   Hashed together into a single hex string. Fast — ~10-50 ms per file
//!   even on slow drives.
//!
//! Strong (computed on demand only — explicit dedupe scan, ambiguous match):
//!   BLAKE3 of the full file contents. Slower but stable across container
//!   re-muxing — useful when cheap fingerprints disagree but we suspect
//!   a true content match.
//!
//! NEITHER hash is cryptographic-grade in our use. We're checking "is this
//! the same content?", not "is this signed by Alice?". Speed trumps
//! collision-resistance — for our problem size (a personal library of
//! thousands, not millions), MD5/BLAKE3 are more than adequate.

use md5::{Digest, Md5};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// How much of each end of the file we hash for the cheap fingerprint.
/// Sized so that two near-identical files (same source, different container)
/// disagree on size or duration before we hit a hash collision in 4 MB of
/// content.
const CHEAP_HEAD_BYTES: u64 = 4 * 1024 * 1024;
const CHEAP_TAIL_BYTES: u64 = 4 * 1024 * 1024;

/// Build a cheap fingerprint string. Format is deliberately opaque (a hex
/// digest) — never parse it; just compare. Pure content+size identity
/// (no duration): keeps the fingerprint cheap to compute (no libmpv
/// spin-up needed) and stable across re-indexing. Duration is held
/// separately on the identity row and used by the PROBABLE match engine
/// for cross-encode detection.
pub fn cheap_fingerprint(path: &Path) -> Result<String, String> {
    let mut f = File::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    let size = f
        .metadata()
        .map_err(|e| format!("metadata {}: {e}", path.display()))?
        .len();

    let mut hasher = Md5::new();
    hasher.update(size.to_le_bytes());

    let head_len = CHEAP_HEAD_BYTES.min(size);
    if head_len > 0 {
        let mut buf = vec![0u8; head_len as usize];
        f.read_exact(&mut buf)
            .map_err(|e| format!("read head: {e}"))?;
        hasher.update(&buf);
    }

    if size > CHEAP_HEAD_BYTES + CHEAP_TAIL_BYTES {
        let tail_start = size - CHEAP_TAIL_BYTES;
        f.seek(SeekFrom::Start(tail_start))
            .map_err(|e| format!("seek tail: {e}"))?;
        let mut buf = vec![0u8; CHEAP_TAIL_BYTES as usize];
        f.read_exact(&mut buf)
            .map_err(|e| format!("read tail: {e}"))?;
        hasher.update(&buf);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Strong fingerprint — BLAKE3 of the entire file. Streaming reader so
/// memory stays bounded regardless of file size. Significantly slower
/// than `cheap_fingerprint` (limited by disk read speed); call only when
/// you need it (explicit duplicate detection, ambiguous reconciliation).
pub fn strong_fingerprint(path: &Path) -> Result<String, String> {
    let mut f = File::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    let mut hasher = blake3::Hasher::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = f.read(&mut buf).map_err(|e| format!("read: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().to_hex().to_string())
}
