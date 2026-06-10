import { Component, type ErrorInfo, type ReactNode } from "react";
import { actlog } from "../utils/actlog";
import { useAppStore } from "../state/appStore";

interface Props {
  children: ReactNode;
}
interface State {
  err: Error | null;
}

/**
 * Top-level React error boundary. Without this, a render error in any
 * descendant unmounts the entire tree and the user sees a blank
 * white screen with nothing in the terminal. Behaviour:
 *
 *   1. Forward the error to the [fvp:ui] terminal log.
 *   2. Open the Help → Report Error modal pre-filled with the error
 *      message + component stack so the user can describe what they
 *      were doing instead of staring at a crash screen.
 *   3. Render a recovery panel underneath so reload/recover stays
 *      reachable even if the user dismisses the report.
 */
export class UiErrorBoundary extends Component<Props, State> {
  state: State = { err: null };

  static getDerivedStateFromError(err: Error): State {
    return { err };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    actlog(
      "error",
      `ReactErrorBoundary: ${error.message} :: at ${(info.componentStack ?? "").split("\n").slice(1, 4).join(" / ")}`,
    );
    // eslint-disable-next-line no-console
    console.error("ReactErrorBoundary caught:", error, info);
    // (A.1) Catch: instead of letting the recovery screen be the only
    // option, also pop the Report Error modal pre-filled with details.
    // Best-effort — if the store itself is broken, we just rely on the
    // recovery panel.
    try {
      useAppStore.setState({
        reportErrorVisible: true,
        reportErrorPrefill:
          `${error.message}\n\nComponent stack:${info.componentStack ?? "(none)"}` +
          (error.stack
            ? `\n\nStack (top 8):\n${error.stack.split("\n").slice(0, 8).join("\n")}`
            : ""),
      });
    } catch {
      /* ignore */
    }
  }

  render() {
    if (this.state.err) {
      return (
        <div className="h-screen w-screen bg-fvp-bg text-fvp-text flex items-center justify-center p-6">
          <div className="max-w-lg bg-fvp-surface border border-fvp-err rounded-lg p-5 space-y-3">
            <h2 className="text-lg font-semibold text-fvp-err">
              FVP hit a render error
            </h2>
            <p className="text-xs text-fvp-muted">
              The error is in the terminal log too. Reload to try again.
            </p>
            <pre className="text-[11px] bg-fvp-bg p-2 rounded overflow-auto max-h-[200px] text-fvp-err font-mono whitespace-pre-wrap">
              {this.state.err.message}
              {"\n\n"}
              {(this.state.err.stack ?? "").split("\n").slice(0, 6).join("\n")}
            </pre>
            <button
              onClick={() => window.location.reload()}
              className="px-3 py-1.5 bg-fvp-accent text-white text-sm rounded hover:opacity-90"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
