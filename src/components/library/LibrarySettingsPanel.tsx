import { useCallback, useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../../state/appStore";
import {
  libraryIpc,
  type LibrarySettingsSnapshot,
  type WatchedFolder,
} from "../../ipc/library";
import { PinPromptModal } from "./PinPromptModal";

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
  const [pinFlow, setPinFlow] = useState<
    | null
    | { kind: "set"; current: string | null }
    | { kind: "change"; step: "verify"; }
    | { kind: "change"; step: "new"; current: string }
    | { kind: "clear" }
  >(null);
  const [newPinInput, setNewPinInput] = useState("");
  const [confirmPinInput, setConfirmPinInput] = useState("");

  const reload = useCallback(async () => {
    try {
      setSnap(await libraryIpc.getSettings());
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

      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={libraryEnabled}
          onChange={(e) => setLibraryEnabled(e.target.checked)}
          className="accent-fvp-accent"
        />
        <span>Enable Library Mode</span>
      </label>
      <p className="text-[11px] text-fvp-muted -mt-2 ml-6">
        When off, the Library tab is hidden and FVP boots straight into Player Mode.
      </p>

      {snap && libraryEnabled && (
        <>
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

          <SubHeading>Family-View PIN</SubHeading>
          <p className="text-[11px] text-fvp-muted">
            A 4-digit speed-bump for kids — not a hardened lockdown. Required
            to disable Family View once it&apos;s on. Reinstalling FVP wipes
            the PIN.
          </p>
          {!snap.has_pin ? (
            <button
              onClick={() => setPinFlow({ kind: "set", current: null })}
              className="px-3 py-1.5 bg-fvp-accent text-white text-xs rounded hover:opacity-90"
            >
              Set a PIN…
            </button>
          ) : (
            <div className="flex gap-2 flex-wrap">
              <span className="px-2 py-1 bg-fvp-ok/15 border border-fvp-ok text-fvp-ok text-xs rounded">
                PIN set
              </span>
              <button
                onClick={() => setPinFlow({ kind: "change", step: "verify" })}
                className="px-3 py-1 bg-fvp-bg border border-fvp-border text-fvp-text text-xs rounded hover:border-fvp-muted"
              >
                Change PIN…
              </button>
              <button
                onClick={() => setPinFlow({ kind: "clear" })}
                className="px-3 py-1 bg-fvp-bg border border-fvp-border text-fvp-err text-xs rounded hover:border-fvp-err"
              >
                Remove PIN…
              </button>
            </div>
          )}

          {snap.has_pin && (
            <>
              <Divider />
              <SubHeading>Family View</SubHeading>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={snap.family_view_allowed}
                  onChange={(e) => {
                    void libraryIpc
                      .setFamilyViewAllowed(e.target.checked)
                      .then(reload)
                      .catch((err) => showToast(`${err}`, "error"));
                  }}
                  className="accent-fvp-accent"
                />
                <span>Enable Family View capability</span>
              </label>
              <p className="text-[11px] text-fvp-muted -mt-2 ml-6">
                When enabled, the Family View toggle appears in the Library header.
                Movies marked non-family-friendly are hidden from views and skipped
                by Roulette / Suggestion / filters.
              </p>
            </>
          )}

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

      {pinFlow?.kind === "set" && (
        <SetPinFlow
          currentPin={null}
          newPinInput={newPinInput}
          setNewPinInput={setNewPinInput}
          confirmPinInput={confirmPinInput}
          setConfirmPinInput={setConfirmPinInput}
          onCancel={() => {
            setPinFlow(null);
            setNewPinInput("");
            setConfirmPinInput("");
          }}
          onSaved={() => {
            setPinFlow(null);
            setNewPinInput("");
            setConfirmPinInput("");
            void reload();
          }}
        />
      )}
      {pinFlow?.kind === "change" && pinFlow.step === "verify" && (
        <PinPromptModal
          reason="Enter your current PIN to change it."
          onCancel={() => setPinFlow(null)}
          onSuccess={(current) => setPinFlow({ kind: "change", step: "new", current })}
        />
      )}
      {pinFlow?.kind === "change" && pinFlow.step === "new" && (
        <SetPinFlow
          currentPin={pinFlow.current}
          newPinInput={newPinInput}
          setNewPinInput={setNewPinInput}
          confirmPinInput={confirmPinInput}
          setConfirmPinInput={setConfirmPinInput}
          onCancel={() => {
            setPinFlow(null);
            setNewPinInput("");
            setConfirmPinInput("");
          }}
          onSaved={() => {
            setPinFlow(null);
            setNewPinInput("");
            setConfirmPinInput("");
            void reload();
          }}
        />
      )}
      {pinFlow?.kind === "clear" && (
        <PinPromptModal
          reason="Enter your PIN to remove it. Family View will turn off too."
          onCancel={() => setPinFlow(null)}
          onSuccess={(current) => {
            void libraryIpc
              .setPin(null, current)
              .then(() => {
                showToast("PIN removed.", "info", 2500);
                setPinFlow(null);
                void reload();
              })
              .catch((err) => showToast(`${err}`, "error"));
          }}
        />
      )}
    </section>
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

/** Form for choosing + confirming a new 4-digit PIN. Modal layered. */
function SetPinFlow({
  currentPin,
  newPinInput,
  setNewPinInput,
  confirmPinInput,
  setConfirmPinInput,
  onCancel,
  onSaved,
}: {
  currentPin: string | null;
  newPinInput: string;
  setNewPinInput: (s: string) => void;
  confirmPinInput: string;
  setConfirmPinInput: (s: string) => void;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const showToast = useAppStore((s) => s.showToast);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    if (newPinInput.length !== 4 || !/^\d{4}$/.test(newPinInput)) {
      setErr("PIN must be exactly 4 digits.");
      return;
    }
    if (newPinInput !== confirmPinInput) {
      setErr("PINs don't match.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await libraryIpc.setPin(newPinInput, currentPin);
      showToast(currentPin ? "PIN changed." : "PIN set.", "info", 2500);
      onSaved();
    } catch (e) {
      setErr(`${e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 z-[65] flex items-center justify-center"
      onClick={onCancel}
    >
      <div
        className="bg-fvp-surface border border-fvp-border rounded-lg shadow-2xl p-5 min-w-[340px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-semibold text-fvp-text mb-3">
          {currentPin ? "Choose a new PIN" : "Set a Family-View PIN"}
        </div>
        <Input
          label="New PIN"
          value={newPinInput}
          onChange={setNewPinInput}
          autoFocus
        />
        <Input
          label="Confirm"
          value={confirmPinInput}
          onChange={setConfirmPinInput}
        />
        {err && <div className="text-[11px] text-fvp-err mt-2">{err}</div>}
        <div className="flex justify-end gap-2 text-xs mt-4">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-fvp-text hover:bg-fvp-surface2 rounded"
          >
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy}
            className="px-3 py-1.5 bg-fvp-accent text-white rounded hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Input({
  label,
  value,
  onChange,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (s: string) => void;
  autoFocus?: boolean;
}) {
  return (
    <label className="block mb-2">
      <div className="text-[10px] uppercase tracking-wider text-fvp-muted mb-1">
        {label}
      </div>
      <input
        type="password"
        inputMode="numeric"
        maxLength={4}
        autoFocus={autoFocus}
        value={value}
        onChange={(e) =>
          onChange(e.target.value.replace(/\D/g, "").slice(0, 4))
        }
        className="w-full bg-fvp-bg border border-fvp-border focus:border-fvp-accent rounded px-3 py-2 text-center text-xl tracking-[0.5em] font-mono outline-none"
        placeholder="••••"
      />
    </label>
  );
}
