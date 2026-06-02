import { useEffect, useState } from "react";
import { useAppStore } from "../state/appStore";

interface TypedConfirmModalProps {
  title: string;
  message: string;
  /** Text the user must type EXACTLY (case-insensitive) to enable the
   *  Confirm button. e.g. "delete". */
  requiredText: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Hard-stop modal for destructive irreversible actions. The Confirm button
 * is disabled until the user types `requiredText`. Backdrop click does NOT
 * dismiss (intentional friction).
 */
export function TypedConfirmModal({
  title,
  message,
  requiredText,
  confirmLabel = "Confirm",
  onConfirm,
  onCancel,
}: TypedConfirmModalProps) {
  const [typed, setTyped] = useState("");
  const inc = useAppStore((s) => s.incrementOpenModalCount);
  const dec = useAppStore((s) => s.decrementOpenModalCount);

  useEffect(() => {
    inc();
    return () => dec();
  }, [inc, dec]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const canConfirm = typed.trim().toLowerCase() === requiredText.toLowerCase();

  return (
    <div className="fixed inset-0 bg-black/70 z-[55] flex items-center justify-center">
      <div className="bg-fvp-surface border border-fvp-err/60 rounded-lg shadow-2xl p-5 min-w-[420px] max-w-[560px]">
        <div className="text-sm font-semibold text-fvp-err mb-2">{title}</div>
        <div className="text-[12px] text-fvp-text mb-4 whitespace-pre-wrap">{message}</div>
        <label className="block text-[10px] uppercase tracking-wider text-fvp-muted mb-1">
          Type "{requiredText}" to confirm
        </label>
        <input
          autoFocus
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canConfirm) {
              e.preventDefault();
              onConfirm();
            }
          }}
          className="w-full bg-fvp-bg border border-fvp-border focus:border-fvp-err rounded px-2 py-1.5 text-sm text-fvp-text outline-none font-mono mb-4"
          placeholder={requiredText}
        />
        <div className="flex justify-end gap-2 text-xs">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-fvp-text hover:bg-fvp-surface2 rounded cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!canConfirm}
            className="px-3 py-1.5 bg-fvp-err text-white rounded disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
