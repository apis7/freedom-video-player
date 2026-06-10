import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  getHostEndpoint,
  getHostHealth,
  getHostStateVersion,
  getLibraryMode,
  libraryIpc,
  subscribeHostState,
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
  // Re-render when libraryHostClient's state version bumps (success,
  // failure, mode change, endpoint change). Replaces the prior 4s
  // polling interval — no wasted renders, no up-to-4s lag.
  useSyncExternalStore(subscribeHostState, getHostStateVersion);
  const [hostInfo, setHostInfo] = useState<{
    fvpVersion: string | null;
    protocol: number | null;
    latencyMs: number;
  } | null>(null);
  const probedFor = useRef<string | null>(null);

  // Probe /v1/health ONCE per host endpoint URL so the "Connected to…"
  // pill can show the FVP version + protocol the Host reported. Re-
  // probes when the endpoint URL changes. Cheap (one HTTP call), and
  // information already exposed unauthenticated.
  useEffect(() => {
    const ep = getHostEndpoint();
    if (!ep || getLibraryMode() !== "client") {
      setHostInfo(null);
      probedFor.current = null;
      return;
    }
    if (probedFor.current === ep.url) return;
    probedFor.current = ep.url;
    void libraryIpc
      .testHostConnection(ep.url, ep.token)
      .then((r) => {
        if (!r.reachable) return;
        setHostInfo({
          fvpVersion: r.fvp_version,
          protocol: r.protocol,
          latencyMs: r.elapsed_ms,
        });
      })
      .catch(() => setHostInfo(null));
  });

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
            // testHostConnection's success bumps the stateVersion via
            // clientCall's notify(), which re-renders this component
            // through useSyncExternalStore. No manual force needed.
            void libraryIpc.testHostConnection(endpoint.url, endpoint.token);
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
      {hostInfo && (
        <span className="text-fvp-ok/80">
          · FVP {hostInfo.fvpVersion ?? "?"} · protocol v
          {hostInfo.protocol ?? "?"} · {hostInfo.latencyMs}ms
        </span>
      )}
    </div>
  );
}
