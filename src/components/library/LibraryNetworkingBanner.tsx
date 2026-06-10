import { useEffect, useState } from "react";
import {
  getHostEndpoint,
  getHostHealth,
  getLibraryMode,
  libraryIpc,
} from "../../ipc/library";

/**
 * Top-of-Library banner that surfaces Library Networking state when
 * it's relevant: Client mode + Host connectivity. In Standalone or
 * Host mode the banner stays hidden.
 *
 * Polls every 4s for the Host's health snapshot (cheap — purely
 * in-process). When the Host is failing, shows the "offline" state
 * with a retry button + the last-seen error. When healthy, stays
 * invisible to avoid distraction.
 *
 * Phase 3 enhancement (later): when offline, replace this with a
 * snapshot-load indicator + an explicit "edits are queued" message
 * once we persist the snapshot to local disk.
 */
export function LibraryNetworkingBanner() {
  const [, force] = useState(0);

  useEffect(() => {
    const t = window.setInterval(() => force((n) => n + 1), 4000);
    return () => window.clearInterval(t);
  }, []);

  const mode = getLibraryMode();
  if (mode !== "client") return null;

  const endpoint = getHostEndpoint();
  if (!endpoint) {
    return (
      <div className="bg-fvp-err/15 border-b border-fvp-err text-fvp-err text-xs px-3 py-1.5 flex items-center gap-2">
        <span className="font-semibold">⚠ Client mode</span>
        <span>
          No Host endpoint configured yet. Open Settings → Library
          Networking and pick a Host.
        </span>
      </div>
    );
  }

  const health = getHostHealth();
  // "ready" → quiet success pill; "stale" → red banner with retry;
  // "offline" → no banner here (the parent shows the LOCKOUT instead).
  if (health.connectivity === "stale") {
    return (
      <div className="bg-fvp-err/15 border-b border-fvp-err text-fvp-err text-xs px-3 py-1.5 flex items-center gap-2">
        <span className="font-semibold">⚠ Library Host offline</span>
        <span className="opacity-80">
          {health.lastFailureMessage ??
            "Last attempt to reach the Host failed."}
        </span>
        <button
          onClick={() => {
            void libraryIpc
              .testHostConnection(endpoint.url, endpoint.token)
              .then(() => force((n) => n + 1));
          }}
          className="ml-auto px-2 py-0.5 bg-fvp-bg border border-fvp-err rounded hover:bg-fvp-err/20"
        >
          Retry
        </button>
      </div>
    );
  }

  // Quiet "connected" pill when everything is fine — small enough not
  // to nag, but lets the user know they're not on local data.
  return (
    <div className="bg-fvp-ok/10 border-b border-fvp-ok/40 text-fvp-ok text-[11px] px-3 py-1 flex items-center gap-2">
      <span>✓ Library Host: {endpoint.url}</span>
    </div>
  );
}
