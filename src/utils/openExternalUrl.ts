/**
 * Open an external URL in the user's default browser via Tauri's opener
 * plugin. Performs a host-allowlist check before opening so a hostile
 * `.free` profile can't redirect the user to attacker.example through
 * a "click here for IMDb" link.
 *
 * The Rust loader's `validate_imdb_url` already gates URLs going INTO
 * the store at load time. This is the second line of defense — even if
 * a URL slipped through (or comes from a different source), we re-check
 * before handing it to the OS shell.
 *
 * On first open per session for any given host, a confirm dialog asks
 * the user whether to proceed. Subsequent opens to the same host are
 * silent until the app restarts.
 */
const sessionApprovedHosts = new Set<string>();

interface OpenOptions {
  /** Hostname suffixes that are auto-trusted (no confirm prompt).
   *  e.g. `["imdb.com"]` accepts `www.imdb.com`, `m.imdb.com`, etc. */
  trustedHostSuffixes: string[];
}

export async function openExternalUrl(
  url: string,
  opts: OpenOptions,
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    alert(`Cannot open URL: not a valid URL.\n\n${url}`);
    return;
  }

  // Scheme allowlist — block javascript:, data:, file:, etc.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    alert(
      `Refusing to open URL with scheme "${parsed.protocol}". Only http and https are allowed.\n\n${url}`,
    );
    return;
  }

  // Host allowlist.
  const host = parsed.hostname.toLowerCase();
  const isTrusted = opts.trustedHostSuffixes.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
  if (!isTrusted && !sessionApprovedHosts.has(host)) {
    const confirmMsg =
      `This URL goes to ${host}, which isn't in the trusted-host list. ` +
      `It came from a .free profile and may not be the link you expect.\n\n` +
      `Full URL:\n${url}\n\n` +
      `Open it in your browser anyway?`;
    if (!confirm(confirmMsg)) return;
    sessionApprovedHosts.add(host);
  }

  // Hand to OS via the existing `open_external_url` Tauri command
  // (commands/autosnip.rs). It already re-validates the scheme on the
  // Rust side as a third line of defense.
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_external_url", { url });
  } catch (err) {
    console.error("openExternalUrl failed:", err);
    alert(`Failed to open URL.\n\n${err}`);
  }
}

/** Convenience wrapper specifically for IMDb URLs from .free profiles. */
export function openImdbUrl(url: string): Promise<void> {
  return openExternalUrl(url, { trustedHostSuffixes: ["imdb.com"] });
}
