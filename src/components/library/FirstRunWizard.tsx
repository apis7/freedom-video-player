import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../../state/appStore";
import {
  libraryIpc,
  readHomeDiscovery,
  setHostEndpoint,
  setLibraryMode,
} from "../../ipc/library";

type Step = "welcome" | "pick-role" | "host-setup" | "client-setup" | "done";
type Role = "standalone" | "host" | "client";

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

          {step === "welcome" && <WelcomeStep onNext={() => setStep("pick-role")} />}

          {step === "pick-role" && (
            <RolePickerStep
              busy={busy}
              onPick={(role: Role) => {
                if (role === "standalone") void pickStandalone();
                else if (role === "host") setStep("host-setup");
                else setStep("client-setup");
              }}
              onBack={() => setStep("welcome")}
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
        FVP plays videos and lets you create <strong>profiles</strong> that
        skip / silence / freeze parts you don&apos;t want to watch — saved as
        a tiny <code>.free</code> file next to each movie.
      </p>
      <p className="text-sm text-fvp-text leading-relaxed">
        It also has a <strong>Library</strong> mode that indexes your movie
        folders, pulls TMDb metadata, tracks watch progress, organizes by
        collections and series, and lets you share one library across
        multiple devices.
      </p>
      <div className="bg-fvp-bg border border-fvp-border rounded p-3 text-xs space-y-1.5">
        <div className="font-semibold text-fvp-text">Three quick choices:</div>
        <div className="text-fvp-muted">
          <span className="text-fvp-text">One device only?</span> →{" "}
          <em>Standalone.</em> Done in one click.
        </div>
        <div className="text-fvp-muted">
          <span className="text-fvp-text">Want your library on multiple devices?</span>{" "}
          → Pick <em>Host</em> on your main device (the one that&apos;s on most
          often), <em>Client</em> on the others. All point at one shared
          <em> home folder</em> on your network (usually a NAS).
        </div>
      </div>
      <div className="text-[10px] text-fvp-muted bg-fvp-surface2/40 rounded p-2 leading-relaxed">
        <strong className="text-fvp-text">Quick clarification:</strong> the
        &quot;Host&quot; is the <em>device running FVP</em>, not where your
        media is stored. Your NAS can hold the media + the home folder
        without needing FVP installed on it — but some device with FVP
        running has to be the Host.
      </div>
      <div className="flex justify-end pt-1">
        <button
          onClick={onNext}
          className="px-4 py-2 bg-fvp-accent text-white text-sm rounded hover:opacity-90"
          autoFocus
        >
          Let&apos;s set this up →
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
          accent="accent"
          icon="📡"
          title="Library Host"
          tagline="This is my main device — others will connect to it"
          detail="THIS DEVICE runs the FVP library service. The library DB lives here, and other FVP installs on your LAN (eventually iOS/Android too) connect to it. Your media can live anywhere reachable — usually a NAS or network share."
          onClick={() => onPick("host")}
          disabled={busy}
        />
        <RoleCard
          accent="ok"
          icon="📱"
          title="Library Client"
          tagline="Another device already runs FVP as the Host"
          detail="This device reads + edits the library from another FVP install on your LAN. Requires that Host device to be online when you want to use the Library here. (Player and Profile Creator work offline.)"
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
