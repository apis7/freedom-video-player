import { invoke } from "@tauri-apps/api/core";

export interface LibraryItem {
  path: string;
  filename: string;
  size_bytes: number;
  modified_unix: number;
  profile_count: number;
}

export const libraryIpc = {
  scan: (folder: string, recursive: boolean) =>
    invoke<LibraryItem[]>("scan_library_folder", { folder, recursive }),
  watch: (folder: string) => invoke<void>("watch_library_folder", { folder }),
  unwatch: () => invoke<void>("unwatch_library_folder"),
};
