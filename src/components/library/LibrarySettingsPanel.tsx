import { useCallback, useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../../state/appStore";
import {
  libraryIpc,
  readHomeDiscovery,
  setHostEndpoint,
  setLibraryMode,
  type HostConnectionTestResult,
  type HostServerStatus,
  type LibrarySettingsSnapshot,
  type SnapshotStatus,
  type WatchedFolder,
} from "../../ipc/library";
// PinPromptModal usage moved to FamilyViewPinSection.

/**
 * Library section embedded in the Settings page. Manages:
 *   - Library on/off toggle (Player Mode behavior unchanged when off)
 *   - Family-View PIN: set, change, clear (PIN-gated per directive)
 *   - Family-View capability: requires a PIN; once enabled, the runtime
 *     toggle appears in the Library header
 *   - Clock format (12h / 24h)
 *   - Default Delete behavior (remove from library / send to recycle bin)
 *   - Poster cache cap (MB) + current cache size display
 *
 * All writes go through Tauri commands; UI re-fetches the snapshot after
 * each successful write so what you see always matches what's on disk.
 */
export function LibrarySettingsPanel() {
  const libraryEnabled = useAppStore((s) => s.libraryEnabled);
  const setLibraryEnabled = useAppStore((s) => s.setLibraryEnabled);
  const showToast = useAppStore((s) => s.showToast);

  const [snap, setSnap] = useState<LibrarySettingsSnapshot | null>(null);
  const [folders, setFolders] = useState<WatchedFolder[]>([]);
  const [showDisableLibraryConfirm, setShowDisableLibraryConfirm] =
    useState(false);
  // PIN management moved to its own section at the top of Settings
  // — see FamilyViewPinSection. Kept here historically because the
  // PIN was originally a library-mode toggle; user wants it prominent
  // now so it owns the top of Settings as its own thing.

  const reload = useCallback(async () => {
    try {
      const fresh = await libraryIpc.getSettings();
      setSnap(fresh);
      // Re-wire the libInvoke routing whenever mode or endpoint can
      // change. This makes mid-session role switches take effect
      // without an app relaunch.
      setLibraryMode(fresh.library_mode);
      if (fresh.library_mode === "client") {
        let endpoint: { url: string; token: string } | null = null;
        if (fresh.home_folder_path && fresh.home_folder_exists) {
          try {
            const d = await readHomeDiscovery();
            if (d) endpoint = { url: d.host_url, token: d.token };
          } catch {
            /* fall back to manual */
          }
        }
        if (!endpoint && fresh.host_address && fresh.host_auth_token) {
          endpoint = {
            url: fresh.host_address,
            token: fresh.host_auth_token,
          };
        }
        setHostEndpoint(endpoint);
      } else {
        setHostEndpoint(null);
      }
      setFolders(await libraryIpc.listFolders());
    } catch (err) {
      showToast(`Load library settings failed: ${err}`, "error");
    }
  }, [showToast]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const addFolder = async () => {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked !== "string") return;
    try {
      await libraryIpc.addFolder(picked, true);
      await reload();
      showToast(`Added folder: ${picked}`, "info", 2500);
    } catch (err) {
      showToast(`Add folder failed: ${err}`, "error");
    }
  };
  const removeFolder = async (f: WatchedFolder) => {
    const deleteItems = window.confirm(
      `Remove "${f.path}" from the library?\n\n` +
        `OK to also drop its indexed items from the library DB.\n` +
        `Cancel to just stop watching (items stay indexed).`,
    );
    try {
      await libraryIpc.removeFolder(f.id, deleteItems);
      await reload();
    } catch (err) {
      showToast(`Remove failed: ${err}`, "error");
    }
  };

  return (
    <section className="space-y-4 text-sm">
      <div>
        <h3 className="text-base font-semibold text-fvp-text">Library</h3>
        <p className="text-[11px] text-fvp-muted mt-0.5">
          Index your video folders, track watch progress, run the Movie Roulette,
          and (optionally) lock down Family View with a PIN.
        </p>
      </div>

      <label
        className="flex items-center gap-2 cursor-pointer"
        onClickCapture={(e) => {
          // Window.confirm proved unreliable inside the WebView2 host
          // (the toggle would flip and confirm wouldn't pop). Use a
          // proper React modal instead; intercept the click on the
          // LABEL (which is what fires the checkbox toggle in HTML)
          // so we can show the modal BEFORE the input's checked state
          // mutates. Turning ON is safe so it bypasses this path.
          if (libraryEnabled) {
            e.preventDefault();
            e.stopPropagation();
            setShowDisableLibraryConfirm(true);
          }
        }}
      >
        <input
          type="checkbox"
          checked={libraryEnabled}
          // Real toggle path runs only when the modal is bypassed (the
          // "turning on" case). When turning off, the label's
          // onClickCapture short-circuits before onChange ever runs.
          onChange={(e) => setLibraryEnabled(e.target.checked)}
          className="accent-fvp-accent"
        />
        <span>Enable Library Mode</span>
      </label>
      {showDisableLibraryConfirm && (
        <ConfirmModal
          title="Turn off Library Mode?"
          body="The Library tab will disappear and FVP will boot straight into Player Mode. Your indexed library, tags, and collections are kept — re-enabling brings them back as they were."
          confirmLabel="Turn off"
          confirmKind="danger"
          onCancel={() => setShowDisableLibraryConfirm(false)}
          onConfirm={() => {
            setLibraryEnabled(false);
            setShowDisableLibraryConfirm(false);
          }}
        />
      )}
      <p className="text-[11px] text-fvp-muted -mt-2 ml-6">
        When off, the Library tab is hidden and FVP boots straight into Player Mode.
      </p>

      {snap && libraryEnabled && (
        <>
          <Divider />
          <LibraryNetworkingSection snap={snap} reload={reload} />

          <Divider />

          <SubHeading>Watched folders</SubHeading>
          <p className="text-[11px] text-fvp-muted">
            Folders FVP scans for video files. Add or remove here; FVP
            watches for file changes in the background and re-indexes
            automatically.
          </p>
          <div className="space-y-1">
            {folders.length === 0 && (
              <div className="text-[11px] text-fvp-muted italic">
                No folders watched yet.
              </div>
            )}
            {folders.map((f) => (
              <div
                key={f.id}
                className="flex items-center gap-2 px-2 py-1.5 bg-fvp-bg border border-fvp-border rounded text-xs"
              >
                <span className="flex-1 font-mono break-all">{f.path}</span>
                <label
                  className="flex items-center gap-1 text-[10px] text-fvp-muted shrink-0 cursor-pointer hover:text-fvp-text"
                  title="When on, FVP scans this folder during app startup. When off, it stays watched but you trigger scans manually with the Rescan button. Network shares are slow to enumerate, so most users leave this off."
                >
                  <input
                    type="checkbox"
                    checked={f.scan_on_startup}
                    onChange={(e) => {
                      void libraryIpc
                        .setFolderScanOnStartup(f.id, e.target.checked)
                        .then(reload)
                        .catch((err) =>
                          showToast(`${err}`, "error"),
                        );
                    }}
                    className="accent-fvp-accent"
                  />
                  Scan on startup
                </label>
                <span className="text-[10px] text-fvp-muted shrink-0">
                  added {new Date(f.added_at * 1000).toLocaleDateString()}
                </span>
                <button
                  onClick={() => void removeFolder(f)}
                  className="px-2 py-0.5 text-fvp-err hover:bg-fvp-err/10 rounded shrink-0"
                  title="Remove this folder"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
          <button
            onClick={() => void addFolder()}
            className="px-3 py-1.5 bg-fvp-accent text-white text-xs rounded hover:opacity-90"
          >
            + Add folder…
          </button>

          <Divider />
          <SubHeading>Display</SubHeading>
          <div className="flex items-center gap-3">
            <span className="text-xs text-fvp-muted">Clock format:</span>
            <select
              value={snap.clock_format}
              onChange={(e) => {
                void libraryIpc
                  .setClockFormat(e.target.value as "12h" | "24h")
                  .then(reload)
                  .catch((err) => showToast(`${err}`, "error"));
              }}
              className="bg-fvp-bg border border-fvp-border rounded px-2 py-1 text-xs"
            >
              <option value="12h">12-hour</option>
              <option value="24h">24-hour</option>
            </select>
          </div>

          <Divider />
          <SnapshotBackupSection />

          <Divider />
          <SubHeading>Delete key default</SubHeading>
          <div className="flex items-center gap-3">
            <select
              value={snap.delete_default}
              onChange={(e) => {
                void libraryIpc
                  .setDeleteDefault(e.target.value as "remove" | "recycle")
                  .then(reload)
                  .catch((err) => showToast(`${err}`, "error"));
              }}
              className="bg-fvp-bg border border-fvp-border rounded px-2 py-1 text-xs"
            >
              <option value="remove">Remove from library only</option>
              <option value="recycle">Send file to Recycle Bin</option>
            </select>
          </div>
          <p className="text-[11px] text-fvp-muted">
            What pressing Delete in the Library does by default. Both options are
            always offered when the key is pressed.
          </p>

          <Divider />
          <SubHeading>FVP Hub (coming soon)</SubHeading>
          <p className="text-[11px] text-fvp-muted">
            The sharing site for community-built profiles + recommendations.
            These toggles are placeholders for Chapter 2 — they do nothing yet.
          </p>
          <label className="flex items-start gap-2 cursor-pointer">
            <input type="checkbox" disabled className="accent-fvp-accent mt-0.5" />
            <span>
              Anonymously share library ratings to power the Hub&apos;s recommendations
            </span>
          </label>
          <a
            href="https://example.invalid/fvp"
            onClick={(e) => {
              e.preventDefault();
              showToast(
                "FVP website launches with Chapter 2.",
                "info",
                3000,
              );
            }}
            className="text-xs text-fvp-accent hover:underline cursor-pointer"
          >
            Visit FVP website ↗
          </a>

          <Divider />
          <SubHeading>Poster cache</SubHeading>
          <div className="text-[11px] text-fvp-muted">
            Currently using {(snap.poster_cache_size_bytes / 1024 / 1024).toFixed(1)} MB
            of {(snap.poster_cache_cap_bytes / 1024 / 1024).toFixed(0)} MB cap.
          </div>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={50}
              max={5000}
              step={50}
              defaultValue={Math.round(snap.poster_cache_cap_bytes / 1024 / 1024)}
              onBlur={(e) => {
                const mb = parseInt(e.target.value, 10);
                if (!Number.isFinite(mb) || mb < 10) return;
                void libraryIpc
                  .setPosterCacheCap(mb * 1024 * 1024)
                  .then(reload)
                  .catch((err) => showToast(`${err}`, "error"));
              }}
              className="bg-fvp-bg border border-fvp-border rounded px-2 py-1 text-xs w-24"
            />
            <span className="text-xs text-fvp-muted">MB</span>
          </div>
        </>
      )}

      {/* PIN flow modals moved to FamilyViewPinSection (at top of Settings). */}
    </section>
  );
}

/**
 * Snapshot backups settings + status.
 *
 * Default ON, weekly, keep last 3. The background tick on the Rust
 * side fires hourly and copies the DB via `VACUUM INTO` when the
 * cadence is due. Snapshots live in `<home>/snapshots/` when a home
 * folder is configured, else in `$LOCALAPPDATA\com.fvp.desktop\
 * snapshots\`.
 */
function SnapshotBackupSection() {
  const showToast = useAppStore((s) => s.showToast);
  const [status, setStatus] = useState<SnapshotStatus | null>(null);
  const [busyTake, setBusyTake] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await libraryIpc.snapshotStatus());
    } catch (err) {
      showToast(`Snapshot status failed: ${err}`, "error");
    }
  }, [showToast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const takeNow = async () => {
    setBusyTake(true);
    try {
      const path = await libraryIpc.snapshotTakeNow();
      showToast(`Snapshot written: ${path}`, "info", 3500);
      await refresh();
    } catch (err) {
      showToast(`${err}`, "error");
    } finally {
      setBusyTake(false);
    }
  };

  if (!status) {
    return (
      <>
        <SubHeading>Snapshot backups</SubHeading>
        <div className="text-[11px] text-fvp-muted italic">Loading…</div>
      </>
    );
  }

  return (
    <>
      <SubHeading>Snapshot backups</SubHeading>
      <p className="text-[11px] text-fvp-muted">
        Periodically copy your library DB (movies, tags, collections,
        series, watch history — <strong>no video files</strong>) to a
        rotating set of <code>.db</code> snapshots. Restores are manual
        for now: stop FVP, swap <code>library.db</code> with the
        snapshot, restart.
      </p>

      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={status.enabled}
          onChange={(e) => {
            void libraryIpc
              .snapshotSetEnabled(e.target.checked)
              .then(refresh)
              .catch((err) => showToast(`${err}`, "error"));
          }}
          className="accent-fvp-accent"
        />
        <span>Enable weekly snapshots</span>
      </label>

      <div className="flex items-center gap-3 flex-wrap">
        <label className="flex items-center gap-2 text-xs text-fvp-muted">
          Keep last
          <input
            type="number"
            min={1}
            max={20}
            value={status.keep_count}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              if (!Number.isFinite(n) || n < 1) return;
              void libraryIpc
                .snapshotSetKeepCount(n)
                .then(refresh)
                .catch((err) => showToast(`${err}`, "error"));
            }}
            className="bg-fvp-bg border border-fvp-border rounded px-2 py-1 text-xs w-16 text-fvp-text"
            disabled={!status.enabled}
          />
          snapshots
        </label>
        <label className="flex items-center gap-2 text-xs text-fvp-muted">
          Every
          <input
            type="number"
            min={1}
            max={90}
            value={status.cadence_days}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              if (!Number.isFinite(n) || n < 1) return;
              void libraryIpc
                .snapshotSetCadenceDays(n)
                .then(refresh)
                .catch((err) => showToast(`${err}`, "error"));
            }}
            className="bg-fvp-bg border border-fvp-border rounded px-2 py-1 text-xs w-16 text-fvp-text"
            disabled={!status.enabled}
          />
          day(s)
        </label>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => void takeNow()}
          disabled={busyTake}
          className="px-3 py-1.5 bg-fvp-accent text-white text-xs rounded hover:opacity-90 disabled:opacity-50"
        >
          {busyTake ? "Taking…" : "Take a snapshot now"}
        </button>
        <button
          onClick={() => {
            void libraryIpc
              .snapshotRevealDir()
              .catch((err) => showToast(`${err}`, "error"));
          }}
          className="px-3 py-1.5 bg-fvp-bg border border-fvp-border text-fvp-text text-xs rounded hover:border-fvp-muted"
        >
          Open snapshots folder
        </button>
      </div>

      <div className="text-[10px] text-fvp-muted">
        Saving to: <code className="break-all">{status.effective_dir}</code>
        {status.last_at > 0 && (
          <span>
            {" · last snapshot "}
            {new Date(status.last_at * 1000).toLocaleString()}
          </span>
        )}
      </div>

      {status.entries.length > 0 && (
        <div className="space-y-0.5">
          <div className="text-[11px] uppercase tracking-wider text-fvp-muted mt-1">
            Current snapshots ({status.entries.length})
          </div>
          {status.entries.map((e) => (
            <div
              key={e.filename}
              className="flex items-center justify-between gap-2 text-[11px] font-mono px-2 py-0.5 bg-fvp-bg border border-fvp-border rounded"
            >
              <span className="truncate">{e.filename}</span>
              <span className="text-fvp-muted shrink-0">
                {(e.size_bytes / 1024 / 1024).toFixed(1)} MB
              </span>
              <button
                onClick={() => {
                  // Restore is a NEXT-LAUNCH operation because the
                  // live SQLite handle prevents a hot swap. Confirm
                  // first since the user is about to overwrite their
                  // current library (the boot path stashes the
                  // pre-restore DB as a safety net regardless).
                  const ok = window.confirm(
                    `Restore from ${e.filename}?\n\n` +
                      `This will OVERWRITE your current library with this snapshot when FVP next launches.\n\n` +
                      `Your current library will be saved as library-pre-restore-<timestamp>.db in the same folder, so you can roll the restore back manually if needed.\n\n` +
                      `Profiles (.free) and custom thumbnails next to your videos are NOT affected.`,
                  );
                  if (!ok) return;
                  void libraryIpc
                    .snapshotScheduleRestore(e.path)
                    .then(() => {
                      showToast(
                        `Restore scheduled — restart FVP to complete.`,
                        "info",
                        6000,
                      );
                      void refresh();
                    })
                    .catch((err) => showToast(`${err}`, "error"));
                }}
                className="px-2 py-0.5 text-[10px] text-fvp-accent hover:bg-fvp-accent/10 rounded shrink-0"
                title="Schedule a restore from this snapshot — completes on next launch"
              >
                Restore…
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/** Lightweight in-app confirm dialog. window.confirm proved
 *  unreliable in WebView2 in some configurations — this one always
 *  fires and matches the rest of FVP's modal styling. */
function ConfirmModal({
  title,
  body,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  confirmKind = "primary",
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmKind?: "primary" | "danger";
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="fixed inset-0 bg-black/60 z-[65] flex items-center justify-center"
      onClick={onCancel}
    >
      <div
        className="bg-fvp-surface border border-fvp-border rounded-lg shadow-2xl p-5 max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-semibold text-fvp-text mb-2">{title}</div>
        <div className="text-xs text-fvp-muted mb-4 whitespace-pre-line">
          {body}
        </div>
        <div className="flex justify-end gap-2 text-xs">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-fvp-text hover:bg-fvp-surface2 rounded"
            autoFocus
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className={
              "px-3 py-1.5 rounded text-white hover:opacity-90 " +
              (confirmKind === "danger"
                ? "bg-fvp-err"
                : "bg-fvp-accent")
            }
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function Divider() {
  return <div className="border-t border-fvp-border my-2" />;
}
function SubHeading({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="text-[11px] uppercase tracking-wider text-fvp-muted">
      {children}
    </h4>
  );
}

/**
 * Library Networking section — Phase 1 (persistence + UI only).
 *
 * Lets the user pick a role (Standalone / Host / Client), designate a
 * shared "home folder" on a network share, and view/rotate the LAN auth
 * token. Phase 2 wires up the actual HTTP server + Client proxy; Phase
 * 3 adds the offline-read-only mode. The settings live here now so we
 * don't need a settings migration when Phase 2 lands — only behavior.
 *
 * IMPORTANT: per architectural assessment, we DO NOT put the library
 * SQLite DB itself on the share. SQLite over SMB corrupts. The home
 * folder holds the shared poster cache + auth token + Host discovery
 * info; the DB stays local to whoever's running as Host.
 */
function LibraryNetworkingSection({
  snap,
  reload,
}: {
  snap: LibrarySettingsSnapshot;
  reload: () => Promise<void>;
}) {
  const showToast = useAppStore((s) => s.showToast);
  const [tokenVisible, setTokenVisible] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [serverStatus, setServerStatus] = useState<HostServerStatus | null>(
    null,
  );

  // Re-poll host server status whenever the snap reloads (mode change,
  // token rotate, etc.) so the visible "running / not running" badge
  // matches reality. Cheap call — just a Mutex peek.
  useEffect(() => {
    let cancelled = false;
    libraryIpc
      .hostServerStatus()
      .then((s) => {
        if (!cancelled) setServerStatus(s);
      })
      .catch(() => {
        if (!cancelled) setServerStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [snap.library_mode, snap.host_auth_token, snap.home_folder_path]);

  const pickHomeFolder = async () => {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked !== "string") return;
    try {
      await libraryIpc.setHomeFolder(picked);
      showToast(`Home folder set: ${picked}`, "info", 3000);
      await reload();
    } catch (err) {
      showToast(`Set home folder failed: ${err}`, "error");
    }
  };
  // 'Pick library marker file...' flow: the user navigates a file
  // picker (rather than a directory picker) to the .fvplibrary marker
  // that another device wrote into the home folder. Useful on Device #2
  // when you can SEE the marker file by name in Explorer but don't
  // remember which subdir of your NAS it lives in. Backend resolves
  // file → parent dir and validates that the parent has FVP-managed
  // markers (library.fvplibrary / library-sync.db / host-discovery.json).
  // Accepts library-sync.db too so legacy home folders created before
  // the marker existed are still pickable this way.
  const pickHomeFromMarker = async () => {
    const picked = await openDialog({
      multiple: false,
      filters: [
        {
          name: "FVP library marker",
          extensions: ["fvplibrary", "db"],
        },
      ],
    });
    if (typeof picked !== "string") return;
    try {
      const resolved = await libraryIpc.setHomeFolderFromMarker(picked);
      showToast(`Home folder set: ${resolved}`, "info", 3500);
      await reload();
    } catch (err) {
      showToast(`${err}`, "error", 6000);
    }
  };
  const clearHomeFolder = async () => {
    if (
      !window.confirm(
        "Clear the home folder setting? Files on the share are left intact; this install just stops pointing at it.",
      )
    )
      return;
    try {
      await libraryIpc.setHomeFolder(null);
      showToast("Home folder cleared.", "info", 2000);
      await reload();
    } catch (err) {
      showToast(`Clear failed: ${err}`, "error");
    }
  };
  const setMode = async (
    mode: "standalone" | "host" | "client" | "sync",
  ) => {
    try {
      await libraryIpc.setMode(mode);
      await reload();
    } catch (err) {
      showToast(`Set mode failed: ${err}`, "error");
    }
  };
  const rotate = async () => {
    if (
      !window.confirm(
        "Rotate the auth token? Any Clients currently connected to this Host will need to re-read the new token from the home folder (happens automatically on their next launch).",
      )
    )
      return;
    setRotating(true);
    try {
      await libraryIpc.rotateAuthToken();
      showToast("Auth token rotated.", "info", 2500);
      await reload();
    } catch (err) {
      showToast(`Rotate failed: ${err}`, "error");
    } finally {
      setRotating(false);
    }
  };

  return (
    <>
      <SubHeading>Library Networking</SubHeading>
      <div className="text-[11px] text-fvp-muted space-y-1">
        <p>
          Share one library across multiple devices (Windows now; Mac / iOS /
          Android coming) via a designated <strong>home folder</strong> on a
          network share. One device acts as the <strong>Host</strong> (its DB
          is the source of truth); others connect as <strong>Clients</strong>{" "}
          over the LAN. Clients auto-discover the Host from the home folder.
        </p>
        <p className="italic">
          The library DB itself stays local to the Host (SQLite over SMB
          corrupts) — the home folder holds the shared poster cache, auth
          token, and Host discovery info.
        </p>
      </div>

      <div className="space-y-2">
        <div className="text-[11px] uppercase tracking-wider text-fvp-muted">
          This install&apos;s role
        </div>
        <div className="flex flex-col gap-1.5">
          <RoleRadio
            checked={snap.library_mode === "standalone"}
            onChange={() => void setMode("standalone")}
            title="Standalone (default)"
            description="Library lives only on this device. No networking. Best when you only ever use FVP on one machine."
          />
          <RoleRadio
            checked={snap.library_mode === "host"}
            onChange={() => void setMode("host")}
            title="Host"
            description="This device IS the library. Other FVP installs (desktop or mobile) connect to it over the LAN. DB stays local; shared cache lives in the home folder."
          />
          <RoleRadio
            checked={snap.library_mode === "client"}
            onChange={() => void setMode("client")}
            title="Client (live)"
            description="Talk to a live Library Host on the LAN. Read/edit the same library in real time. Library locks out when the Host is offline."
          />
          <RoleRadio
            checked={snap.library_mode === "sync"}
            onChange={() => void setMode("sync")}
            title="Sync (via NAS)"
            description="Single-source-of-truth on THIS device, mirrored to the home folder every 5 minutes. Other devices pull the mirror on launch. Works without an always-on Host; last-writer-wins on concurrent edits."
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="text-[11px] uppercase tracking-wider text-fvp-muted">
          Home folder
        </div>
        {snap.home_folder_path ? (
          <div className="flex items-start gap-2">
            <div className="flex-1">
              <div className="font-mono text-[11px] break-all px-2 py-1 bg-fvp-bg border border-fvp-border rounded">
                {snap.home_folder_path}
              </div>
              <div className="text-[10px] mt-0.5">
                {snap.home_folder_exists ? (
                  <span className="text-fvp-ok">✓ Reachable</span>
                ) : (
                  <span className="text-fvp-err">
                    ✗ Path not reachable right now — the share may be offline.
                  </span>
                )}
              </div>
            </div>
            <button
              onClick={() => void pickHomeFolder()}
              className="px-2 py-1 text-[11px] bg-fvp-bg border border-fvp-border rounded hover:border-fvp-muted shrink-0"
              title="Open a folder picker"
            >
              Change…
            </button>
            <button
              onClick={() => void pickHomeFromMarker()}
              className="px-2 py-1 text-[11px] bg-fvp-bg border border-fvp-border rounded hover:border-fvp-muted shrink-0"
              title="Open a FILE picker and select the library.fvplibrary marker that another device wrote into the home folder"
            >
              From marker…
            </button>
            <button
              onClick={() => void clearHomeFolder()}
              className="px-2 py-1 text-[11px] text-fvp-err hover:bg-fvp-err/10 rounded shrink-0"
            >
              Clear
            </button>
          </div>
        ) : (
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={() => void pickHomeFolder()}
                className="px-3 py-1.5 bg-fvp-accent text-white text-xs rounded hover:opacity-90"
              >
                Browse for home folder…
              </button>
              <button
                onClick={() => void pickHomeFromMarker()}
                className="px-3 py-1.5 bg-fvp-bg border border-fvp-border text-xs rounded hover:border-fvp-muted"
                title="Already set up on another device? Pick its library.fvplibrary marker file directly — FVP will use that file's parent folder as the home."
              >
                Pick library marker file…
              </button>
              <span className="text-[11px] text-fvp-muted italic">
                Standalone works without a home folder.
              </span>
            </div>
            <div className="text-[10px] text-fvp-muted">
              Setting up a 2nd device? Use{" "}
              <strong>Pick library marker file…</strong> to grab the{" "}
              <code>library.fvplibrary</code> file the first device wrote
              into the shared home folder — FVP will join the library from
              there. No path-typing required.
            </div>
          </div>
        )}
        {snap.home_folder_path && (
          <p className="text-[10px] text-fvp-muted">
            FVP creates <code>poster-cache/</code>, <code>README.txt</code>,
            <code> host-discovery.json</code>, and (Host mode) an{" "}
            <code>auth-token</code> file inside this folder. Safe to back up;
            don&apos;t edit by hand.
          </p>
        )}
      </div>

      {snap.library_mode === "host" && (
        <div className="space-y-1.5">
          <div className="text-[11px] uppercase tracking-wider text-fvp-muted">
            Host server
          </div>
          {serverStatus?.running ? (
            <div className="px-2 py-1.5 bg-fvp-ok/10 border border-fvp-ok rounded text-[11px] space-y-0.5">
              <div className="text-fvp-ok font-semibold">
                ✓ Listening on {serverStatus.bound_address}
              </div>
              <div className="text-fvp-muted">
                Clients should use{" "}
                <code className="text-fvp-text">
                  http://{serverStatus.lan_ip}:{serverStatus.port}
                </code>{" "}
                (protocol v{serverStatus.protocol_version})
              </div>
            </div>
          ) : (
            <div className="px-2 py-1.5 bg-fvp-err/10 border border-fvp-err rounded text-[11px] text-fvp-err">
              ✗ Server not running. Check the terminal log for the bind
              error (most often the port is already in use).
            </div>
          )}
        </div>
      )}

      {snap.library_mode === "host" && snap.host_auth_token && (
        <div className="space-y-1.5">
          <div className="text-[11px] uppercase tracking-wider text-fvp-muted">
            Host auth token
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 px-2 py-1 bg-fvp-bg border border-fvp-border rounded text-[10px] font-mono break-all">
              {tokenVisible
                ? snap.host_auth_token
                : "•".repeat(Math.min(48, snap.host_auth_token.length))}
            </code>
            <button
              onClick={() => setTokenVisible((v) => !v)}
              className="px-2 py-1 text-[11px] bg-fvp-bg border border-fvp-border rounded hover:border-fvp-muted shrink-0"
            >
              {tokenVisible ? "Hide" : "Show"}
            </button>
            <button
              onClick={() => {
                void navigator.clipboard.writeText(snap.host_auth_token!);
                showToast("Token copied.", "info", 1500);
              }}
              className="px-2 py-1 text-[11px] bg-fvp-bg border border-fvp-border rounded hover:border-fvp-muted shrink-0"
            >
              Copy
            </button>
            <button
              onClick={() => void rotate()}
              disabled={rotating}
              className="px-2 py-1 text-[11px] text-fvp-err hover:bg-fvp-err/10 rounded shrink-0 disabled:opacity-50"
            >
              {rotating ? "Rotating…" : "Rotate"}
            </button>
          </div>
          <p className="text-[10px] text-fvp-muted">
            Clients read this from <code>auth-token</code> in the home folder
            automatically. Rotate if you think it leaked.
          </p>
        </div>
      )}

      {snap.library_mode === "client" && (
        <ClientModeSection snap={snap} reload={reload} />
      )}

      {snap.library_mode === "sync" && <SyncModeSection />}
    </>
  );
}

/** Sync mode UI in Settings. Shows the mirror file state, last
 *  push / pull timestamps, cadence, and a "Push now" button. */
function SyncModeSection() {
  const showToast = useAppStore((s) => s.showToast);
  const [status, setStatus] = useState<import("../../ipc/library").SyncStatus | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await libraryIpc.syncStatus());
    } catch (err) {
      showToast(`${err}`, "error");
    }
  }, [showToast]);

  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(t);
  }, [refresh]);

  const pushNow = async () => {
    setBusy(true);
    try {
      const p = await libraryIpc.syncPushNow();
      showToast(`Pushed to ${p}`, "info", 3000);
      await refresh();
    } catch (err) {
      showToast(`${err}`, "error");
    } finally {
      setBusy(false);
    }
  };

  if (!status) return null;

  const ago = (ts: number) =>
    ts > 0 ? `${Math.round((Date.now() / 1000 - ts) / 60)} min ago` : "(never)";

  return (
    <div className="space-y-1.5">
      <div className="text-[11px] uppercase tracking-wider text-fvp-muted">
        Sync status
      </div>
      <div className="bg-fvp-bg border border-fvp-border rounded p-2 text-[11px] space-y-1">
        <Row label="Sync file" value={status.sync_file_path ?? "(none)"} mono />
        <Row
          label="Exists on share"
          value={
            status.sync_file_exists ? (
              <span className="text-fvp-ok">
                ✓ {(status.sync_file_size_bytes / 1024 / 1024).toFixed(1)} MB
              </span>
            ) : (
              <span className="text-fvp-warn">
                ✗ not yet (will be written on first push)
              </span>
            )
          }
        />
        <Row label="Last push (this device → share)" value={ago(status.last_push_at)} />
        <Row label="Last pull (share → this device)" value={ago(status.last_pull_at)} />
        <Row
          label="Cadence"
          value={`every ${status.cadence_minutes} minute(s)`}
        />
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => void pushNow()}
          disabled={busy}
          className="px-3 py-1.5 bg-fvp-accent text-white text-xs rounded hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Pushing…" : "Push to share now"}
        </button>
        <label className="text-[11px] text-fvp-muted flex items-center gap-1.5">
          Change cadence:
          <input
            type="number"
            min={1}
            max={1440}
            value={status.cadence_minutes}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              if (!Number.isFinite(n) || n < 1) return;
              void libraryIpc
                .syncSetCadence(n)
                .then(refresh)
                .catch((err) => showToast(`${err}`, "error"));
            }}
            className="bg-fvp-bg border border-fvp-border rounded px-2 py-1 text-xs w-16 text-fvp-text"
          />
          min
        </label>
      </div>
      <p className="text-[10px] text-fvp-muted">
        Pulls happen automatically when this device launches AND the
        share&apos;s copy is newer than the local DB. Concurrent edits
        across devices use last-writer-wins; for true real-time multi-
        device, use Host/Client mode instead.
      </p>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex gap-2 items-baseline">
      <span className="text-fvp-muted shrink-0 w-44">{label}:</span>
      <span
        className={
          "flex-1 min-w-0 break-all " + (mono ? "font-mono text-[10px]" : "")
        }
      >
        {value}
      </span>
    </div>
  );
}

