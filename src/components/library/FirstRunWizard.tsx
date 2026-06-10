import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../../state/appStore";
import {
  libraryIpc,
  readHomeDiscovery,
  setHostEndpoint,
  setLibraryMode,
} from "../../ipc/library";

type Step =
  | "welcome"
  | "how-it-works"
  | "pick-role"
  | "host-setup"
  | "client-setup"
  | "sync-setup"
  | "done";
type Role = "standalone" | "host" | "client" | "sync";

/**
 * First-run wizard. Shown automatically the first time the user opens
 * FVP after install (gated by `library_first_run_status` returning
 * false). Replaces the previous NSIS-MessageBox approach with a React
 * component that matches the rest of FVP's styling and can't be
 * mindlessly dismissed.
 *
 * Three-step flow:
 *   1. Welcome screen — short pitch + "Let's set this up"
 *   2. Role picker — Standalone / Host / Client with one-liner descriptions
 *   3. Per-role setup:
 *      - Standalone: nothing further, mark complete
 *      - Host: pick home folder, FVP bootstraps + flips mode
 *      - Client: pick home folder, auto-discover the Host, set endpoint
 */
export function FirstRunWizard({ onDismiss }: { onDismiss: () => void }) {
  const showToast = useAppStore((s) => s.showToast);
  const [step, setStep] = useState<Step>("welcome");
  const [busy, setBusy] = useState(false);
  const [homeFolderPicked, setHomeFolderPicked] = useState<string | null>(null);
  const [hostUrlFromDiscovery, setHostUrlFromDiscovery] = useState<
    string | null
  >(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const finish = async () => {
    try {
      await libraryIpc.firstRunComplete();
    } catch {
      /* non-fatal — wizard will re-show next launch */
    }
    onDismiss();
  };

  const pickStandalone = async () => {
    setBusy(true);
    try {
      await libraryIpc.setMode("standalone");
      setLibraryMode("standalone");
      showToast("FVP set up in Standalone mode.", "info", 3000);
      await finish();
    } catch (err) {
      setErrorMsg(`${err}`);
    } finally {
      setBusy(false);
    }
  };

  const pickHomeFolderForHost = async () => {
    setErrorMsg(null);
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked !== "string") return;
    setBusy(true);
    try {
      await libraryIpc.setHomeFolder(picked);
      await libraryIpc.setMode("host");
      setLibraryMode("host");
      setHomeFolderPicked(picked);
      showToast(`Host configured: ${picked}`, "info", 3000);
      await finish();
    } catch (err) {
      setErrorMsg(`${err}`);
    } finally {
      setBusy(false);
    }
  };

  const pickHomeFolderForSync = async () => {
    setErrorMsg(null);
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked !== "string") return;
    setBusy(true);
    try {
      await libraryIpc.setHomeFolder(picked);
      await libraryIpc.setMode("sync");
      setLibraryMode("sync");
      setHomeFolderPicked(picked);
      showToast(
        `Sync set up — your DB will mirror to ${picked} every 5 minutes.`,
        "info",
        4000,
      );
      await finish();
    } catch (err) {
      setErrorMsg(`${err}`);
    } finally {
      setBusy(false);
    }
  };

  const pickHomeFolderForClient = async () => {
    setErrorMsg(null);
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked !== "string") return;
    setBusy(true);
    try {
      await libraryIpc.setHomeFolder(picked);
      // Try auto-discovery immediately so we can show a confirmation.
      const d = await readHomeDiscovery();
      if (!d) {
        setErrorMsg(
          "This folder doesn't look like a configured FVP home — the Host hasn't written its discovery file there yet. " +
            "Set up the Host first, then come back.",
        );
        setHomeFolderPicked(picked);
        setBusy(false);
        return;
      }
      setHomeFolderPicked(picked);
      setHostUrlFromDiscovery(d.host_url);
      // Verify reachability before committing.
      const test = await libraryIpc.testHostConnection(d.host_url, d.token);
      if (!test.reachable) {
        setErrorMsg(
          `Found the Host's discovery info (${d.host_url}) but couldn't reach it. ` +
            `Is the Host machine on and connected to this LAN? ` +
            `${test.error ?? ""}`,
        );
        setBusy(false);
        return;
      }
      if (test.authenticated === false) {
        setErrorMsg(
          `Host is reachable at ${d.host_url} but auth failed. ` +
            `Token may have been rotated — try re-picking the home folder once the Host is online.`,
        );
        setBusy(false);
        return;
      }
      await libraryIpc.setHostAddress(d.host_url);
      await libraryIpc.setMode("client");
      setLibraryMode("client");
      setHostEndpoint({ url: d.host_url, token: d.token });
      showToast(`Client connected to ${d.host_url}`, "info", 3500);
      await finish();
    } catch (err) {
      setErrorMsg(`${err}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 z-[70] flex items-center justify-center p-4">
      <div className="bg-fvp-surface border border-fvp-border rounded-xl shadow-2xl w-full max-w-2xl overflow-hidden">
        {/* Header */}
        <div className="px-6 pt-6 pb-4 bg-gradient-to-b from-fvp-accent/15 to-transparent border-b border-fvp-border">
          <div className="flex items-center justify-between gap-3 mb-1">
            <h1 className="text-xl font-semibold text-fvp-text">
              Welcome to Freedom Video Player
            </h1>
            <button
              onClick={() => void finish()}
              className="text-[11px] text-fvp-muted hover:text-fvp-text px-2 py-1 rounded hover:bg-fvp-surface2"
              title="Skip the wizard — you can revisit any of this from Settings"
            >
              Skip ✕
            </button>
          </div>
          <p className="text-xs text-fvp-muted">
            A few quick questions, and you&apos;ll be set up. Takes about a
            minute. You can change any of this later in Settings.
          </p>
        </div>

        {/* Body */}
        <div className="px-6 py-6 space-y-4">
          {errorMsg && (
            <div className="px-3 py-2 bg-fvp-err/10 border border-fvp-err text-fvp-err text-xs rounded">
              {errorMsg}
            </div>
          )}

          {step === "welcome" && (
            <WelcomeStep onNext={() => setStep("how-it-works")} />
          )}

          {step === "how-it-works" && (
            <HowItWorksStep
              onNext={() => setStep("pick-role")}
              onBack={() => setStep("welcome")}
            />
          )}

          {step === "pick-role" && (
            <RolePickerStep
              busy={busy}
              onPick={(role: Role) => {
                if (role === "standalone") void pickStandalone();
                else if (role === "host") setStep("host-setup");
                else if (role === "sync") setStep("sync-setup");
                else setStep("client-setup");
              }}
              onBack={() => setStep("how-it-works")}
            />
          )}

          {step === "host-setup" && (
            <HostSetupStep
              busy={busy}
              homeFolderPicked={homeFolderPicked}
              onPickFolder={pickHomeFolderForHost}
              onBack={() => setStep("pick-role")}
            />
          )}

          {step === "client-setup" && (
            <ClientSetupStep
              busy={busy}
              homeFolderPicked={homeFolderPicked}
              hostUrl={hostUrlFromDiscovery}
              onPickFolder={pickHomeFolderForClient}
              onBack={() => setStep("pick-role")}
            />
          )}

          {step === "sync-setup" && (
            <SyncSetupStep
              busy={busy}
              homeFolderPicked={homeFolderPicked}
              onPickFolder={pickHomeFolderForSync}
              onBack={() => setStep("pick-role")}
            />
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-fvp-border bg-fvp-bg/60 text-[10px] text-fvp-muted">
          You can revisit Library Networking + the home folder anytime from
          Settings → Library.
        </div>
      </div>
    </div>
  );
}

function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-fvp-text leading-relaxed">
        FVP is a video player that does three things most others don&apos;t:
      </p>
      <div className="space-y-2">
        <FeatureLine
          icon="✂️"
          title="Profiles"
          detail={
            <>
              Skip / silence / freeze-frame regions saved as a tiny{" "}
              <code>.free</code> file next to each movie. Share profiles with
              friends without sharing the video.
            </>
          }
        />
        <FeatureLine
          icon="📚"
          title="Library"
          detail="Indexes your movie folders, pulls posters + plots from TMDb, tracks watch progress, organizes by collections + series, finds duplicates."
        />
        <FeatureLine
          icon="🔗"
          title="Multi-device library (optional)"
          detail="Use the same library across your laptop, desktop, phone, tablet — your edits and watch progress sync."
        />
      </div>
      <div className="flex justify-end pt-1">
        <button
          onClick={onNext}
          className="px-4 py-2 bg-fvp-accent text-white text-sm rounded hover:opacity-90"
          autoFocus
        >
          Tell me how it works →
        </button>
      </div>
    </div>
  );
}

function FeatureLine({
  icon,
  title,
  detail,
}: {
  icon: string;
  title: string;
  detail: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 px-3 py-2 bg-fvp-bg border border-fvp-border rounded">
      <span className="text-xl select-none mt-0.5">{icon}</span>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-fvp-text">{title}</div>
        <div className="text-[11px] text-fvp-muted leading-snug">{detail}</div>
      </div>
    </div>
  );
}

function HowItWorksStep({
  onNext,
  onBack,
}: {
  onNext: () => void;
  onBack: () => void;
}) {
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-fvp-text">
        How the multi-device setup works
      </h2>
      <p className="text-xs text-fvp-text leading-relaxed">
        FVP doesn&apos;t need cloud accounts or subscriptions. Everything
        lives on your network. Here&apos;s the model:
      </p>
      <div className="bg-fvp-bg border border-fvp-border rounded p-3 text-xs space-y-2 leading-relaxed">
        <div>
          <strong className="text-fvp-text">Your videos</strong> stay where
          they are. Typically a NAS or network share. FVP just reads them.
        </div>
        <div>
          <strong className="text-fvp-text">Your library data</strong>{" "}
          (movie list, tags, watch progress, etc.) lives in a small SQLite
          database. ONE machine — the one with FVP running — owns it.
        </div>
        <div>
          <strong className="text-fvp-text">The &ldquo;home folder&rdquo;</strong>{" "}
          (optional) is a folder on your NAS that FVP uses for shared stuff:
          poster cache, weekly backups, and (depending on which mode) either
          a live discovery file (for live-multi-device) or a mirror of the
          library DB (for sync-multi-device).
        </div>
      </div>

      <div className="text-xs leading-relaxed">
        <div className="font-semibold text-fvp-text mb-1.5">
          Two ways to do multi-device:
        </div>
        <div className="space-y-2">
          <div className="px-3 py-2 bg-fvp-accent/10 border border-fvp-accent rounded">
            <div className="text-fvp-text font-semibold">
              📡 Live (Host + Client)
            </div>
            <div className="text-fvp-muted text-[11px] leading-snug mt-0.5">
              One device is the &ldquo;Host&rdquo; — runs FVP&apos;s library
              service. Others connect as &ldquo;Clients&rdquo; over the LAN
              in real time. Best when you have an always-on desktop.
              Clients can&apos;t use the library when the Host is offline.
            </div>
          </div>
          <div className="px-3 py-2 bg-fvp-ok/10 border border-fvp-ok rounded">
            <div className="text-fvp-text font-semibold">
              🔄 Sync (passive home folder)
            </div>
            <div className="text-fvp-muted text-[11px] leading-snug mt-0.5">
              Each device has its own local library DB. Every 5 minutes,
              the device pushes a copy of its DB to a file on the NAS.
              Other devices pull that copy when they launch. Works even
              when no other device is on. Best for single-user
              multi-device. Concurrent edits use last-writer-wins.
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between pt-1">
        <button
          onClick={onBack}
          className="px-3 py-1.5 text-xs text-fvp-muted hover:text-fvp-text"
        >
          ← Back
        </button>
        <button
          onClick={onNext}
          className="px-4 py-2 bg-fvp-accent text-white text-sm rounded hover:opacity-90"
          autoFocus
        >
          Pick a mode →
        </button>
      </div>
    </div>
  );
}

function RolePickerStep({
  busy,
  onPick,
  onBack,
}: {
  busy: boolean;
  onPick: (role: Role) => void;
  onBack: () => void;
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-fvp-text">
        How will you use FVP?
      </p>
      <div className="grid gap-3">
        <RoleCard
          accent="accent"
          icon="🖥️"
          title="Standalone"
          tagline="One device — fastest path"
          detail="My library lives on this device only. No network sharing."
          recommended
          onClick={() => onPick("standalone")}
          disabled={busy}
        />
        <RoleCard
          accent="ok"
          icon="🔄"
          title="Sync via NAS"
          tagline="Multi-device, no always-on Host needed"
          detail="Your library DB lives on THIS device but mirrors to a folder on your NAS every 5 minutes. Other FVP installs pull the mirror when they launch. Best when you have a NAS but no always-on FVP host. Concurrent edits use last-writer-wins."
          onClick={() => onPick("sync")}
          disabled={busy}
        />
        <RoleCard
          accent="accent"
          icon="📡"
          title="Library Host (live)"
          tagline="This device runs the FVP service; others connect live"
          detail="THIS DEVICE runs the FVP library service over the LAN. Other devices connect as Clients in real time. Best when this device is always on (e.g., a desktop). Clients lock out when this device is off."
          onClick={() => onPick("host")}
          disabled={busy}
        />
        <RoleCard
          accent="accent"
          icon="📱"
          title="Library Client (live)"
          tagline="Another device is already a live Host"
          detail="This device reads + edits the library from a live Host on your LAN. Requires the Host device to be online when you want to use the Library here. (Player and Profile Creator work offline.)"
          onClick={() => onPick("client")}
          disabled={busy}
        />
      </div>
      <div className="flex justify-start pt-1">
        <button
          onClick={onBack}
          className="px-3 py-1.5 text-xs text-fvp-muted hover:text-fvp-text"
          disabled={busy}
        >
          ← Back
        </button>
      </div>
    </div>
  );
}

function RoleCard({
  accent,
  icon,
  title,
  tagline,
  detail,
  recommended,
  onClick,
  disabled,
}: {
  accent: "accent" | "ok" | "warn";
  icon: string;
  title: string;
  tagline: string;
  detail: string;
  recommended?: boolean;
  onClick: () => void;
  disabled: boolean;
}) {
  const accentBorder =
    accent === "accent"
      ? "hover:border-fvp-accent"
      : accent === "ok"
        ? "hover:border-fvp-ok"
        : "hover:border-fvp-warn";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={
        "text-left p-3 bg-fvp-bg border border-fvp-border rounded-lg transition-colors " +
        accentBorder +
        " disabled:opacity-50 disabled:cursor-not-allowed group"
      }
    >
      <div className="flex items-start gap-3">
        <div className="text-2xl select-none">{icon}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-fvp-text">{title}</span>
            {recommended && (
              <span className="text-[10px] uppercase tracking-wider bg-fvp-accent/20 text-fvp-accent px-1.5 py-0.5 rounded">
                Recommended
              </span>
            )}
          </div>
          <div className="text-[11px] text-fvp-muted italic mt-0.5">
            {tagline}
          </div>
          <div className="text-xs text-fvp-text/85 leading-snug mt-1.5">
            {detail}
          </div>
        </div>
      </div>
    </button>
  );
}

function HostSetupStep({
  busy,
  homeFolderPicked,
  onPickFolder,
  onBack,
}: {
  busy: boolean;
  homeFolderPicked: string | null;
  onPickFolder: () => void;
  onBack: () => void;
}) {
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-fvp-text">
        📡 Set up as Library Host
      </h2>
      <p className="text-xs text-fvp-muted leading-relaxed">
        Pick a folder on your <strong>network share</strong> to be the home
        for FVP. It&apos;ll hold the shared poster cache, weekly DB backups,
        and the connection info other devices need to find this Host.
      </p>
      <div className="bg-fvp-bg border border-fvp-border rounded p-3 text-[11px] space-y-1">
        <div className="text-fvp-muted">
          Good choices: a folder on your NAS, a Windows share, an SMB mount —
          anything reachable from all your devices.
        </div>
        <div className="text-fvp-muted">
          Example:{" "}
          <code className="text-fvp-text">{"\\\\NAS\\Shared\\FVP_Library"}</code>
        </div>
      </div>
      {homeFolderPicked && (
        <div className="bg-fvp-ok/10 border border-fvp-ok rounded p-2 text-[11px] text-fvp-ok font-mono break-all">
          ✓ {homeFolderPicked}
        </div>
      )}
      <div className="flex items-center justify-between pt-2">
        <button
          onClick={onBack}
          disabled={busy}
          className="px-3 py-1.5 text-xs text-fvp-muted hover:text-fvp-text"
        >
          ← Back
        </button>
        <button
          onClick={onPickFolder}
          disabled={busy}
          className="px-4 py-2 bg-fvp-accent text-white text-sm rounded hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Setting up…" : "Browse for home folder…"}
        </button>
      </div>
    </div>
  );
}

function SyncSetupStep({
  busy,
  homeFolderPicked,
  onPickFolder,
  onBack,
}: {
  busy: boolean;
  homeFolderPicked: string | null;
  onPickFolder: () => void;
  onBack: () => void;
}) {
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-fvp-text">
        🔄 Set up Sync via NAS
      </h2>
      <p className="text-xs text-fvp-muted leading-relaxed">
        Pick a folder on your <strong>NAS</strong> (or any network share)
        to hold the sync file. FVP will mirror this device&apos;s library
        DB there every 5 minutes. Any other device you install FVP on
        later can point at the SAME folder, also pick Sync mode, and the
        two will keep in step automatically.
      </p>
      <div className="bg-fvp-bg border border-fvp-border rounded p-3 text-[11px] space-y-1.5">
        <div className="text-fvp-muted">
          <strong className="text-fvp-text">What goes in this folder:</strong>{" "}
          <code>library-sync.db</code> (the mirror — small, &lt;50 MB
          typically), plus the shared poster cache + weekly snapshot backups.
        </div>
        <div className="text-fvp-muted">
          <strong className="text-fvp-text">Concurrent edits:</strong> if
          you edit on two devices simultaneously, last-writer-wins (other
          device&apos;s changes from that 5-minute window are lost).
          Single-user-one-device-at-a-time is the sweet spot.
        </div>
        <div className="text-fvp-muted">
          Example path:{" "}
          <code className="text-fvp-text">{"\\\\NAS\\Shared\\FVP_Library"}</code>
        </div>
      </div>
      {homeFolderPicked && (
        <div className="bg-fvp-ok/10 border border-fvp-ok rounded p-2 text-[11px] text-fvp-ok font-mono break-all">
          ✓ {homeFolderPicked}
        </div>
      )}
      <div className="flex items-center justify-between pt-2">
        <button
          onClick={onBack}
          disabled={busy}
          className="px-3 py-1.5 text-xs text-fvp-muted hover:text-fvp-text"
        >
          ← Back
        </button>
        <button
          onClick={onPickFolder}
          disabled={busy}
          className="px-4 py-2 bg-fvp-ok text-white text-sm rounded hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Setting up…" : "Browse for sync folder…"}
        </button>
      </div>
    </div>
  );
}

function ClientSetupStep({
  busy,
  homeFolderPicked,
  hostUrl,
  onPickFolder,
  onBack,
}: {
  busy: boolean;
  homeFolderPicked: string | null;
  hostUrl: string | null;
  onPickFolder: () => void;
  onBack: () => void;
}) {
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-fvp-text">
        📱 Connect to a Library Host
      </h2>
      <p className="text-xs text-fvp-muted leading-relaxed">
        Pick the <strong>same home folder</strong> the Host is using. FVP
        reads the Host&apos;s connection info + auth token from there
        automatically — no URLs or passwords to type.
      </p>
      <div className="bg-fvp-bg border border-fvp-border rounded p-3 text-[11px] space-y-1">
        <div className="text-fvp-muted">
          Don&apos;t know what the home folder is? Ask whoever set up the
          Host. It&apos;ll be a network share like{" "}
          <code className="text-fvp-text">{"\\\\NAS\\Shared\\FVP_Library"}</code>
          .
        </div>
      </div>
      {homeFolderPicked && (
        <div className="bg-fvp-ok/10 border border-fvp-ok rounded p-2 text-[11px] text-fvp-ok font-mono break-all">
          ✓ {homeFolderPicked}
        </div>
      )}
      {hostUrl && (
        <div className="bg-fvp-accent/10 border border-fvp-accent rounded p-2 text-[11px] text-fvp-text">
          🔎 Found Host at <code>{hostUrl}</code>
        </div>
      )}
      <div className="flex items-center justify-between pt-2">
        <button
          onClick={onBack}
          disabled={busy}
          className="px-3 py-1.5 text-xs text-fvp-muted hover:text-fvp-text"
        >
          ← Back
        </button>
        <button
          onClick={onPickFolder}
          disabled={busy}
          className="px-4 py-2 bg-fvp-accent text-white text-sm rounded hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Connecting…" : "Browse for home folder…"}
        </button>
      </div>
    </div>
  );
}
