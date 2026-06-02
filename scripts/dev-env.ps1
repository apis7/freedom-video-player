# FVP dev environment setup.
# Source this from PowerShell before running cargo, tauri, or npm commands that touch the Rust backend:
#   . .\scripts\dev-env.ps1
#
# It loads MSVC env vars (vcvars64.bat) and adds cargo bin to PATH.
# Safe to source multiple times.

$ErrorActionPreference = "Stop"

# Add VS Installer dir to PATH so vcvars64.bat can find vswhere.exe
$installerDir = "C:\Program Files (x86)\Microsoft Visual Studio\Installer"
if (Test-Path $installerDir -and $env:PATH -notlike "*$installerDir*") {
  $env:PATH = "$installerDir;$env:PATH"
}

# Source vcvars64.bat into the current PowerShell session
$vcvars = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path $vcvars)) {
  Write-Host "ERROR: vcvars64.bat not found at $vcvars" -ForegroundColor Red
  Write-Host "Install Microsoft C++ Build Tools with the VC.Tools workload." -ForegroundColor Red
  return
}

if (-not $env:VSCMD_VER) {
  Write-Host "Sourcing MSVC environment..." -ForegroundColor DarkGray
  cmd /c "`"$vcvars`" >nul && set" | ForEach-Object {
    if ($_ -match '^([^=]+)=(.*)$') {
      [System.Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
    }
  }
}

# Cargo bin
$cargoBin = "$env:USERPROFILE\.cargo\bin"
if ((Test-Path $cargoBin) -and ($env:PATH -notlike "*$cargoBin*")) {
  $env:PATH = "$cargoBin;$env:PATH"
}

Write-Host "FVP dev env ready: MSVC $($env:VSCMD_VER), Rust $((& rustc --version 2>&1).Split(' ')[1])" -ForegroundColor Green
