import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../state/appStore";
import { libraryIpc, type LibraryRow } from "../ipc/library";
import { isInResumeRange } from "../components/library/libraryFormat";

const PROGRESS_WRITE_INTERVAL_MS = 5_000;

export interface ResumePrompt {
  fileId: number;
  progressMs: number;
  durationMs: number;
  title: string;
}

/**
 * Player-mode hook that:
 *   1. Looks up the library file id for the currently-playing path
 *      (silent no-op when the path isn't in any watched folder).
 *   2. If saved progress sits in the resume range (5–90 %), surfaces a
 *      resume prompt via the returned `resumePrompt` value.
 *   3. Throttles writes to `library_set_watch_progress` to once every
 *      ~5 s while playing; also flushes on pause and on file unload.
 *
 * The library is the source of truth for watch state; Player Mode itself
 * doesn't store any per-file progress.
 *
 * Returns the current resume prompt + a `dismiss` callback the modal
 * uses when the user resolves it.
 */
export function useLibraryWatchTracker(): {
  resumePrompt: ResumePrompt | null;
  dismissResume: () => void;
} {
  const currentFile = useAppStore((s) => s.currentFile);
  const position = useAppStore((s) => s.position);
  const playing = useAppStore((s) => s.playing);
  const duration = useAppStore((s) => s.duration);
  const mode = useAppStore((s) => s.mode);
  const [resumePrompt, setResumePrompt] = useState<ResumePrompt | null>(null);
  const fileIdRef = useRef<number | null>(null);
  const lastWrittenMsRef = useRef<number>(0);
  const promptShownForRef = useRef<string | null>(null);

  // 1. On every file change, look up the library row. If found AND
  //    there's saved progress in the resume range, schedule the prompt.
  useEffect(() => {
    fileIdRef.current = null;
    lastWrittenMsRef.current = 0;
    setResumePrompt(null);
    if (!currentFile) return;
    let cancelled = false;
    void (async () => {
      try {
        const fileId = await libraryIpc.findFileByPath(currentFile);
        if (cancelled || useAppStore.getState().currentFile !== currentFile) return;
        if (fileId == null) return;
        fileIdRef.current = fileId;
        // Record an "opened" event regardless of how long it ends up
        // being watched. Per directive's separate "opened history".
        void libraryIpc.logOpen(fileId).catch(() => {});
        // Need the row to know saved progress + duration + title.
        const row: LibraryRow | null = await libraryIpc.getRow(fileId);
        if (cancelled || useAppStore.getState().currentFile !== currentFile) return;
        if (!row) return;
        const progressMs = row.file.watch_progress_ms;
        const durMs = row.identity.duration_ms;
        if (
          isInResumeRange(progressMs, durMs) &&
          promptShownForRef.current !== currentFile
        ) {
          promptShownForRef.current = currentFile;
          setResumePrompt({
            fileId,
            progressMs,
            durationMs: durMs,
            title:
              row.identity.movie_title ??
              currentFile.split(/[\\/]/).pop() ??
              "this movie",
          });
        }
      } catch {
        // Soft fail — library tracking is opportunistic, never required.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentFile]);

  // 2. Periodic progress writer. Throttled per PROGRESS_WRITE_INTERVAL_MS.
  //    Only runs while playing AND we have an associated file id.
  useEffect(() => {
    if (!playing) return;
    if (fileIdRef.current == null) return;
    if (mode !== "player") return;
    const interval = window.setInterval(() => {
      const id = fileIdRef.current;
      if (id == null) return;
      const posMs = Math.round(useAppStore.getState().position * 1000);
      if (posMs === lastWrittenMsRef.current) return;
      lastWrittenMsRef.current = posMs;
      void libraryIpc.setWatchProgress(id, posMs).catch(() => {});
    }, PROGRESS_WRITE_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [playing, mode]);

  // 3. Flush a write on pause + on unmount / file change. The position
  //    grabbed here is the latest the store knows about (which the
  //    mpv-event bridge updates continuously).
  useEffect(() => {
    return () => {
      const id = fileIdRef.current;
      if (id == null) return;
      const posMs = Math.round(useAppStore.getState().position * 1000);
      void libraryIpc.setWatchProgress(id, posMs).catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (playing) return; // only fire the flush when transitioning to paused
    const id = fileIdRef.current;
    if (id == null) return;
    const posMs = Math.round(position * 1000);
    if (posMs === lastWrittenMsRef.current) return;
    lastWrittenMsRef.current = posMs;
    void libraryIpc.setWatchProgress(id, posMs).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);
  void duration; // referenced so the store subscription stays live

  return {
    resumePrompt,
    dismissResume: () => setResumePrompt(null),
  };
}
