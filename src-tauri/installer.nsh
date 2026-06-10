; Freedom Video Player — NSIS installer hooks
;
; Tauri 2's NSIS bundler runs these hook macros at well-known points
; during install / uninstall. We use NSIS_HOOK_POSTINSTALL to show a
; one-shot recommendation about the Library Networking feature so the
; user knows about the "shared home folder" pattern before they
; launch FVP for the first time.
;
; Reference: https://v2.tauri.app/distribute/windows-installer/#installer-hooks

!macro NSIS_HOOK_POSTINSTALL
  MessageBox MB_OK|MB_ICONINFORMATION "Freedom Video Player is installed.$\r$\n$\r$\nTIP — Sharing your library across devices:$\r$\n$\r$\nIf you want to access the same FVP library from multiple devices (laptop, desktop, eventually iPhone/Android), designate one network folder as your FVP 'home' and point every install at it from Settings > Library > Library Networking.$\r$\n$\r$\nOne device runs as the 'Host' (its DB is the source of truth); the others connect as 'Clients'. The Host serves the library over your LAN; clients still play files directly from the network share.$\r$\n$\r$\nLeave the default 'Standalone' mode if you only use FVP on this one device. You can change this anytime in Settings."
!macroend