/**
 * Client mode UI. Auto-discovery first: if a `host-discovery.json` +
 * `auth-token` pair is readable from the home folder, we offer the
 * user a one-click "Use this Host" button that wires the address and
 * token. Manual entry stays available as a fallback (e.g., if you
 * want to point a Client at a Host on a different LAN segment).
 */
function ClientModeSection({
  snap,
  reload,
}: {
  snap: LibrarySettingsSnapshot;
  reload: () => Promise<void>;
}) {
  const showToast = useAppStore((s) => s.showToast);
  const [discovery, setDiscovery] = useState<
    | { host_url: string; token: string; fvp_version: string | null; protocol: number | null; updated_at: number | null }
    | null
  >(null);
  const [busyDiscover, setBusyDiscover] = useState(false);

  useEffect(() => {
    if (!snap.home_folder_path || !snap.home_folder_exists) {
      setDiscovery(null);
      return;
    }
    setBusyDiscover(true);
    readHomeDiscovery()
      .then((d) => setDiscovery(d))
      .catch(() => setDiscovery(null))
      .finally(() => setBusyDiscover(false));
  }, [snap.home_folder_path, snap.home_folder_exists, snap.host_address]);

  const useDiscovered = async () => {
    if (!discovery) return;
    try {
      await libraryIpc.setHostAddress(discovery.host_url);
      // Token isn't stored locally — the auto-discovery path re-reads
      // it from the home folder at boot. But we still cache it in the
      // session so the test button works immediately.
      setHostEndpoint({ url: discovery.host_url, token: discovery.token });
      await reload();
      showToast(`Connected to ${discovery.host_url}`, "info", 2000);
    } catch (err) {
      showToast(`${err}`, "error");
    }
  };

  const effectiveUrl = snap.host_address || discovery?.host_url || null;
  const effectiveToken = snap.host_auth_token || discovery?.token || null;

  return (
    <div className="space-y-2">
      <div className="text-[11px] uppercase tracking-wider text-fvp-muted">
        Host address
      </div>

      {/* Auto-discovery card. Only shown when we successfully read
          the discovery file — otherwise the manual field is the
          primary surface. */}
      {discovery ? (
        <div className="px-2 py-1.5 bg-fvp-accent/10 border border-fvp-accent rounded space-y-1">
          <div className="text-[11px] font-semibold text-fvp-text">
            🔎 Auto-discovered from home folder:
          </div>
          <code className="block text-[11px] break-all text-fvp-text">
            {discovery.host_url}
          </code>
          <div className="text-[10px] text-fvp-muted">
            FVP {discovery.fvp_version ?? "?"} · protocol v
            {discovery.protocol ?? "?"} · auth token attached
          </div>
          <button
            onClick={() => void useDiscovered()}
            className="px-2 py-1 mt-1 text-[11px] bg-fvp-accent text-white rounded hover:opacity-90"
          >
            Use this Host
          </button>
        </div>
      ) : (
        busyDiscover && (
          <div className="text-[11px] text-fvp-muted italic">
            Checking home folder for Host discovery info…
          </div>
        )
      )}

      <HostAddressField
        current={snap.host_address}
        onSaved={async (v) => {
          try {
            await libraryIpc.setHostAddress(v);
            await reload();
            showToast(v ? "Host address saved." : "Host cleared.", "info", 1500);
          } catch (err) {
            showToast(`${err}`, "error");
          }
        }}
      />
      <p className="text-[10px] text-fvp-muted">
        Manual entry — e.g. <code>http://192.168.1.7:42171</code>. Use
        when no home folder is set, or to override auto-discovery.
      </p>

      <ClientTestConnectionRow url={effectiveUrl} token={effectiveToken} />
    </div>
  );
}

