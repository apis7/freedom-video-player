import { useCallback, useEffect, useState } from "react";
import { libraryIpc, type LibraryRow } from "../../ipc/library";
import { useAppStore } from "../../state/appStore";
import { openVideoPath } from "../../utils/openFileFlow";

interface Props {
  totalItems: number;
  profiledItems: number;
  familyViewOn: boolean;
  refreshToken: number;
}

/**
 * Small unobtrusive line at the bottom of the library list. Shows the
 * profile-creation progress ("12 of 84 movies have profiles") and a
 * suggestion link ("Try (Movie) next?"). Click → loads the movie + jumps
 * to Profile Creator Mode.
 *
 * Hidden when 100% of titles have profiles (nothing left to nudge about)
 * or when the library is empty.
 */
export function ProfileCreatorNudge({
  totalItems,
  profiledItems,
  familyViewOn,
  refreshToken,
}: Props) {
  const [pick, setPick] = useState<LibraryRow | null>(null);
  // Bump to force another suggestion; the effect below pulls a fresh one.
  const [nonce, setNonce] = useState(0);
  const setMode = useAppStore((s) => s.setMode);

  const pullSuggestion = useCallback(async () => {
    try {
      const next = await libraryIpc.profileCreatorSuggest(familyViewOn);
      setPick(next);
    } catch {
      // Non-fatal; the nudge just stays empty.
    }
  }, [familyViewOn]);

  useEffect(() => {
    if (totalItems === 0 || profiledItems >= totalItems) {
      setPick(null);
      return;
    }
    void pullSuggestion();
  }, [totalItems, profiledItems, refreshToken, nonce, pullSuggestion]);

  if (totalItems === 0 || profiledItems >= totalItems) return null;

  return (
    <div className="px-4 py-2 border-t border-fvp-border bg-fvp-surface text-[11px] text-fvp-muted flex items-center gap-3">
      <span>
        {profiledItems} of {totalItems} movie{totalItems === 1 ? "" : "s"} have
        a <span className="font-mono">.free</span> profile.
      </span>
      {pick && (
        <>
          <span className="text-fvp-border">·</span>
          <span>
            Create a new profile?{" "}
            <button
              onClick={() => {
                setMode("creator");
                void openVideoPath(pick.file.path);
              }}
              className="text-fvp-accent hover:underline cursor-pointer font-medium"
              title="Open this movie in Profile Creator"
            >
              Try {pick.identity.movie_title ??
                pick.file.path.split(/[\\/]/).pop() ??
                "this one"}{" "}
              →
            </button>{" "}
            <button
              onClick={() => {
                // Dismiss the current pick for a week + pull another.
                void libraryIpc
                  .dismissSuggestion(pick.identity.id)
                  .then(() => setNonce((n) => n + 1));
              }}
              className="text-fvp-muted hover:text-fvp-text cursor-pointer text-[10px] underline"
              title="Don't suggest this one for a week"
            >
              Not this one — suggest another
            </button>
          </span>
        </>
      )}
    </div>
  );
}
