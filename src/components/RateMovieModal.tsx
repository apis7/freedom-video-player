import { useEffect, useState } from "react";
import clsx from "clsx";
import { useAppStore } from "../state/appStore";

interface Props {
  /** Title displayed in the modal — typically the currently-loaded
   *  filename (so the user knows what they're rating). */
  movieTitle: string;
  onClose: () => void;
}

/**
 * Stub modal for the "rate this movie on the FVP website" feature.
 *
 * Currently UI-only:
 *   - User picks 1-10 stars
 *   - Clicks OK → toast says "Stubbed — would send rating to <domain>"
 *   - Nothing actually leaves the machine
 *
 * When the real sharing site is up, swap the OK handler to actually
 * POST the rating + the video's fingerprint. The stub's contract is
 * intentionally narrow so wiring it up later is just one function body.
 */
const FVP_DOMAIN_PLACEHOLDER = "freedomvideoplayer.com";

export function RateMovieModal({ movieTitle, onClose }: Props) {
  const inc = useAppStore((s) => s.incrementOpenModalCount);
  const dec = useAppStore((s) => s.decrementOpenModalCount);
  const showToast = useAppStore((s) => s.showToast);
  const [stars, setStars] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    inc();
    return () => dec();
  }, [inc, dec]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Enter" && stars != null) {
        e.preventDefault();
        submit();
      } else if (/^[1-9]$/.test(e.key)) {
        setStars(parseInt(e.key, 10));
      } else if (e.key === "0") {
        setStars(10);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // submit closes over stars; recompute on change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stars]);

  const submit = () => {
    if (stars == null) return;
    // TODO: wire to real backend when sharing site exists. Should POST
    // { fingerprint, rating } to <FVP_DOMAIN>/api/ratings and surface
    // network errors via toast.
    showToast(
      `[Stub] Would send ${stars}-star rating for "${movieTitle}" to ${FVP_DOMAIN_PLACEHOLDER}. ` +
        `Real submission ships with the sharing site.`,
      "info",
      6000,
    );
    onClose();
  };

  const displayedStars = hover ?? stars ?? 0;

  return (
    <div
      className="fixed inset-0 bg-black/60 z-[55] flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="bg-fvp-surface border border-fvp-border rounded-lg shadow-2xl p-5 min-w-[440px] max-w-[560px]"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-fvp-text mb-1">
          Rate this movie
        </h3>
        <p
          className="text-[11px] text-fvp-muted mb-4 truncate"
          title={movieTitle}
        >
          {movieTitle}
        </p>

        <div
          className="flex items-center gap-1 justify-center mb-4"
          onMouseLeave={() => setHover(null)}
          role="radiogroup"
          aria-label="Rating"
        >
          {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => {
            const filled = n <= displayedStars;
            return (
              <button
                key={n}
                type="button"
                onMouseEnter={() => setHover(n)}
                onClick={() => setStars(n)}
                title={`${n} / 10`}
                aria-label={`${n} stars`}
                role="radio"
                aria-checked={stars === n}
                className={clsx(
                  "w-7 h-7 flex items-center justify-center text-xl leading-none transition-colors",
                  filled
                    ? "text-fvp-warn"
                    : "text-fvp-border hover:text-fvp-warn/60",
                )}
              >
                ★
              </button>
            );
          })}
        </div>

        <div className="text-center text-xs text-fvp-text mb-4 min-h-[1.2em]">
          {stars != null ? (
            <>
              <span className="font-mono tabular-nums">{stars}</span>{" "}
              / 10
            </>
          ) : (
            <span className="text-fvp-muted">
              Click a star, or press 1–9 / 0 (=10)
            </span>
          )}
        </div>

        <div className="text-[10px] text-fvp-muted bg-fvp-bg/60 border border-fvp-border/50 rounded px-2 py-1.5 mb-4 leading-relaxed">
          Pressing OK will send this rating to{" "}
          <code className="font-mono text-fvp-text">{FVP_DOMAIN_PLACEHOLDER}</code>{" "}
          (the sharing site for FVP profiles). The rating is associated
          with this movie's fingerprint, not your computer or account.
          <br />
          <span className="text-fvp-warn">
            ⚠ Stubbed feature — nothing is actually sent yet.
          </span>
        </div>

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded text-xs bg-fvp-bg border border-fvp-border text-fvp-text hover:border-fvp-muted"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={stars == null}
            className="px-3 py-1.5 rounded text-xs bg-fvp-accent text-white hover:opacity-90 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
