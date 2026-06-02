import { invoke } from "@tauri-apps/api/core";
import type { Fingerprint, FreeFile, MatchResult } from "./types";

export const profileIpc = {
  computeFingerprint: (path: string) =>
    invoke<Fingerprint>("compute_fingerprint", { path }),
  scanFolderForProfiles: (videoPath: string) =>
    invoke<MatchResult[]>("scan_folder_for_profiles", { videoPath }),
  loadProfile: (path: string) =>
    invoke<FreeFile>("load_profile", { path }),
  saveProfile: (path: string, profile: FreeFile) =>
    invoke<void>("save_profile", { path, profile }),
  verifyProfile: (profile: FreeFile) =>
    invoke<boolean>("verify_profile", { profile }),
  saveDraft: (videoPath: string, json: string) =>
    invoke<void>("save_draft", { videoPath, json }),
  loadDraft: (videoPath: string) =>
    invoke<string | null>("load_draft", { videoPath }),
  deleteDraft: (videoPath: string) =>
    invoke<void>("delete_draft", { videoPath }),
  fileExists: (path: string) => invoke<boolean>("file_exists", { path }),
  isDirectory: (path: string) => invoke<boolean>("is_directory", { path }),
};
