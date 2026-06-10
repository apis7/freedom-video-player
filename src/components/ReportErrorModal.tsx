import { useEffect, useState } from "react";
import { useAppStore } from "../state/appStore";
import { diagnosticsIpc } from "../ipc/diagnostics";

const AREAS = ["Profile", "Library", "Player", "Settings", "Other"] as const;
type Area = (typeof AREAS)[number];

const MAX_BODY_CHARS = 6000; // ~1000-word soft cap

/**
 * Help → Report Error dialog. Stub for now: backend writes a JSON
 * report into %APPDATA%\diagnostics; a future build wires that up to a
 * hidden email. The user sees the path it was saved to so they can
 * forward manually if they want to.
 *
 * Also reused by the global ErrorBoundary as the "soft crash" handler.
 * In that case `reportErrorPrefill` carries the caught error message
 * and the modal is opened automatically instead of the app exploding.
 */
export function ReportErrorModal() {
  const visible = useAppStore((s) => s.reportErrorVisible);
  const prefill = useAppStore((s) => s.reportErrorPrefill);
  const showToast = useAppStore((s) => s.showToast);

  const [area, setArea] = useState<Area>("Profile");
  const [otherArea, setOtherArea] = useState("");
  const [doing, setDoing] = useState("");
  const [expected, setExpected] = useState("");
  const [actual, setActual] = useState("");
  const [shareLog, setShareLog] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!visible) return;
    // If this opened from the ErrorBoundary, drop the caught message
    // into the "what actually happened" field so the user has context
    // they don't have to re-type.
    if (prefill) {
      setActual((prev) => (prev.trim().length === 0 ? prefill : prev));
    }
  }, [visible, prefill]);

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

  const totalChars = doing.length + expected.length + actual.length;
  const overCap = totalChars > MAX_BODY_CHARS;
  const minimallyValid = (doing + expected + actual).trim().length >= 10;

  const close = () => {
    useAppStore.setState({
      reportErrorVisible: false,
      reportErrorPrefill: null,
    });
    // Reset form so a follow-up report doesn't keep stale state.
    setArea("Profile");
    setOtherArea("");
    setDoing("");
    setExpected("");
    setActual("");
    setShareLog(true);
  };

  const submit = async () => {
    if (submitting || overCap || !minimallyValid) return;
    setSubmitting(true);
    try {
      const tail = shareLog
        ? await diagnosticsIpc.getRecentLogLines(200).catch(() => [])
        : [];
      const resolvedArea = area === "Other" ? otherArea.trim() || "Other" : area;
      const body = [
        `Area: ${resolvedArea}`,
        "",
        "What I was doing before the error:",
        doing.trim() || "(blank)",
        "",
        "What I EXPECTED to happen:",
        expected.trim() || "(blank)",
        "",
        "What ACTUALLY happened:",
        actual.trim() || "(blank)",
      ].join("\n");
      const savedPath = await diagnosticsIpc.submitReport({
        kind: "error",
        body,
        fields: {
          area: resolvedArea,
          doing,
          expected,
          actual,
          prefill: prefill ?? null,
          shareLog,
        },
        tail_lines: tail,
      });
      showToast(`Error report saved → ${shortPath(savedPath)}`, "info", 5000);
      close();
    } catch (err) {
      showToast(`Could not save report: ${err}`, "error", 5000);
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
        className="bg-fvp-surface border border-fvp-border rounded-lg shadow-2xl p-5 w-full max-w-2xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold text-fvp-text">Report an error</h3>
            <p className="text-[11px] text-fvp-muted mt-0.5">
              Tell us what went wrong. The more specific, the easier it is to fix.
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

        <div className="flex-1 overflow-y-auto pr-1 space-y-4">
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-fvp-muted mb-1">
              1. What part of the software were you in?
            </label>
            <div className="flex flex-wrap gap-2">
              {AREAS.map((a) => (
                <button
                  key={a}
                  onClick={() => setArea(a)}
                  className={
                    "px-2.5 py-1 text-xs rounded border " +
                    (area === a
                      ? "bg-fvp-accent text-white border-fvp-accent"
                      : "bg-fvp-bg text-fvp-text border-fvp-border hover:border-fvp-muted")
                  }
                >
                  {a}
                </button>
              ))}
            </div>
            {area === "Other" && (
              <input
                value={otherArea}
                onChange={(e) => setOtherArea(e.target.value)}
                placeholder="Describe the area…"
                className="mt-2 w-full bg-fvp-bg border border-fvp-border focus:border-fvp-accent rounded px-2 py-1 text-xs text-fvp-text outline-none"
              />
            )}
          </div>

          <div>
            <label className="block text-[11px] uppercase tracking-wider text-fvp-muted mb-1">
              2. Describe the error
            </label>
            <Field
              label="What were you doing just before the error?"
              value={doing}
              setValue={setDoing}
            />
            <Field
              label="What did you EXPECT to happen?"
              value={expected}
              setValue={setExpected}
            />
            <Field
              label="What ACTUALLY happened?"
              value={actual}
              setValue={setActual}
            />
            <div
              className={
                "text-[10px] text-right " +
                (overCap ? "text-fvp-err" : "text-fvp-muted")
              }
            >
              {totalChars} / {MAX_BODY_CHARS} chars (≈1000-word cap)
            </div>
          </div>

          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={shareLog}
              onChange={(e) => setShareLog(e.target.checked)}
              className="mt-0.5 accent-fvp-accent"
            />
            <span className="text-[11px] text-fvp-muted">
              I understand that my responses will be shared with the developer,
              along with the last 200 lines of terminal output from this session
              (helps reproduce the error). Uncheck to send without log context.
            </span>
          </label>
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
            title={
              overCap
                ? "Description is over the soft cap — please trim."
                : !minimallyValid
                  ? "Add a few words of context before sending."
                  : ""
            }
          >
            {submitting ? "Sending…" : "SEND ERROR REPORT"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  setValue,
}: {
  label: string;
  value: string;
  setValue: (v: string) => void;
}) {
  return (
    <div className="mb-2">
      <div className="text-[11px] text-fvp-muted mb-0.5">{label}</div>
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={2}
        className="w-full bg-fvp-bg border border-fvp-border focus:border-fvp-accent rounded px-2 py-1.5 text-xs text-fvp-text outline-none font-mono"
      />
    </div>
  );
}

function shortPath(p: string): string {
  // Last two path segments are usually enough for the user to find it.
  const parts = p.split(/[\\/]/).filter((x) => x.length > 0);
  if (parts.length <= 2) return p;
  return "…\\" + parts.slice(-2).join("\\");
}
