/**
 * Library Networking Phase 2b — HTTP client for Client mode.
 *
 * When this install is configured as a Client, every library_* IPC
 * call routes through here instead of Tauri's local `invoke`. We hit
 * the configured Host at `POST /v1/ipc/<command>` with the X-FVP-Auth
 * header, serialize args as snake_case JSON (matching Tauri's auto-
 * conversion behavior on the local side), and return whatever the
 * Host sent back.
 *
 * Endpoint info comes from one of:
 *   - Settings.host_address + Settings.host_auth_token (user typed)
 *   - The home folder's host-discovery.json + auth-token files
 *     (read via `library_read_home_discovery` on boot)
 *
 * Phase 3 (next batch) layers in: snapshot of the last successful
 * list_items so the UI still renders something when the Host is
 * offline + a "library is read-only — Host is offline" banner.
 */

import { invoke } from "@tauri-apps/api/core";

interface Endpoint {
  url: string;
  token: string;
}

let cachedEndpoint: Endpoint | null = null;
let lastFailureAt: number | null = null;
let lastFailureMessage: string | null = null;
const FAIL_BACKOFF_MS = 3000;

export function setHostEndpoint(e: Endpoint | null) {
  cachedEndpoint = e;
  if (e) {
    lastFailureAt = null;
    lastFailureMessage = null;
  }
}
export function getHostEndpoint(): Endpoint | null {
  return cachedEndpoint;
}
export function getHostHealth(): {
  online: boolean;
  lastFailureAt: number | null;
  lastFailureMessage: string | null;
} {
  return {
    online:
      lastFailureAt === null ||
      Date.now() - lastFailureAt > FAIL_BACKOFF_MS * 10,
    lastFailureAt,
    lastFailureMessage,
  };
}

/** Convert camelCase keys to snake_case so the Host dispatcher (which
 *  reads args as snake_case to match the underlying Tauri commands)
 *  can find each field. Cheap; non-recursive (args are flat). */
function toSnakeCase(
  o: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!o) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    const sc = k.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
    out[sc] = v;
  }
  return out;
}

/**
 * Hit the Host's `POST /v1/ipc/<command>` endpoint. Returns the
 * parsed JSON response on success; throws on network failure,
 * non-2xx status, or auth rejection.
 */
export async function clientCall<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!cachedEndpoint) {
    throw new Error(
      `Client mode but no Host endpoint set (command: ${command})`,
    );
  }
  const { url, token } = cachedEndpoint;
  const trimmed = url.replace(/\/+$/, "");
  const target = `${trimmed}/v1/ipc/${command}`;
  try {
    const resp = await fetch(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-FVP-Auth": token,
      },
      body: JSON.stringify(toSnakeCase(args)),
    });
    if (!resp.ok) {
      const txt = await resp.text();
      const msg = `Host ${command}: ${resp.status} ${txt}`;
      lastFailureAt = Date.now();
      lastFailureMessage = msg;
      throw new Error(msg);
    }
    // Reset failure markers on success.
    lastFailureAt = null;
    lastFailureMessage = null;
    return (await resp.json()) as T;
  } catch (e) {
    if (!(e instanceof Error) || !e.message.startsWith("Host ")) {
      const msg = `Host unreachable (${command}): ${e}`;
      lastFailureAt = Date.now();
      lastFailureMessage = msg;
      throw new Error(msg);
    }
    throw e;
  }
}

// ── Mode + dispatch ──────────────────────────────────────────────────

let currentMode: "standalone" | "host" | "client" = "standalone";

export function setLibraryMode(m: "standalone" | "host" | "client") {
  currentMode = m;
}
export function getLibraryMode(): "standalone" | "host" | "client" {
  return currentMode;
}

/**
 * Library-aware invoke wrapper. In Client mode with a configured
 * endpoint, routes through the Host's HTTP API. Otherwise, falls
 * straight to Tauri's local invoke. The `command` arg is the BARE
 * command name (without the `library_` prefix); the local-invoke
 * branch adds the prefix back.
 *
 * Commands that MUST always run locally (per-install settings,
 * host-server lifecycle, PIN management, etc.) call `invoke` directly
 * — they're not routed through this wrapper.
 */
export async function libInvoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (currentMode === "client" && cachedEndpoint) {
    return clientCall<T>(command, args);
  }
  return invoke<T>(`library_${command}`, args);
}

/** Read auto-discovery from the home folder (host-discovery.json +
 *  auth-token). Falls back to manually-configured host_address +
 *  host_auth_token in settings if the home folder lookup fails. */
export interface HomeDiscoverySnapshot {
  host_url: string;
  token: string;
  fvp_version: string | null;
  protocol: number | null;
  updated_at: number | null;
}
export async function readHomeDiscovery(): Promise<HomeDiscoverySnapshot | null> {
  return invoke<HomeDiscoverySnapshot | null>("library_read_home_discovery");
}
