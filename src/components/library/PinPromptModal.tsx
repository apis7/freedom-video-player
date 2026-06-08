import { useEffect, useState } from "react";
import { useAppStore } from "../../state/appStore";
import { libraryIpc } from "../../ipc/library";

interface Props {
  /** Prompt copy — explains why the PIN is being asked for. */
  reason: string;
  onSuccess: (pin: string) => void;
  onCancel: () => void;
}

/**
 * Small modal that prompts for the Family-View PIN. Verifies via
 * `library_verify_pin` and only calls `onSuccess` after the backend
 * confirms. Shake-on-wrong-PIN keeps the speed-bump feeling — per
 * directive it's intentionally NOT a security lockdown.
 */
export function PinPromptModal({ reason, onSuccess, onCancel }: Props) {
  const inc = useAppStore((s) => s.incrementOpenModalCount);
  const dec = useAppStore((s) => s.decrementOpenModalCount);
  const [pin, setPin] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(false);

  useEffect(() => {
    inc();
    return () => dec();
  }, [inc, dec]);

  const submit = async () => {
    if (busy) return;
    if (pin.length !== 4 || !/^\d{4}$/.test(pin)) {
      setErr("Enter 4 digits.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const ok = await libraryIpc.verifyPin(pin);
      if (ok) {
        onSuccess(pin);
      } else {
        setErr("Wrong PIN.");
        setShake(true);
        window.setTimeout(() => setShake(false), 500);
        setPin("");
      }
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
        className={
          "bg-fvp-surface border border-fvp-border rounded-lg shadow-2xl p-5 min-w-[340px] " +
          (shake ? "motion-safe:animate-[wiggle_0.4s_ease-in-out]" : "")
        }
        onClick={(e) => e.stopPropagation()}
        style={shake ? { animation: "wiggle 0.4s ease-in-out" } : undefined}
      >
        <div className="text-sm font-semibold text-fvp-text mb-2">
          Enter Family-View PIN
        </div>
        <div className="text-[11px] text-fvp-muted mb-3 leading-relaxed">
          {reason}
        </div>
        <input
          type="password"
          inputMode="numeric"
          pattern="\d{4}"
          maxLength={4}
          autoFocus
          value={pin}
          onChange={(e) => {
            setPin(e.target.value.replace(/\D/g, "").slice(0, 4));
            if (err) setErr(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
          className="w-full bg-fvp-bg border border-fvp-border focus:border-fvp-accent rounded px-3 py-2 text-center text-2xl tracking-[0.5em] font-mono text-fvp-text outline-none mb-2"
          placeholder="••••"
        />
        {err && (
          <div className="text-[11px] text-fvp-err mb-2 text-center">{err}</div>
        )}
        <div className="flex justify-end gap-2 text-xs mt-3">
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
            {busy ? "Checking…" : "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}
