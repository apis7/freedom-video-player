import { invoke } from "@tauri-apps/api/core";

/** Returned by `autosnip_run`. `bucket` is either "flag" or one of the
 *  snip-action kinds: "skip" / "silence" / "freeze" / "replace". */
export interface AutoSnipMatch {
  category: string;
  bucket: string;
  keyword: string;
  subtitle_index: number;
  start_ms: number;
  end_ms: number;
  text: string;
}

export const autoSnipIpc = {
  run: (videoPath: string, langCode: string | null = null) =>
    invoke<AutoSnipMatch[]>("autosnip_run", { videoPath, langCode }),
  runOnEntries: (
    entries: { start_ms: number; end_ms: number; text: string }[],
    langCode: string | null = null,
  ) =>
    invoke<AutoSnipMatch[]>("autosnip_run_on_entries", { entries, langCode }),
  findSubtitles: (videoPath: string) =>
    invoke<string | null>("autosnip_find_subtitles", { videoPath }),
  loadWhitelist: (videoPath: string) =>
    invoke<string[]>("load_autosnip_whitelist", { videoPath }),
  saveWhitelist: (videoPath: string, keywords: string[]) =>
    invoke<void>("save_autosnip_whitelist", { videoPath, keywords }),
};
