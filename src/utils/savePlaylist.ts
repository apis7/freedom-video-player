import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../state/appStore";

/** Write the currently-loaded file path as a single-entry .m3u playlist
 *  the user can drag into other players or share. */
export async function savePlaylistFlow(): Promise<void> {
  const current = useAppStore.getState().currentFile;
  if (!current) {
    useAppStore.getState().showToast("Open a video first.", "warn");
    return;
  }
  const target = await save({
    filters: [{ name: "Playlist", extensions: ["m3u", "m3u8"] }],
    defaultPath: "playlist.m3u",
  });
  if (!target) return;
  const content =
    "#EXTM3U\n" +
    "#EXTINF:-1," +
    (current.split(/[\\/]/).pop() ?? current) +
    "\n" +
    current +
    "\n";
  try {
    await invoke("write_text_file", { path: target, content });
    useAppStore.getState().showToast(`Saved playlist:\n${target}`, "info", 4000);
  } catch (err) {
    useAppStore
      .getState()
      .showToast(`Couldn't write playlist:\n${err}`, "error", 6000);
  }
}
