//! dHash (difference hash) — simple perceptual hash that survives small
//! visual changes (compression, slight crop, brightness drift) so two
//! fingerprints can be matched across re-encodings of the same source.
//!
//! Algorithm: downsample to 9x8 grayscale, then for each of the 8 rows
//! compare adjacent pixels left-to-right (8 comparisons per row → 64 bits).
//! Hamming distance between two hashes = number of differing bits.

use image::imageops::FilterType;
use image::ImageReader;
use std::path::Path;

pub fn dhash_image_file(path: &Path) -> Result<u64, String> {
    let img = ImageReader::open(path)
        .map_err(|e| format!("open image {}: {e}", path.display()))?
        .decode()
        .map_err(|e| format!("decode image {}: {e}", path.display()))?;
    let small = img.resize_exact(9, 8, FilterType::Triangle).to_luma8();
    let pixels = small.into_raw();
    let mut hash: u64 = 0;
    for row in 0..8usize {
        for col in 0..8usize {
            let left = pixels[row * 9 + col];
            let right = pixels[row * 9 + col + 1];
            if left > right {
                hash |= 1u64 << (row * 8 + col);
            }
        }
    }
    Ok(hash)
}

/// Hamming distance between two 64-bit dHashes (number of differing bits).
/// 0 = identical visual content, 64 = totally different. Per dHash research,
/// distances under ~10 typically indicate the same source.
pub fn hamming_distance(a: u64, b: u64) -> u32 {
    (a ^ b).count_ones()
}

pub fn parse_hex_hash(s: &str) -> Option<u64> {
    u64::from_str_radix(s, 16).ok()
}

pub fn format_hash(h: u64) -> String {
    format!("{h:016x}")
}
