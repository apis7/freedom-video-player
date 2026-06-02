import { useEffect } from "react";
import { useAppStore } from "../state/appStore";
import { playback } from "../ipc";

/**
 * Shown when a file open has been "loading" for longer than the timeout
 * threshold (currently 10 s). Lets the user wait it out or cancel.
 *
 * Cancel: calls libmpv `stop` and clears `currentFile` + `loading`.
 * Wait:   dismisses the modal — no further auto-prompts this session for
 *         this open. (User can keep waiting indefinitely; they always have
 *         the Open File option to start fresh.)
 */
export function LoadTimeoutModal() {
  const visible = useAppStore((s) => s.loadingTimedOut);
  const inc = useAppStore((s) => s.incrementOpenModalCount);
  const dec = useAppStore((s) => s.decrementOpenModalCount);

  useEffect(() => {
    if (!visible) return;
    inc();
    return () => dec();
  }, [visible, inc, dec]);

  if (!visible) return null;

  const dismiss = () => useAppStore.setState({ loadingTimedOut: false });

  const cancel = async () => {
    try {
      await playback.stop();
    } catch {}
    useAppStore.setState({
      loading: false,
      loadingTimedOut: false,
      currentFile: null,
      detectedProfiles: [],
    });
  };

  return (
    <div className="fixed inset-0 bg-black/70 z-[55] flex items-center justify-center">
      <div className="bg-fvp-surface border border-fvp-border rounded-lg shadow-2xl p-5 min-w-[420px] max-w-[560px]">
        <div className="text-sm font-semibold text-fvp-text mb-2">Still loading…</div>
        <div className="text-[12px] text-fvp-muted mb-4">
          This file is taking longer than expected to open. Large videos on
          slow disks (or buffering from a network share) can need a while.
          Keep waiting, or cancel and try a different file?
        </div>
        <div className="flex justify-end gap-2 text-xs">
          <button
            onClick={() => void cancel()}
            className="px-3 py-1.5 text-fvp-err hover:bg-fvp-err/10 rounded cursor-pointer"
          >
            Cancel load
          </button>
          <button
            onClick={dismiss}
            className="px-3 py-1.5 bg-fvp-accent text-white rounded cursor-pointer"
          >
            Keep waiting
          </button>
        </div>
      </div>
    </div>
  );
}
