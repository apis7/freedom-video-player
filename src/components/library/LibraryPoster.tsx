import { convertFileSrc } from "@tauri-apps/api/core";
import { useState } from "react";
import { useAppStore } from "../../state/appStore";
import { getHostEndpoint, getLibraryMode } from "../../ipc/library";

interface Props {
  /** Custom thumbnail set by the user (takes precedence over TMDb poster). */
  customThumbnailPath: string | null;
  /** Cached TMDb poster path. */
  posterLocalPath: string | null;
  /** Width in px; height derives from 2:3 movie-poster aspect. */
  widthPx: number;
  /** Optional ARIA label fallback when neither image is available. */
  alt?: string;
  /** When true, file is missing on disk — overlay a red X badge. The
   *  underlying poster image still renders so visual recognition holds,
   *  but the badge makes "this won't play" unmistakable at a glance. */
  isMissing?: boolean;
  /** Cache-buster appended to the image URL so the webview reloads
   *  whenever the underlying file changes. Pass `identity.last_updated_at`
   *  — the backend bumps it on every set_custom_thumbnail and
   *  apply_tmdb_id write. Without this, overwriting a thumb file at the
   *  same path (the bulk "Set custom thumbnail" path does exactly that)
   *  leaves stale images on screen because the URL is unchanged. */
  cacheKey?: number | string | null;
}

/**
 * Renders a movie's poster from the local cache. Falls back to the plain
 * placeholder (a cinema-camera silhouette) when neither a custom thumbnail
 * nor a cached TMDb poster is available. Per locked decision: NO
 * video-frame screenshot generation in V1.
 *
 * Perf note: the previous version fetched bytes via Tauri IPC and built a
 * blob URL — for 1000+ posters that meant 1000+ IPC round-trips and the
 * `Vec<u8>` JSON serialization tax (50 KB poster ≈ 200 KB JSON). We now
 * use `convertFileSrc()` to expose the poster cache as `asset://` URLs
 * the webview loads directly. The poster-cache directory is whitelisted
 * in tauri.conf.json under `app.security.assetProtocol.scope`.
 */
export function LibraryPoster({
  customThumbnailPath,
  posterLocalPath,
  widthPx,
  alt = "",
  isMissing = false,
  cacheKey = null,
}: Props) {
  const source = customThumbnailPath || posterLocalPath || null;
  const [loadError, setLoadError] = useState(false);
  // Subscribe to the global thumbnail-refresh epoch. Bumped after bulk
  // thumbnail writes so EVERY grid poster picks up the new cacheKey,
  // not just the cell whose details panel is currently mounted. Solves
  // the "12 wrote successfully but only the selected one visually
  // updated" bug. Cheap subscription — no perf concern with 1000+
  // posters since Zustand only re-renders on value change.
  const epoch = useAppStore((s) => s.thumbnailRefreshEpoch);
  const baseUrl = source ? resolveImageUrl(source) : null;
  // Combine cacheKey with epoch so a bulk write reliably busts the
  // webview's image cache even when last_updated_at lands in the same
  // second across multiple bumped identities.
  const effectiveKey =
    cacheKey != null ? `${cacheKey}-${epoch}` : epoch > 0 ? `${epoch}` : null;
  const url =
    baseUrl && effectiveKey != null
      ? `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}v=${effectiveKey}`
      : baseUrl;

  const heightPx = Math.round(widthPx * 1.5);
  const style = { width: widthPx, height: heightPx };
  const showImage = !!url && !loadError;

  const inner = showImage ? (
    <img
      src={url!}
      alt={alt}
      draggable={false}
      loading="lazy"
      className={
        "rounded shadow object-cover bg-fvp-bg select-none w-full h-full" +
        (isMissing ? " opacity-50 grayscale" : "")
      }
      onError={() => setLoadError(true)}
    />
  ) : isMissing ? (
    // Missing placeholder: red-circle-X in a muted card.
    <div className="rounded bg-fvp-surface2 border border-fvp-border flex items-center justify-center select-none w-full h-full">
      <svg
        viewBox="0 0 64 64"
        width={Math.max(44, widthPx * 0.7)}
        height={Math.max(44, widthPx * 0.7)}
        className="text-fvp-err opacity-80"
        fill="none"
        aria-hidden="true"
      >
        <circle cx="32" cy="32" r="26" stroke="currentColor" strokeWidth="4" />
        <path d="M22 22 L42 42 M42 22 L22 42" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
      </svg>
    </div>
  ) : (
    // Default placeholder: vintage cinema-camera silhouette.
    <div className="rounded bg-fvp-surface2 border border-fvp-border flex items-center justify-center select-none w-full h-full">
      <svg
        viewBox="0 0 64 48"
        width={Math.max(36, widthPx * 0.6)}
        height={Math.max(27, widthPx * 0.45)}
        className="text-fvp-muted opacity-70"
        fill="currentColor"
        aria-hidden="true"
      >
        <circle cx="20" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="2.5" />
        <circle cx="20" cy="10" r="2" />
        <circle cx="40" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="2.5" />
        <circle cx="40" cy="10" r="2" />
        <rect x="6" y="20" width="40" height="22" rx="2" />
        <rect x="46" y="26" width="14" height="10" rx="1" />
        <rect x="10" y="14" width="6" height="4" />
      </svg>
    </div>
  );

  return (
    <div className="relative" style={style} aria-label={alt}>
      {inner}
      {/* Missing-file badge: overlaid on top of (greyed) poster so the
          user can still recognize the title visually. */}
      {isMissing && showImage && (
        <div
          className="absolute top-1 left-1 w-7 h-7 rounded-full bg-fvp-err border-2 border-white/80 flex items-center justify-center text-white text-base font-bold shadow-lg pointer-events-none"
          title="File location is broken — double-click to recover"
        >
          ✕
        </div>
      )}
    </div>
  );
}

/**
 * Build the URL for an image whose absolute path lives on the Host. In
 * Host or Standalone mode that's the local filesystem (use Tauri's
 * asset:// protocol). In Client mode the path likely points at a
 * directory the Client can't see, so we route through the Host's
 * GET /v1/poster endpoint instead — auth via query param because
 * <img> tags can't send custom headers.
 *
 * Falls back to asset:// when Client mode lacks a configured endpoint
 * (the lockout overlay should already be covering the user in that
 * case, but rendering an asset:// URL is still less broken than null).
 */
function resolveImageUrl(absolutePath: string): string {
  if (getLibraryMode() === "client") {
    const ep = getHostEndpoint();
    if (ep) {
      const base = ep.url.replace(/\/+$/, "");
      return (
        `${base}/v1/poster?path=${encodeURIComponent(absolutePath)}` +
        `&auth=${encodeURIComponent(ep.token)}`
      );
    }
  }
  return convertFileSrc(absolutePath);
}
