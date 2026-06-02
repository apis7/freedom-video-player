# libmpv vendored binary

`libmpv-2.dll` is required to build FVP but is **not committed** to this
repo — it's ~113 MB, over GitHub's 100 MB single-file limit, and would
balloon the repo size on every clone.

## What you need

Drop the following files into THIS folder (`src-tauri/vendor/libmpv/`):

- `libmpv-2.dll`  ← runtime DLL (Windows)
- `libmpv.dll.a`  ← import library for linking
- `mpv.def`, `mpv.exp`, `mpv.lib`  ← MSVC linker inputs

The `include/` subfolder (headers) IS committed to the repo, so you only
need the binary side.

## Where to get it

The official source is the upstream **shinchiro/mpv-winbuild-cmake**
release on GitHub:

<https://github.com/shinchiro/mpv-winbuild-cmake/releases>

Look for a `mpv-dev-x86_64-*.7z` artifact. Inside the archive:

- The `.dll`, `.lib`, `.dll.a`, `.def`, `.exp` files live at the root or
  under a similar path.
- Headers live under `include/`.

We've been pinning to whatever version was current when the `mpv.def` /
`mpv.exp` were originally vendored. Newer versions should work if the
ABI hasn't changed — the libmpv2 Rust crate (`Cargo.toml`) needs to
match.

## After dropping the files in

```powershell
cargo build --manifest-path src-tauri/Cargo.toml
```

The build script in `src-tauri/build.rs` will pick up the `.dll` and
copy it next to the freshly-built `fvp.exe` in `target/debug/` or
`target/release/`.