/** Hit the configured Host URL's /v1/health and report what came back. */
function ClientTestConnectionRow({
  url,
  token,
}: {
  url: string | null;
  token: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<HostConnectionTestResult | null>(null);

  const run = async () => {
    if (!url) return;
    setBusy(true);
    try {
      const r = await libraryIpc.testHostConnection(url, token);
      setLast(r);
    } catch (e) {
      setLast({
        reachable: false,
        authenticated: null,
        product: null,
        fvp_version: null,
        protocol: null,
        elapsed_ms: 0,
        error: `${e}`,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1">
      <button
        onClick={() => void run()}
        disabled={!url || busy}
        className="px-3 py-1.5 bg-fvp-accent text-white text-xs rounded hover:opacity-90 disabled:opacity-50"
      >
        {busy ? "Testing…" : "Test connection to Host"}
      </button>
      {last && (
        <div
          className={
            "text-[11px] px-2 py-1 border rounded " +
            (last.reachable
              ? "border-fvp-ok bg-fvp-ok/10"
              : "border-fvp-err bg-fvp-err/10")
          }
        >
          {last.reachable ? (
            <>
              <div className="text-fvp-ok font-semibold">
                ✓ Reachable in {last.elapsed_ms}ms
              </div>
              <div className="text-fvp-muted">
                {last.product ?? "?"} v{last.fvp_version ?? "?"} (protocol v
                {last.protocol ?? "?"})
              </div>
              {last.authenticated === false && (
                <div className="text-fvp-err mt-0.5">
                  ✗ Auth FAILED — token mismatch. Re-read the token from
                  the home folder&apos;s <code>auth-token</code> file.
                </div>
              )}
              {last.authenticated === true && (
                <div className="text-fvp-ok mt-0.5">✓ Auth OK</div>
              )}
            </>
          ) : (
            <>
              <div className="text-fvp-err font-semibold">✗ Unreachable</div>
              <div className="text-fvp-muted break-all">
                {last.error ?? "no detail"}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function RoleRadio({
  checked,
  onChange,
  title,
  description,
}: {
  checked: boolean;
  onChange: () => void;
  title: string;
  description: string;
}) {
  return (
    <label
      className={
        "flex items-start gap-2 px-2 py-1.5 rounded cursor-pointer border " +
        (checked
          ? "border-fvp-accent bg-fvp-accent/10"
          : "border-fvp-border hover:border-fvp-muted")
      }
    >
      <input
        type="radio"
        checked={checked}
        onChange={onChange}
        className="accent-fvp-accent mt-0.5"
      />
      <div className="flex-1 min-w-0">
        <div className="text-xs font-semibold text-fvp-text">{title}</div>
        <div className="text-[10px] text-fvp-muted leading-snug">
          {description}
        </div>
      </div>
    </label>
  );
}

function HostAddressField({
  current,
  onSaved,
}: {
  current: string | null;
  onSaved: (v: string | null) => Promise<void>;
}) {
  const [val, setVal] = useState(current ?? "");
  useEffect(() => {
    setVal(current ?? "");
  }, [current]);
  return (
    <div className="flex items-center gap-2">
      <input
        type="text"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        placeholder="http://192.168.1.7:42171"
        className="flex-1 px-2 py-1 text-xs bg-fvp-bg border border-fvp-border rounded font-mono"
      />
      <button
        onClick={() => void onSaved(val.trim() || null)}
        className="px-3 py-1 text-xs bg-fvp-accent text-white rounded hover:opacity-90"
      >
        Save
      </button>
      {current && (
        <button
          onClick={() => void onSaved(null)}
          className="px-2 py-1 text-[11px] text-fvp-err hover:bg-fvp-err/10 rounded"
        >
          Clear
        </button>
      )}
    </div>
  );
}
// (SetPinFlow + Input forms removed — moved to FamilyViewPinSection)
