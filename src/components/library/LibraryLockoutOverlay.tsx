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
        "You can switch back to Client or Standalone anytime in Settings.",
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
            is running. Clarify when the diagnose says "become_host." */}
        {diagnosis?.suggested_action === "become_host" && (
          <details className="mb-3 text-[11px] text-fvp-muted">
            <summary className="cursor-pointer hover:text-fvp-text">
              Why doesn&apos;t my NAS count as the Host?
            </summary>
            <div className="mt-1.5 pl-3 border-l-2 border-fvp-border space-y-1.5 leading-relaxed">
              <p>
                In FVP, &quot;Host&quot; means the <em>device running the
                FVP library service</em> (the database + server). Your NAS
                stores the <em>media files</em> + the <em>home folder</em>{" "}
                (poster cache, snapshots, connection info), but it
                doesn&apos;t run FVP itself.
              </p>
              <p>
                Click <strong>Switch this device to Host</strong> below to
                run the library service on this device. Future iOS / Android
                / other-desktop clients on your LAN will connect to it. Your
                NAS keeps doing what it&apos;s doing — storing the media +
                home folder.
              </p>
              <p>
                <em>Caveat:</em> when this device is off, Clients can&apos;t
                reach the library. For 24/7 availability you&apos;d need an
                always-on device running FVP as Host (a future Linux build
                could run on the NAS itself, but that&apos;s not shipped yet).
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
          {diagnosis?.suggested_action === "become_host" && (
            <button
              onClick={() => void switchToHost()}
              disabled={becomingHost}
              className="flex-1 min-w-[160px] px-3 py-2 bg-fvp-ok text-white text-xs rounded hover:opacity-90 disabled:opacity-50"
            >
              {becomingHost ? "Switching…" : "Switch this device to Host"}
            </button>
          )}
          <button
            onClick={() => useAppStore.setState({ mode: "settings" })}
            className="px-3 py-2 bg-fvp-bg border border-fvp-border text-fvp-text text-xs rounded hover:border-fvp-muted"
          >
            Open Settings
          </button>
        </div>

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
