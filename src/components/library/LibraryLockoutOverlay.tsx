import { useEffect, useState, useSyncExternalStore } from "react";
import { useAppStore } from "../../state/appStore";
import {
  getHostConnectivity,
  getHostEndpoint,
  getHostHealth,
  getHostStateVersion,
  getLibraryMode,
  libraryIpc,
  readHomeDiscovery,
  setHostEndpoint,
  setLibraryMode,
  subscribeHostState,
  type HomeFolderDiagnosis,
} from "../../ipc/library";

const AUTO_REFRESH_MS = 120_000; // 2 minutes per directive

/**
 * Full-area lockout shown inside Library Mode when:
 *   - this install is configured as a Client
 *   - we haven't successfully contacted the Host this session
 *
 * Rationale: without a working Host, every list_items / metadata /
 * file path lookup will fail or return stale garbage. Rather than
 * showing a sea of "broken link" rows, we lock the Library content
 * area and tell the user the Host can't be reached. Player Mode and
 * Profile Creator Mode are still usable (mode switching is via the
 * title bar / hotkeys, both outside this overlay).
 *
 * Auto-retries every 2 minutes; user can also retry manually. On
 * success, the parent unmounts this overlay and the normal Library
 * renders. Once we've connected at least once in this session, a
 * subsequent Host outage drops back to the banner (the user has data
 * to keep using, even if stale).
 */
