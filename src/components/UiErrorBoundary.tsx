import { Component, type ErrorInfo, type ReactNode } from "react";
import { actlog } from "../utils/actlog";

interface Props {
  children: ReactNode;
}
interface State {
  err: Error | null;
}

/**
 * Top-level React error boundary. Without this, a render error in any
 * descendant unmounts the entire tree and the user sees a blank
 * white screen with nothing in the terminal. Now: error is forwarded
 * to the [fvp:ui] terminal log AND a recovery panel is shown so the
 * user can switch modes or reload.
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
