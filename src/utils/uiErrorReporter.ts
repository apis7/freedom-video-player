import { actlog } from "./actlog";

/**
 * Frontend error pipeline → terminal log.
 *
 * The Tauri webview's `console.*` calls don't reach the [fvp:*] terminal
 * by default. React render errors swallowed by error boundaries
 * (or worse, silent suspense breakdowns) leave us blind when a user
 * reports "nothing shows up" or "screen went blank."
 *
 * This module installs:
 *   - window.onerror      → forwards uncaught runtime errors
 *   - unhandledrejection  → forwards rejected promises with no handler
 *   - console.error/warn  → mirrors to terminal (original still fires)
 *
 * All forwarding goes through `actlog` which routes via the existing
 * `library_dbg` Tauri command → log!("ui", ...). So the user sees
 * `[fvp:ui] [error] ...` lines alongside backend events.
 *
 * Rate-limited (≤10 errors / second) so a render loop can't flood the
 * IPC channel; truncated to 500 chars per message.
 */

const MAX_LEN = 500;
const RATE_PER_SEC = 10;
let bucket = RATE_PER_SEC;
let lastRefill = Date.now();

function allowed(): boolean {
  const now = Date.now();
  const delta = (now - lastRefill) / 1000;
  bucket = Math.min(RATE_PER_SEC, bucket + delta * RATE_PER_SEC);
  lastRefill = now;
  if (bucket >= 1) {
    bucket -= 1;
    return true;
  }
  return false;
}

function truncate(s: string): string {
  return s.length <= MAX_LEN ? s : s.slice(0, MAX_LEN - 3) + "...";
}

function forward(area: string, message: string): void {
  if (!allowed()) return;
  actlog(area, truncate(message));
}

export function installUiErrorReporter(): void {
  // 1. Uncaught runtime errors.
  window.addEventListener("error", (e) => {
    const where = e.filename
      ? ` at ${e.filename.split("/").pop()}:${e.lineno}:${e.colno}`
      : "";
    forward(
      "error",
      `window.onerror: ${e.message}${where}` +
        (e.error?.stack ? ` :: ${String(e.error.stack).split("\n")[0]}` : ""),
    );
  });

  // 2. Unhandled promise rejections.
  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason;
    const msg =
      reason instanceof Error
        ? `${reason.message} :: ${String(reason.stack ?? "").split("\n")[0]}`
        : typeof reason === "string"
          ? reason
          : JSON.stringify(reason);
    forward("error", `unhandledrejection: ${msg}`);
  });

  // 3. Mirror console.error / console.warn to terminal.
  const origErr = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  console.error = (...args: unknown[]) => {
    origErr(...args);
    try {
      forward("error", "console.error: " + args.map(stringifyArg).join(" "));
    } catch {
      /* never let logging itself throw */
    }
  };
  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    try {
      forward("warn", "console.warn: " + args.map(stringifyArg).join(" "));
    } catch {
      /* ignore */
    }
  };

  forward("info", "uiErrorReporter installed");
}

function stringifyArg(a: unknown): string {
  if (a instanceof Error) return `${a.message}`;
  if (typeof a === "string") return a;
  if (typeof a === "number" || typeof a === "boolean") return String(a);
  try {
    return JSON.stringify(a).slice(0, 200);
  } catch {
    return Object.prototype.toString.call(a);
  }
}

/**
 * One-line diagnostic. Use for tracing render-path state, not user
 * actions (those belong in actlog). Same channel, different prefix
 * so the two streams are easy to grep apart.
 */
export function diag(area: string, message: string): void {
  forward(`diag:${area}`, message);
}
