//! Ed25519 signing for `.free` files.
//!
//! Signature is computed over the bytes of `serde_json::to_vec(&payload)`.
//! This relies on serde_json producing deterministic output for a given struct
//! definition + value — which it does within a single compiled binary. For
//! cross-binary verification we'd need a canonical JSON serializer; for now we
//! accept the tradeoff (good enough for local + same-app verification).

use crate::profile::format::FreeFile;
use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use rand::rngs::OsRng;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ProfileError {
    #[error("file is not signed")]
    Unsigned,
    #[error("signature is malformed")]
    BadSignature,
    #[error("public key is malformed")]
    BadPubkey,
    #[error("signature verification failed")]
    VerifyFailed,
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("base64: {0}")]
    Base64(#[from] base64::DecodeError),
}

/// Generate a fresh keypair.
pub fn generate_keypair() -> SigningKey {
    SigningKey::generate(&mut OsRng)
}

/// Encode a signing key's bytes (private). Treat the output as secret — that's the
/// material a user would back up in their uploader key file.
pub fn encode_signing_key(key: &SigningKey) -> String {
    B64.encode(key.to_bytes())
}

/// Decode a signing key from its base64-encoded private bytes.
pub fn decode_signing_key(s: &str) -> Result<SigningKey, ProfileError> {
    let bytes = B64.decode(s)?;
    let arr: [u8; 32] = bytes.as_slice().try_into().map_err(|_| ProfileError::BadPubkey)?;
    Ok(SigningKey::from_bytes(&arr))
}

/// Sign the file in place. Sets `signature` and `pubkey`. `uploader` is unchanged
/// (the caller controls when/how a handle is set).
pub fn sign(file: &mut FreeFile, key: &SigningKey) -> Result<(), ProfileError> {
    let bytes = serde_json::to_vec(&file.payload)?;
    let signature: Signature = key.sign(&bytes);
    file.signature = Some(B64.encode(signature.to_bytes()));
    file.pubkey = Some(B64.encode(key.verifying_key().to_bytes()));
    Ok(())
}

/// Verify the file's signature against its embedded public key.
/// Returns Ok(()) on success, Err on any failure (missing sig, malformed, mismatch).
pub fn verify(file: &FreeFile) -> Result<(), ProfileError> {
    let sig_b64 = file.signature.as_deref().ok_or(ProfileError::Unsigned)?;
    let pubkey_b64 = file.pubkey.as_deref().ok_or(ProfileError::Unsigned)?;

    let sig_bytes = B64.decode(sig_b64)?;
    let sig_arr: [u8; 64] = sig_bytes
        .as_slice()
        .try_into()
        .map_err(|_| ProfileError::BadSignature)?;
    let signature = Signature::from_bytes(&sig_arr);

    let pubkey_bytes = B64.decode(pubkey_b64)?;
    let pubkey_arr: [u8; 32] = pubkey_bytes
        .as_slice()
        .try_into()
        .map_err(|_| ProfileError::BadPubkey)?;
    let verifying_key = VerifyingKey::from_bytes(&pubkey_arr).map_err(|_| ProfileError::BadPubkey)?;

    let payload_bytes = serde_json::to_vec(&file.payload)?;
    verifying_key
        .verify(&payload_bytes, &signature)
        .map_err(|_| ProfileError::VerifyFailed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile::format::{FreeFile, Fingerprint, Snip, SnipAction};

    fn sample_file() -> FreeFile {
        let fingerprint = Fingerprint {
            filename: "movie.mkv".into(),
            size_bytes: 42_000_000,
            container: "matroska".into(),
            codec: "hevc".into(),
            duration_ms: 7_320_000,
            phash_samples: vec![],
        };
        let mut f = FreeFile::new(fingerprint, "Family Friendly");
        f.add_snip(Snip::new(60_000, 68_000, vec!["language".into()], SnipAction::Skip));
        f
    }

    #[test]
    fn sign_then_verify_roundtrip() {
        let key = generate_keypair();
        let mut file = sample_file();
        sign(&mut file, &key).expect("sign");
        verify(&file).expect("verify");
        assert!(file.signature.is_some());
        assert!(file.pubkey.is_some());
    }

    #[test]
    fn tampered_payload_fails_verification() {
        let key = generate_keypair();
        let mut file = sample_file();
        sign(&mut file, &key).expect("sign");
        // Tamper: flip an end_ms.
        file.payload.snips[0].end_ms = 99_999;
        let result = verify(&file);
        assert!(matches!(result, Err(ProfileError::VerifyFailed)));
    }

    #[test]
    fn unsigned_file_fails_verify() {
        let file = sample_file();
        let result = verify(&file);
        assert!(matches!(result, Err(ProfileError::Unsigned)));
    }

    #[test]
    fn key_encode_decode_roundtrip() {
        let key = generate_keypair();
        let encoded = encode_signing_key(&key);
        let decoded = decode_signing_key(&encoded).expect("decode");
        assert_eq!(key.to_bytes(), decoded.to_bytes());
    }

    #[test]
    fn signed_file_serializes_and_re_verifies() {
        let key = generate_keypair();
        let mut file = sample_file();
        sign(&mut file, &key).expect("sign");
        let json = serde_json::to_string(&file).expect("serialize");
        let reloaded: FreeFile = serde_json::from_str(&json).expect("deserialize");
        verify(&reloaded).expect("reloaded verify");
    }
}
