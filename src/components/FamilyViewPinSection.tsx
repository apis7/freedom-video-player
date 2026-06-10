import { useCallback, useEffect, useState } from "react";
import { libraryIpc } from "../ipc/library";
import { useAppStore } from "../state/appStore";
import { PinPromptModal } from "./library/PinPromptModal";

type PinFlow =
  | null
  | { kind: "set"; current: string | null }
  | { kind: "change"; step: "verify" }
  | { kind: "change"; step: "new"; current: string }
  | { kind: "clear" };

/**
 * Family-View PIN management. A 4-digit speed-bump for kids — NOT a
 * hardened lockdown (the PIN is required to disable Family View once
 * it's on, but the underlying DB and files are not encrypted).
 *
 * Promoted to the very top of Settings per user request — it's the
 * single most important guardrail FVP has against accidental
 * exposure, so it deserves prime real estate.
 */
export function FamilyViewPinSection() {
  const showToast = useAppStore((s) => s.showToast);
  const [hasPin, setHasPin] = useState(false);
  const [familyAllowed, setFamilyAllowed] = useState(false);
  const [familyEnabled, setFamilyEnabled] = useState(false);
  const [pinFlow, setPinFlow] = useState<PinFlow>(null);
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");

  const reload = useCallback(async () => {
    try {
      const snap = await libraryIpc.getSettings();
      setHasPin(snap.has_pin);
      setFamilyAllowed(snap.family_view_allowed);
      setFamilyEnabled(snap.family_view_enabled);
    } catch (err) {
      showToast(`Load PIN status failed: ${err}`, "error");
    }
  }, [showToast]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <section
      id="settings-section-family-view-pin"
      className="mb-8 scroll-mt-6"
    >
      <h3 className="text-xs font-semibold text-fvp-muted uppercase tracking-wider mb-3">
        Family-View PIN
      </h3>
      <div className="space-y-3 max-w-2xl">
        <div className="bg-fvp-surface border border-fvp-border rounded-lg p-4 space-y-3">
          <p className="text-[11px] text-fvp-muted leading-relaxed">
            A 4-digit speed-bump for kids — not a hardened lockdown.
            Required to <em>disable</em> Family View once it&apos;s on,
            so curious kids can&apos;t flip it off. Reinstalling FVP wipes
            the PIN.
          </p>

          {!hasPin ? (
            <button
              onClick={() => setPinFlow({ kind: "set", current: null })}
              className="px-3 py-2 bg-fvp-accent text-white text-xs rounded hover:opacity-90"
            >
              Set a PIN…
            </button>
          ) : (
            <div className="flex gap-2 flex-wrap items-center">
              <span className="px-2.5 py-1 bg-fvp-ok/15 border border-fvp-ok text-fvp-ok text-xs rounded font-semibold">
                ✓ PIN set
              </span>
              <button
                onClick={() => setPinFlow({ kind: "change", step: "verify" })}
                className="px-3 py-1.5 bg-fvp-bg border border-fvp-border text-fvp-text text-xs rounded hover:border-fvp-muted"
              >
                Change PIN…
              </button>
              <button
                onClick={() => setPinFlow({ kind: "clear" })}
                className="px-3 py-1.5 bg-fvp-bg border border-fvp-border text-fvp-err text-xs rounded hover:border-fvp-err"
              >
                Remove PIN…
              </button>
            </div>
          )}

          {hasPin && (
            <div className="pt-2 border-t border-fvp-border space-y-2">
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={familyAllowed}
                  onChange={(e) => {
                    void libraryIpc
                      .setFamilyViewAllowed(e.target.checked)
                      .then(reload)
                      .catch((err) => showToast(`${err}`, "error"));
                  }}
                  className="accent-fvp-accent mt-0.5"
                />
                <div>
                  <div className="text-xs text-fvp-text">
                    Enable Family View capability
                  </div>
                  <div className="text-[11px] text-fvp-muted">
                    Adds the Family View toggle to the Library header.
                    Items marked non-family-friendly are hidden from views,
                    Roulette, and Suggestions.
                  </div>
                </div>
              </label>
              {familyAllowed && (
                <div className="text-[11px] text-fvp-muted pl-6">
                  Currently:{" "}
                  {familyEnabled ? (
                    <span className="text-fvp-ok">Family View is ON</span>
                  ) : (
                    <span>Family View is off — toggle from Library header</span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {pinFlow?.kind === "set" && (
        <SetPinModal
          currentPin={null}
          newPinInput={newPin}
          setNewPinInput={setNewPin}
          confirmPinInput={confirmPin}
          setConfirmPinInput={setConfirmPin}
          onCancel={() => {
            setPinFlow(null);
            setNewPin("");
            setConfirmPin("");
          }}
          onSaved={() => {
            setPinFlow(null);
            setNewPin("");
            setConfirmPin("");
            void reload();
          }}
        />
      )}
      {pinFlow?.kind === "change" && pinFlow.step === "verify" && (
        <PinPromptModal
          reason="Enter your current PIN to change it."
          onCancel={() => setPinFlow(null)}
          onSuccess={(current) =>
            setPinFlow({ kind: "change", step: "new", current })
          }
        />
      )}
      {pinFlow?.kind === "change" && pinFlow.step === "new" && (
        <SetPinModal
          currentPin={pinFlow.current}
          newPinInput={newPin}
          setNewPinInput={setNewPin}
          confirmPinInput={confirmPin}
          setConfirmPinInput={setConfirmPin}
          onCancel={() => {
            setPinFlow(null);
            setNewPin("");
            setConfirmPin("");
          }}
          onSaved={() => {
            setPinFlow(null);
            setNewPin("");
            setConfirmPin("");
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

function SetPinModal({
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
        <PinInput label="New PIN" value={newPinInput} onChange={setNewPinInput} autoFocus />
        <PinInput label="Confirm" value={confirmPinInput} onChange={setConfirmPinInput} />
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

function PinInput({
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
    <label className="flex items-center gap-3 mb-2">
      <span className="text-[11px] text-fvp-muted w-20">{label}</span>
      <input
        type="password"
        inputMode="numeric"
        pattern="[0-9]{4}"
        maxLength={4}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 4))}
        autoFocus={autoFocus}
        className="flex-1 bg-fvp-bg border border-fvp-border focus:border-fvp-accent rounded px-3 py-1.5 text-sm text-fvp-text outline-none font-mono tracking-widest"
      />
    </label>
  );
}
