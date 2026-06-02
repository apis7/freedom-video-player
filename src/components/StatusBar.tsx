import { useAppStore } from "../state/appStore";
import { formatTime } from "../utils/format";

export function StatusBar() {
  const playing = useAppStore((s) => s.playing);
  const streamInfo = useAppStore((s) => s.streamInfo);
  const activeProfilesCount = useAppStore(
    (s) => s.detectedProfiles.filter((p) => p.active).length,
  );
  const cutTotalText = useAppStore((s) => s.cutTotalText);
  const abToggleOn = useAppStore((s) => s.abToggleOn);
  const volume = useAppStore((s) => s.volume);
  const muted = useAppStore((s) => s.muted);
  const position = useAppStore((s) => s.position);
  const duration = useAppStore((s) => s.duration);
  const currentFile = useAppStore((s) => s.currentFile);

  const status = currentFile ? (playing ? "Playing" : "Paused") : "Ready";
  const dotColor = playing ? "bg-fvp-ok" : "bg-fvp-muted";

  return (
    <footer className="flex items-center gap-2 h-6 px-2 bg-fvp-surface border-t border-fvp-border text-[11px] text-fvp-muted select-none">
      <span className="flex items-center gap-1.5">
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${dotColor}`} />
        {status}
      </span>
      {currentFile && (
        <>
          <span>·</span>
          <span className="font-mono tabular-nums">
            {formatTime(position)} / {formatTime(duration)}
          </span>
        </>
      )}
      <span>·</span>
      <span>{streamInfo ?? "no stream"}</span>
      <span>·</span>
      <span>
        {activeProfilesCount} profiles active · cuts{" "}
        <span className="text-fvp-accent">{cutTotalText}</span>
      </span>
      <span className="flex-1" />
      <span>A/B: {abToggleOn ? "ON" : "OFF"}</span>
      <span>·</span>
      <span>Vol {muted ? "mute" : `${Math.round(volume)}%`}</span>
      <span>·</span>
      <button
        className="px-1.5 py-px bg-fvp-surface2 border border-fvp-border rounded text-fvp-text hover:bg-fvp-accent hover:text-white hover:border-fvp-accent cursor-pointer font-mono"
        title="Open hotkey cheatsheet (?)"
        onClick={() => useAppStore.setState({ cheatsheetVisible: true })}
      >
        ? shortcuts
      </button>
    </footer>
  );
}
