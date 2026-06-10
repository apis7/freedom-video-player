import { useEffect, useState } from "react";
import { useAppStore } from "../state/appStore";
import { diagnosticsIpc } from "../ipc/diagnostics";

const MAX_BODY_CHARS = 6000;

/**
 * Help → Feature Request dialog. V1 stub — writes a JSON file into
 * %APPDATA%\diagnostics; a later build will email it to the dev.
 */
export function FeatureRequestModal() {
  const visible = useAppStore((s) => s.featureRequestVisible);
  const showToast = useAppStore((s) => s.showToast);
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  if (!visible) return null;

  const overCap = body.length > MAX_BODY_CHARS;
  const minimallyValid = body.trim().length >= 5;

  const close = () => {
    useAppStore.setState({ featureRequestVisible: false });
    setBody("");
  };

  const submit = async () => {
    if (submitting || overCap || !minimallyValid) return;
    setSubmitting(true);
    try {
      const saved = await diagnosticsIpc.submitReport({
        kind: "feature_request",
        body,
        fields: {},
        tail_lines: [],
      });
      showToast(`Feature request saved → ${shortPath(saved)}`, "info", 5000);
      close();
    } catch (err) {
      showToast(`Could not save request: ${err}`, "error", 5000);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 z-[70] flex items-center justify-center p-6"
      onClick={close}
    >
      <div
        className="bg-fvp-surface border border-fvp-border rounded-lg shadow-2xl p-5 w-full max-w-xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold text-fvp-text">Feature request</h3>
            <p className="text-[11px] text-fvp-muted mt-0.5">
              Describe the feature or improvement you'd like. Be as specific as
              you like.
            </p>
          </div>
          <button
            onClick={close}
            className="text-fvp-muted hover:text-fvp-text text-sm"
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>

        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          autoFocus
          rows={10}
          placeholder={
            "What's the use case? What would it let you do that you can't today?\n\nExample: 'In Profile Creator, I'd like to copy a snip's action to a different snip by Ctrl+Shift+clicking the source then the target.'"
          }
          className="w-full bg-fvp-bg border border-fvp-border focus:border-fvp-accent rounded px-3 py-2 text-xs text-fvp-text outline-none font-mono"
        />
        <div
          className={
            "text-[10px] text-right " + (overCap ? "text-fvp-err" : "text-fvp-muted")
          }
        >
          {body.length} / {MAX_BODY_CHARS} chars
        </div>

        <div className="flex justify-end gap-2 text-xs mt-4 pt-3 border-t border-fvp-border">
          <button
            onClick={close}
            disabled={submitting}
            className="px-3 py-1.5 text-fvp-text hover:bg-fvp-surface2 rounded disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={submitting || overCap || !minimallyValid}
            className="px-3 py-1.5 bg-fvp-accent text-white rounded hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? "Sending…" : "SEND REQUEST"}
          </button>
        </div>
      </div>
    </div>
  );
}

function shortPath(p: string): string {
  const parts = p.split(/[\\/]/).filter((x) => x.length > 0);
  if (parts.length <= 2) return p;
  return "…\\" + parts.slice(-2).join("\\");
}
