import { useEffect } from "react";
import clsx from "clsx";
import { useAppStore } from "../state/appStore";

/**
 * One-at-a-time transient toast in the top-right corner. Auto-dismisses
 * after `toast.durationMs`. New toasts replace any existing one.
 */
export function ToastOverlay() {
  const toast = useAppStore((s) => s.toast);
  const dismiss = useAppStore((s) => s.dismissToast);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(dismiss, toast.durationMs);
    return () => clearTimeout(timer);
  }, [toast, dismiss]);

  if (!toast) return null;

  const colors =
    toast.kind === "error"
      ? "bg-fvp-err/20 border-fvp-err/50 text-fvp-err"
      : toast.kind === "warn"
        ? "bg-fvp-warn/20 border-fvp-warn/50 text-fvp-warn"
        : "bg-fvp-surface border-fvp-border text-fvp-text";

  return (
    <div
      className={clsx(
        "fixed top-12 right-4 z-[60] max-w-md px-4 py-2.5 rounded shadow-2xl border text-sm select-none",
        colors,
      )}
      onClick={dismiss}
      title="Click to dismiss"
    >
      {toast.message}
    </div>
  );
}
