; Freedom Video Player — NSIS installer hooks
;
; Tauri 2's NSIS bundler runs these hook macros at well-known points
; during install / uninstall.
;
; We deliberately do NOT show a MessageBox on install: the in-app
; first-run wizard handles introducing the user to Library Networking
; the first time they open Library Mode. A native NSIS MessageBox
; can't match FVP's UI styling and most users skip past it without
; reading, whereas the in-app wizard is impossible to miss and looks
; like the rest of the product.
;
; Reference: https://v2.tauri.app/distribute/windows-installer/#installer-hooks

!macro NSIS_HOOK_POSTINSTALL
  ; intentionally empty — first-run UX lives inside the app
!macroend
