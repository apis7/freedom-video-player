/**
 * Black overlay + spinning red-white-blue ring shown while a video is
 * loading. Covers the libmpv HWND so the brief gap between "loadfile
 * was called" and "libmpv produced its first frame" doesn't reveal the
 * white desktop / dev terminal underneath the transparent Tauri window.
 *
 * Sized to fill its parent (parent must be `relative`); the spinner
 * floats in the center.
 *
 * Visual: conic-gradient ring cycling US-flag red → white → blue →
 * red, rotated continuously. ~64 px wide, soft.
 */
export function LoadingOverlay() {
  return (
    <div className="absolute inset-0 bg-black flex items-center justify-center z-20 pointer-events-none">
      <RwbSpinner />
    </div>
  );
}

/** The spinner on its own — exported so the legacy "Loading…" caption
 *  in other modal contexts can also use it. */
export function RwbSpinner() {
  return <div className="fvp-spinner-rwb" aria-label="Loading" role="status" />;
}