export function LibraryLockoutOverlay({
  onResolved,
}: {
  onResolved: () => void;
}) {
  const showToast = useAppStore((s) => s.showToast);
  const [busy, setBusy] = useState(false);
  const [lastAttemptAt, setLastAttemptAt] = useState<number | null>(null);
  const [lastAttemptResult, setLastAttemptResult] = useState<
    "unknown" | "reachable" | "unreachable" | "bad_auth"
  >("unknown");
  const [diagnosis, setDiagnosis] = useState<HomeFolderDiagnosis | null>(null);
  const [becomingHost, setBecomingHost] = useState(false);

  // Subscribe to libraryHostClient's state version. Re-renders this
  // component when getHostConnectivity changes (e.g., a list_items
  // call in some OTHER part of the app succeeds, flipping us out of
  // offline state — we should auto-dismiss).
  useSyncExternalStore(subscribeHostState, getHostStateVersion);

  const attempt = async () => {
    setBusy(true);
    // Diagnose home folder state first — gives us specific error
    // categories instead of a generic "unreachable."
    try {
      const d = await libraryIpc.diagnoseHomeFolder();
      setDiagnosis(d);
    } catch {
      /* non-fatal */
    }
    const ep = getHostEndpoint();
    // If we don't have an endpoint configured, re-try auto-discovery
    // (the home folder may have come online).
    let url = ep?.url ?? null;
    let token = ep?.token ?? null;
    if (!url || !token) {
      try {
        const d = await readHomeDiscovery();
        if (d) {
          url = d.host_url;
          token = d.token;
          setHostEndpoint({ url, token });
        }
      } catch {
        /* fall through to attempt result */
      }
    }
    if (!url) {
      setLastAttemptAt(Date.now());
      setLastAttemptResult("unreachable");
      setBusy(false);
      return;
    }
    try {
      const r = await libraryIpc.testHostConnection(url, token);
      setLastAttemptAt(Date.now());
      if (!r.reachable) {
        setLastAttemptResult("unreachable");
      } else if (r.authenticated === false) {
        setLastAttemptResult("bad_auth");
      } else {
        setLastAttemptResult("reachable");
        // /v1/health doesn't go through clientCall, so it didn't bump
        // lastSuccessAt. Pull list_items now to actually mark the
        // session online (and warm the data the UI is about to need).
        try {
          await libraryIpc.listItems();
          showToast("Library Host reconnected.", "info", 2000);
          onResolved();
        } catch (e) {
          // Health says OK but the auth'd endpoint failed — bad
          // token or token mismatch.
          setLastAttemptResult("bad_auth");
          console.log(`[fvp] lockout: list_items failed post-health: ${e}`);
        }
      }
    } catch (e) {
      setLastAttemptAt(Date.now());
      setLastAttemptResult("unreachable");
      console.log(`[fvp] lockout attempt failed: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  // Auto-retry loop. Fires immediately on mount, then every
  // AUTO_REFRESH_MS. Cleared on unmount (e.g., when the parent
  // dismisses us because connectivity flipped).
  useEffect(() => {
    void attempt();
    const t = window.setInterval(() => {
      void attempt();
    }, AUTO_REFRESH_MS);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // If a list_items call elsewhere succeeded, getHostConnectivity is
  // now "ready" — bow out so the normal Library renders. Subscribed
  // to stateVersion via useSyncExternalStore above, so this fires
  // when host state actually changes (NOT every render — empty deps
  // here without that subscription would loop).
  const stateVersion = getHostStateVersion();
  useEffect(() => {
    if (getHostConnectivity() === "ready") {
      onResolved();
    }
  }, [stateVersion, onResolved]);

  const health = getHostHealth();
  const ep = getHostEndpoint();

  // Pick the headline + body based on the most informative source.
  // Order of preference:
  //   1. diagnose result (most specific — distinguishes
  //      "folder unreachable" from "no Host registered" from
  //      "Host registered but offline")
  //   2. raw lastAttemptResult ("unreachable" / "bad_auth")
  const headline = diagnosis
    ? diagnosisHeadline(diagnosis)
    : "Library Host unreachable";
  const body = diagnosis?.summary ?? null;

  const switchToHost = async () => {
    if (!window.confirm(
      "Switch this device to Library Host mode?\n\n" +
        "This device will become the source of truth for the library DB. " +
        "Other devices on your network can then connect to it as Clients " +
        "by pointing at the same home folder.\n\n" +
        "You can switch back anytime in Settings.",
    )) return;
    setBecomingHost(true);
    try {
      await libraryIpc.setMode("host");
      setLibraryMode("host");
      showToast("Switched to Host mode. Library should be available now.", "info", 3500);
      onResolved();
    } catch (err) {
      showToast(`Switch failed: ${err}`, "error");
    } finally {
      setBecomingHost(false);
    }
  };

  const switchToSync = async () => {
    if (!window.confirm(
      "Switch this device to Sync mode?\n\n" +
        "Your library DB will live LOCALLY on this device, and mirror to " +
        "the home folder on your NAS every 5 minutes. Other devices that " +
        "later point at the same folder (also in Sync mode) will stay " +
        "in step via the mirror. No 'always-on Host' needed.\n\n" +
        "Best fit when your media is on a NAS but you don't have an " +
        "always-on computer to act as Host. Concurrent edits use last-" +
        "writer-wins; single-user-one-device-at-a-time is the sweet spot.",
    )) return;
    setBecomingHost(true);
    try {
      await libraryIpc.setMode("sync");
      setLibraryMode("sync");
      showToast("Switched to Sync mode. Library is available again.", "info", 3500);
      onResolved();
    } catch (err) {
      showToast(`Switch failed: ${err}`, "error");
    } finally {
      setBecomingHost(false);
    }
  };

  return (
    <div className="flex-1 flex items-center justify-center bg-fvp-bg p-8 overflow-y-auto">
      <div className="max-w-xl w-full bg-fvp-surface border border-fvp-border rounded-lg p-6 shadow-xl">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-full bg-fvp-err/20 border border-fvp-err flex items-center justify-center text-fvp-err text-xl">
            ⚠
          </div>
          <div>
            <h2 className="text-base font-semibold text-fvp-text">
              {headline}
            </h2>
            <p className="text-[11px] text-fvp-muted mt-0.5">
              This install is in Client mode — without a working Host
              the Library is locked to prevent broken-link rows
              everywhere.
            </p>
          </div>
        </div>

        {body && (
          <div className="mb-3 px-3 py-2 bg-fvp-warn/10 border border-fvp-warn text-fvp-text text-xs rounded leading-relaxed">
            {body}
          </div>
        )}

        {/* Common confusion: users with a NAS hosting their media think
            the NAS is the "Host." It isn't — the Host is wherever FVP
            is running. Plus: sync mode is often what they actually want. */}
        {diagnosis?.suggested_action === "become_host" && (
          <details className="mb-3 text-[11px] text-fvp-muted">
            <summary className="cursor-pointer hover:text-fvp-text">
              Why doesn&apos;t my NAS count as the Host? &nbsp;
              <span className="text-fvp-muted/70">
                (and which mode should I pick?)
              </span>
            </summary>
            <div className="mt-1.5 pl-3 border-l-2 border-fvp-border space-y-2 leading-relaxed">
              <p>
                In FVP, &quot;Host&quot; means the <em>device running the
                FVP library service</em> (the database + server). Your NAS
                stores the <em>media files</em> + the <em>home folder</em>,
                but it doesn&apos;t run FVP itself.
              </p>
              <p>
                <strong className="text-fvp-text">Three ways to fix this:</strong>
              </p>
              <div className="pl-2 space-y-1.5">
                <p>
                  <strong className="text-fvp-ok">🔄 Sync mode</strong>{" "}
                  (recommended when no FVP device is always on) — this
                  device does all the library work locally, mirrors the
                  DB to the NAS every 5 minutes. Other devices pull the
                  mirror when they launch. No always-on Host required.
                </p>
                <p>
                  <strong className="text-fvp-accent">📡 Host mode</strong>{" "}
                  — this device IS the Host. Best when this device is
                  usually on. Other devices connect as live Clients;
                  they lock out when this device is off.
                </p>
                <p>
                  <strong className="text-fvp-muted">Stay as Client</strong>{" "}
                  — another device on your LAN registers as the live Host
                  first. Pointless if no other FVP install exists.
                </p>
              </div>
              <p className="text-[10px] italic">
                Caveat for both Host and Sync: a future Linux/headless
                FVP build could run on the NAS itself, giving you 24/7
                multi-device. Not shipped yet.
              </p>
            </div>
          </details>
        )}

        {/* Concrete state — checkboxes give the user a fast visual
            scan of what's working and what's not. */}
        {diagnosis && (
          <div className="text-[11px] space-y-1 mb-4 px-3 py-2 bg-fvp-bg border border-fvp-border rounded">
            <CheckRow ok={diagnosis.home_folder_set} label="Home folder configured" />
            <CheckRow
              ok={diagnosis.home_folder_reachable}
              label="Home folder reachable"
              detail={diagnosis.home_folder_path ?? undefined}
            />
            <CheckRow
              ok={
                diagnosis.discovery_file_exists &&
                !diagnosis.discovery_file_is_placeholder
              }
              label="Host discovery file valid"
              detail={
                !diagnosis.discovery_file_exists
                  ? "no discovery file"
                  : diagnosis.discovery_file_is_placeholder
                    ? "placeholder only — no Host has registered"
                    : diagnosis.host_address ?? undefined
              }
            />
            <CheckRow
              ok={diagnosis.auth_token_nonempty}
              label="Auth token file present"
            />
          </div>
        )}

        <div className="text-xs space-y-1 mb-4">
          <div className="flex gap-2">
            <span className="text-fvp-muted w-28">Configured Host:</span>
            <span className="font-mono break-all flex-1">
              {ep?.url ?? "(no endpoint configured)"}
            </span>
          </div>
          <div className="flex gap-2">
            <span className="text-fvp-muted w-28">Last attempt:</span>
            <span className="flex-1">
              {lastAttemptAt
                ? `${Math.max(
                    0,
                    Math.round((Date.now() - lastAttemptAt) / 1000),
                  )}s ago`
                : "(retrying…)"}{" "}
              ·{" "}
              {lastAttemptResult === "unknown"
                ? "—"
                : lastAttemptResult === "unreachable"
                  ? "unreachable"
                  : lastAttemptResult === "bad_auth"
                    ? "reachable but auth failed"
                    : "reachable"}
            </span>
          </div>
          {health.lastFailureMessage && (
            <div className="flex gap-2">
              <span className="text-fvp-muted w-28">Detail:</span>
              <span className="font-mono text-[10px] text-fvp-err break-all flex-1">
                {health.lastFailureMessage}
              </span>
            </div>
          )}
          <div className="flex gap-2 pt-2 text-[11px] text-fvp-muted italic">
            Player and Profile Creator still work — switch modes from the
            title bar. Auto-retrying every 2 minutes.
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => void attempt()}
            disabled={busy}
            className="flex-1 min-w-[120px] px-3 py-2 bg-fvp-accent text-white text-xs rounded hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Trying…" : "Retry now"}
          </button>
          <button
            onClick={() => useAppStore.setState({ mode: "settings" })}
            className="px-3 py-2 bg-fvp-bg border border-fvp-border text-fvp-text text-xs rounded hover:border-fvp-muted"
          >
            Open Settings
          </button>
        </div>

        {/* Mode-change escape hatches — laid out below the retry/settings
            row so the user sees them as a "or rethink your setup"
            choice rather than the primary action. Both buttons confirm
            before flipping the mode. */}
        {diagnosis?.suggested_action === "become_host" && (
          <div className="mt-3 pt-3 border-t border-fvp-border space-y-2">
            <div className="text-[11px] text-fvp-muted uppercase tracking-wider">
              Or change how this device handles the library
            </div>
            <div className="grid sm:grid-cols-2 gap-2">
              <button
                onClick={() => void switchToSync()}
                disabled={becomingHost}
                className="text-left px-3 py-2 bg-fvp-ok/10 border border-fvp-ok rounded hover:bg-fvp-ok/20 disabled:opacity-50 group"
              >
                <div className="text-fvp-ok font-semibold text-xs">
                  🔄 Switch to Sync mode
                </div>
                <div className="text-[10px] text-fvp-muted mt-0.5 leading-snug">
                  This device does all the work. Mirrors DB to the NAS
                  every 5 min. No "always-on Host" required.
                </div>
              </button>
              <button
                onClick={() => void switchToHost()}
                disabled={becomingHost}
                className="text-left px-3 py-2 bg-fvp-accent/10 border border-fvp-accent rounded hover:bg-fvp-accent/20 disabled:opacity-50 group"
              >
                <div className="text-fvp-accent font-semibold text-xs">
                  📡 Switch to Host mode
                </div>
                <div className="text-[10px] text-fvp-muted mt-0.5 leading-snug">
                  This device runs the live library service. Other
                  devices connect as Clients. Best if this one's always
                  on.
                </div>
              </button>
            </div>
          </div>
        )}

        {lastAttemptResult === "bad_auth" && (
          <div className="mt-3 px-2 py-1.5 bg-fvp-err/10 border border-fvp-err text-fvp-err text-[11px] rounded">
            Host is reachable but rejected the auth token. The Host owner
            may have rotated the token — re-read it from the home
            folder, or paste it manually in Settings.
          </div>
        )}
      </div>
    </div>
  );
}

function diagnosisHeadline(d: HomeFolderDiagnosis): string {
  if (!d.home_folder_set) return "Home folder not set";
  if (!d.home_folder_reachable) return "Home folder unreachable";
  if (d.discovery_file_is_placeholder || !d.host_address) {
    return "No Host registered in home folder";
  }
  return "Library Host offline";
}

function CheckRow({
  ok,
  label,
  detail,
}: {
  ok: boolean;
  label: string;
  detail?: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <span
        className={
          "shrink-0 w-3.5 text-center font-bold " +
          (ok ? "text-fvp-ok" : "text-fvp-err")
        }
      >
        {ok ? "✓" : "✗"}
      </span>
      <span className="text-fvp-text">{label}</span>
      {detail && (
        <span className="text-fvp-muted text-[10px] italic break-all flex-1 min-w-0">
          {detail}
        </span>
      )}
    </div>
  );
}

/**
 * Boolean helper for parents to decide whether to show the lockout.
 * Use this instead of poking libraryHostClient directly so the call
 * site participates in the state subscription.
 */
export function useShouldLockLibrary(): boolean {
  useSyncExternalStore(subscribeHostState, getHostStateVersion);
  return (
    getLibraryMode() === "client" && getHostConnectivity() === "offline"
  );
}
