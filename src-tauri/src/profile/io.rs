//! Atomic load/save for `.free` files.

use crate::profile::format::{FreeFile, ValidationError, MAX_FREE_FILE_BYTES};
use std::path::Path;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum IoError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("file too large: {actual} bytes (max {max})")]
    TooLarge { actual: u64, max: u64 },
    #[error("validation: {0}")]
    Validation(#[from] ValidationError),
}

/// Read a `.free` file from disk, parse it, and validate it. Refuses
/// files larger than `MAX_FREE_FILE_BYTES` BEFORE reading the contents
/// so a hostile / accidental huge file can't OOM us during read.
pub fn load(path: &Path) -> Result<FreeFile, IoError> {
    // Size guard first — stat the file before we read.
    let meta = std::fs::metadata(path)?;
    if meta.len() > MAX_FREE_FILE_BYTES {
        return Err(IoError::TooLarge {
            actual: meta.len(),
            max: MAX_FREE_FILE_BYTES,
        });
    }
    let content = std::fs::read_to_string(path)?;
    let parsed: FreeFile = serde_json::from_str(&content)?;
    parsed.validate()?;
    Ok(parsed)
}

/// Write a `.free` file atomically (write-temp + rename).
pub fn save(path: &Path, file: &FreeFile) -> Result<(), IoError> {
    let json = serde_json::to_string_pretty(file)?;
    let tmp = path.with_extension("free.tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile::format::{Fingerprint, FreeFile};

    fn sample_file() -> FreeFile {
        FreeFile::new(
            Fingerprint {
                filename: "movie.mkv".into(),
                size_bytes: 1000,
                container: "matroska".into(),
                codec: "hevc".into(),
                duration_ms: 60000,
                phash_samples: vec![],
            },
            "Test Profile",
        )
    }

    #[test]
    fn save_then_load_roundtrip() {
        let dir = std::env::temp_dir().join(format!("fvp-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.free");
        let file = sample_file();
        save(&path, &file).expect("save");
        let loaded = load(&path).expect("load");
        assert_eq!(file, loaded);
        std::fs::remove_dir_all(&dir).ok();
    }
}
