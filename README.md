# Freedom Video Player

A cross-platform video player with profile-based filtering. Create or
share `.free` profiles to automate modified playback of your own video
files without modifying them.

> *Freedom Video Player. Helping you hit the "skip" button.*

## Status

Alpha. Windows-first (Chapter 1). Daily-driver usable for the
maintainer; rough edges remain — the library DB schema is still
actively migrating, so expect occasional churn until Chapter 2.

## Download

**Latest Windows installer (NSIS, x64):** see the
[Releases page](https://github.com/apis7/freedom-video-player/releases/latest).

After installing, FVP shows a one-time tip about the optional
Library Networking feature (see below).

## Library Networking (Alpha — Phase 1 of 3)

You can share one library across multiple FVP installs (Windows now;
Mac / iOS / Android later) by designating a **network folder** as the
shared "home". One install runs as the **Host** (its local DB is the
source of truth); other installs connect as **Clients** over the LAN.

The library SQLite database itself stays local to the Host — SQLite
over SMB corrupts. The home folder on the share holds the **shared
poster cache**, **LAN auth token**, and **Host discovery info** so
Clients can find the Host.

Configure in `Settings → Library → Library Networking`:

- **Standalone** (default) — library lives only on this device.
- **Host** — this device IS the library; other installs connect to it.
- **Client** — talk to a Host on the LAN.

Phase 1 (current build): settings + folder bootstrap only.
Phase 2: HTTP API + Host/Client networking.
Phase 3: offline read-only mode + mobile-client protocol spec.

## Stack

- **Backend:** Rust + Tauri 2, libmpv2 4.1 wraps libmpv for playback
- **Frontend:** React 18 + TypeScript + Vite + Tailwind + Zustand 5
- **IPC:** Tauri commands (frontend → backend) + Tauri events (backend → frontend)
- **Platform glue (Windows):** intermediate STATIC child HWND hosts the
  libmpv render surface inside the Tauri webview; a WNDPROC subclass
  forwards right-clicks back to the frontend as a Tauri event

## Building

### Prerequisites

- Node 20+
- Rust stable (1.80+) — make sure `%USERPROFILE%\.cargo\bin` is on PATH
- Visual Studio Build Tools 2022 (for the MSVC linker on Windows)
- WebView2 Runtime (Win 10+ usually has it)
- **libmpv binary** — see `src-tauri/vendor/libmpv/README.md`.
  Not committed to the repo (~113 MB, exceeds GitHub's single-file limit).

### Dev workflow

```powershell
npm install
npm run tauri dev        # full app with Vite HMR + backend rebuild
```

Or build the dev binary directly without the Vite dev server — the
`build.rs` runs `npm run build` automatically when the frontend is
stale, so a bare `cargo build` always ships the latest UI inside the
binary:

```powershell
cargo build --manifest-path src-tauri/Cargo.toml
# launch: src-tauri/target/debug/fvp.exe
```

### Installer

```powershell
npm run tauri build
# output: src-tauri/target/release/bundle/nsis/Freedom Video Player_0.1.0_x64-setup.exe
```

Per-user NSIS installer, registers file associations for common video
extensions + `.free`.

## Repo layout

```
src/                   React + TypeScript frontend
src-tauri/             Rust backend (Tauri app)
  src/
    playback/          libmpv wrapper + audio overlay
    profile/           .free schema, signing, I/O
    fingerprint/       perceptual hash + match scoring
    autosnip/          subtitle keyword scanner
    commands/          Tauri command surface
    tmdb/              TMDb API client (movie info auto-fill)
  vendor/libmpv/       Binary not committed — see README there
  assets/              Bundled wordlists for AutoSnip
  icons/               App icons
md_files/              Spec documents (directives, UI plans, etc.)
WORDLISTS.md           Quick-reference for editing AutoSnip wordlists
UI_mockup/             Reference-only Claude Design mockup
```

## Documentation

- `CLAUDE.md` — Project guide for AI-assisted development
- `md_files/directives.md` — Source of truth for hotkeys + behavior
- `md_files/maps_rating_and_movie_info.md` — MAPS rating system spec
- `WORDLISTS.md` — Where + how to edit AutoSnip wordlists
- `md_files/website_specs.md` — Eventual sharing-site design

## License

TBD. All rights reserved during early development.
