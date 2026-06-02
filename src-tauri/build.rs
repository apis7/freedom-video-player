use std::path::PathBuf;

fn main() {
    emit_libmpv_link_search();
    copy_libmpv_dll();
    ensure_frontend_dist();
    tauri_build::build();
}

/// Ensure `dist/` exists and reflects the current `src/` before tauri-build
/// embeds it. Without this, a `cargo build` after a frontend edit produces
/// an exe with stale embedded assets (or — in debug mode without a running
/// Vite dev server — the WebView falls back to its disk cache of an older
/// bundle, giving the "I just rebuilt and nothing changed" headache).
///
/// We compare the newest mtime in `../src/` against the newest mtime in
/// `../dist/`. If src is newer (or dist is missing), shell out to
/// `npm run build`. `cargo:rerun-if-changed` directives force cargo to
/// invoke this build script whenever frontend sources change.
fn ensure_frontend_dist() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let repo_root = manifest_dir
        .parent()
        .expect("src-tauri should have a parent directory")
        .to_path_buf();
    let src_dir = repo_root.join("src");
    let dist_dir = repo_root.join("dist");

    println!("cargo:rerun-if-changed={}", src_dir.display());
    println!(
        "cargo:rerun-if-changed={}",
        repo_root.join("index.html").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        repo_root.join("vite.config.ts").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        repo_root.join("package.json").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        repo_root.join("tailwind.config.js").display()
    );

    let src_mtime = newest_mtime(&src_dir).unwrap_or(0);
    let dist_mtime = newest_mtime(&dist_dir).unwrap_or(0);
    let needs_rebuild = !dist_dir.exists() || src_mtime > dist_mtime;

    if !needs_rebuild {
        return;
    }

    println!("cargo:warning=Frontend dist/ is stale or missing; running `npm run build`…");

    let npm_cmd = if cfg!(windows) { "npm.cmd" } else { "npm" };
    let status = std::process::Command::new(npm_cmd)
        .arg("run")
        .arg("build")
        .current_dir(&repo_root)
        .status();

    match status {
        Ok(s) if s.success() => {
            println!("cargo:warning=Frontend rebuilt successfully.");
        }
        Ok(s) => {
            println!(
                "cargo:warning=`npm run build` exited with status {s}. \
                 The binary may contain stale frontend assets."
            );
        }
        Err(e) => {
            println!(
                "cargo:warning=Failed to spawn `npm run build`: {e}. \
                 Skipping frontend rebuild — embedded assets may be stale."
            );
        }
    }
}

/// Walk a directory tree and return the largest mtime (seconds since epoch)
/// found across all files. Returns `None` if the directory doesn't exist
/// or is empty. Skips `node_modules`, `.git`, and dotfiles to avoid noise.
fn newest_mtime(dir: &PathBuf) -> Option<u64> {
    if !dir.exists() {
        return None;
    }
    let mut latest: u64 = 0;
    let mut stack = vec![dir.clone()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path
                .file_name()
                .and_then(|n| n.to_str())
                .map(|s| s == "node_modules" || s == ".git" || s.starts_with('.'))
                .unwrap_or(false)
            {
                continue;
            }
            if let Ok(meta) = entry.metadata() {
                if meta.is_dir() {
                    stack.push(path);
                } else if let Ok(mt) = meta.modified() {
                    if let Ok(secs) = mt.duration_since(std::time::UNIX_EPOCH) {
                        let s = secs.as_secs();
                        if s > latest {
                            latest = s;
                        }
                    }
                }
            }
        }
    }
    if latest > 0 {
        Some(latest)
    } else {
        None
    }
}

#[cfg(not(target_os = "windows"))]
fn emit_libmpv_link_search() {}

#[cfg(target_os = "windows")]
fn emit_libmpv_link_search() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let lib_dir = manifest_dir.join("vendor/libmpv");
    println!("cargo:rustc-link-search=native={}", lib_dir.display());
}

#[cfg(not(target_os = "windows"))]
fn copy_libmpv_dll() {}

#[cfg(target_os = "windows")]
fn copy_libmpv_dll() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let src = manifest_dir.join("vendor/libmpv/libmpv-2.dll");
    if !src.exists() {
        println!(
            "cargo:warning=libmpv-2.dll not found at {} — runtime load will fail",
            src.display()
        );
        return;
    }

    let target_dir = locate_target_profile_dir(&manifest_dir);
    if let Some(dir) = target_dir {
        let dst = dir.join("libmpv-2.dll");
        // Only copy if missing or out of date to avoid relink on every build.
        let needs_copy = match (std::fs::metadata(&src), std::fs::metadata(&dst)) {
            (Ok(s), Ok(d)) => s.len() != d.len(),
            _ => true,
        };
        if needs_copy {
            if let Err(e) = std::fs::copy(&src, &dst) {
                println!("cargo:warning=failed to copy libmpv-2.dll: {}", e);
            }
        }
    }
    println!("cargo:rerun-if-changed=vendor/libmpv/libmpv-2.dll");
}

#[cfg(target_os = "windows")]
fn locate_target_profile_dir(manifest_dir: &PathBuf) -> Option<PathBuf> {
    let profile = std::env::var("PROFILE").ok()?;
    let dir = manifest_dir.join("target").join(profile);
    if dir.exists() { Some(dir) } else { None }
}
