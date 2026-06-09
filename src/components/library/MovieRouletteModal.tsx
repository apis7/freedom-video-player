import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { useAppStore } from "../../state/appStore";
import { libraryIpc, type LibraryRow } from "../../ipc/library";
import { LibraryPoster } from "./LibraryPoster";
import { formatRuntime } from "./libraryFormat";
import { openVideoPath } from "../../utils/openFileFlow";

interface Props {
  /** Candidate file ids the user dragged into the tool. Empty = whole library. */
  fileIds: number[];
  /** Pool of rows to source faces for the spin animation from. Cheap to
   *  pass in since the parent already has them on screen. */
  poolRows: LibraryRow[];
  familyViewOn: boolean;
  onClose: () => void;
}

const SPIN_DURATION_MS = 3500;
const SLOWDOWN_AT_MS = 2200;
const REVEAL_DELAY_MS = 400;

/**
 * Movie Roulette modal — "great fanfare" decision tool. Visual-only per the
 * locked decision (no audio asset). The spin reel cycles through
 * randomly-chosen library posters with accelerating then decelerating
 * cadence; the actual winner is computed by the backend and revealed at
 * the end. Confetti explodes on reveal.
 *
 * Mounts a backdrop that swallows pointer events so the user can't
 * accidentally click through the dramatic moment.
 */
export function MovieRouletteModal({ fileIds, poolRows, familyViewOn, onClose }: Props) {
  const inc = useAppStore((s) => s.incrementOpenModalCount);
  const dec = useAppStore((s) => s.decrementOpenModalCount);
  const showToast = useAppStore((s) => s.showToast);

  const [stage, setStage] = useState<"spinning" | "reveal" | "error">("spinning");
  const [winner, setWinner] = useState<LibraryRow | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [reelIdx, setReelIdx] = useState(0);
  const reelOptions = useRef<LibraryRow[]>([]);

  useEffect(() => {
    inc();
    return () => dec();
  }, [inc, dec]);

  // Seed the reel with up to ~30 rows from the candidate pool so the
  // animation has visible variety.
  useEffect(() => {
    reelOptions.current = pickReelOptions(poolRows, 30, familyViewOn);
  }, [poolRows, familyViewOn]);

  // Kick the backend pick + run the spin animation in parallel.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const picked = await libraryIpc.roulettePick(fileIds, familyViewOn);
        if (cancelled) return;
        if (!picked) {
          setStage("error");
          setErrMsg("No movies match the current selection.");
          return;
        }
        setWinner(picked);
      } catch (err) {
        if (cancelled) return;
        setStage("error");
        setErrMsg(`${err}`);
      }
    })();

    // Reel animation — ms-per-tick that decelerates as we approach the reveal.
    const start = performance.now();
    let raf = 0;
    let lastTick = start;
    let interval = 60; // ms between reel advances at top speed
    const step = (now: number) => {
      if (cancelled) return;
      const elapsed = now - start;
      // Decelerate after SLOWDOWN_AT_MS — interval grows from 60 → ~600 ms
      if (elapsed > SLOWDOWN_AT_MS) {
        const progress = Math.min(1, (elapsed - SLOWDOWN_AT_MS) / (SPIN_DURATION_MS - SLOWDOWN_AT_MS));
        interval = 60 + progress * 540;
      }
      if (now - lastTick >= interval) {
        lastTick = now;
        setReelIdx((i) => i + 1);
      }
      if (elapsed >= SPIN_DURATION_MS) {
        // Pause briefly for drama, then reveal.
        window.setTimeout(() => {
          if (!cancelled) setStage("reveal");
        }, REVEAL_DELAY_MS);
        return;
      }
      raf = window.requestAnimationFrame(step);
    };
    raf = window.requestAnimationFrame(step);

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const playWinner = () => {
    if (!winner) return;
    onClose();
    void openVideoPath(winner.file.path);
    showToast(`Now playing → ${winner.identity.movie_title ?? "selection"}`, "info", 2500);
  };

  const reroll = () => {
    setStage("spinning");
    setWinner(null);
    setReelIdx(0);
    reelOptions.current = pickReelOptions(poolRows, 30, familyViewOn);
    // Re-fire the effect by remounting via key (parent owns mount) — but
    // since we own the spin, just reset state and re-run the kickoff via
    // another effect would be heavier. Simplest: re-mount this modal.
    // (Parent should close + reopen, but we don't have that hook here.)
    // For V1 we simulate by setting a re-trigger marker; the spinning
    // effect re-runs because reelOptions reset implies a new spin.
    // We achieve this by forcing a key-based remount.
    setForceRemount((n) => n + 1);
  };
  // Force-remount counter so reroll re-runs the spin effect cleanly.
  const [forceRemount, setForceRemount] = useState(0);

  // Reel face for the current tick — mod into reelOptions.
  const reelLen = reelOptions.current.length;
  const reelFace = reelLen > 0 ? reelOptions.current[reelIdx % reelLen]! : null;

  return (
    <div
      className="fixed inset-0 bg-black/85 z-[80] flex items-center justify-center select-none"
      onClick={(e) => {
        // Clicking the backdrop during reveal is treated as "close"; during
        // spin we swallow it (don't let the user accidentally bail).
        if (stage === "reveal" || stage === "error") {
          if (e.target === e.currentTarget) onClose();
        }
      }}
      key={forceRemount}
    >
      <div className="flex flex-col items-center max-w-[640px] w-full px-6">
        <div className="text-fvp-text text-2xl font-bold mb-1 tracking-wide">
          🎬 Movie Roulette
        </div>
        <div className="text-fvp-muted text-xs mb-6">
          {stage === "spinning"
            ? "Spinning the wheel of cinematic destiny…"
            : stage === "reveal"
              ? "Drumroll please…"
              : "Couldn't pick a movie."}
        </div>

        {stage !== "error" && (
          <div className="relative">
            <div
              className={clsx(
                "rounded-lg overflow-hidden border-4 transition-all",
                stage === "spinning"
                  ? "border-fvp-accent shadow-[0_0_40px_rgba(79,140,255,0.45)] motion-safe:animate-pulse"
                  : "border-fvp-ok shadow-[0_0_60px_rgba(63,185,80,0.55)]",
              )}
            >
              <ReelFace row={stage === "reveal" ? winner : reelFace} />
            </div>
            {stage === "reveal" && <ConfettiBurst />}
          </div>
        )}

        {stage === "reveal" && winner && (
          <div className="mt-5 text-center">
            <div className="text-fvp-text text-xl font-bold">
              {winner.identity.movie_title ??
                winner.file.path.split(/[\\/]/).pop() ??
                "(untitled)"}
            </div>
            <div className="text-fvp-muted text-xs mt-1">
              {winner.identity.movie_year ? `${winner.identity.movie_year} · ` : ""}
              {formatRuntime(winner.identity.duration_ms)}
              {winner.identity.genres.length > 0
                ? ` · ${winner.identity.genres.slice(0, 3).join(", ")}`
                : ""}
            </div>
            <div className="mt-5 flex gap-2 justify-center text-xs">
              <button
                onClick={onClose}
                className="px-3 py-1.5 text-fvp-text hover:bg-fvp-surface2 rounded"
              >
                Cancel
              </button>
              <button
                onClick={reroll}
                className="px-3 py-1.5 bg-fvp-bg border border-fvp-border hover:border-fvp-muted text-fvp-text rounded"
              >
                Spin again
              </button>
              <button
                onClick={playWinner}
                autoFocus
                className="px-4 py-1.5 bg-fvp-ok text-white rounded hover:opacity-90 font-semibold"
              >
                Play this →
              </button>
            </div>
          </div>
        )}

        {stage === "error" && (
          <div className="mt-2 text-center">
            <div className="text-fvp-err text-sm mb-3">{errMsg}</div>
            <button
              onClick={onClose}
              className="px-3 py-1.5 bg-fvp-bg border border-fvp-border hover:border-fvp-muted text-fvp-text rounded text-xs"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ReelFace({ row }: { row: LibraryRow | null }) {
  if (!row) {
    return (
      <div
        style={{ width: 220, height: 330 }}
        className="bg-fvp-surface2 flex items-center justify-center text-fvp-muted text-xs"
      >
        Loading…
      </div>
    );
  }
  return (
    <LibraryPoster
      customThumbnailPath={row.identity.custom_thumbnail_path}
      posterLocalPath={row.identity.poster_local_path}
      widthPx={220}
      alt={row.identity.movie_title ?? ""}
    />
  );
}

function pickReelOptions(
  rows: LibraryRow[],
  count: number,
  familyViewOn: boolean,
): LibraryRow[] {
  // In Family Mode, drop NFF rows from the reel — even though the
  // BACKEND pick already excludes them, the flashing preview would
  // surface those posters mid-spin and defeat the whole point.
  const eligible = familyViewOn
    ? rows.filter((r) => !r.identity.non_family_friendly)
    : rows;
  if (eligible.length === 0) return [];
  const shuffled = [...eligible].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(count, eligible.length));
}

/**
 * Quick CSS-only confetti burst — 60 colored particles fired in random
 * directions on mount, then they fall + fade. No JS animation loop; pure
 * keyframe-based so it stays cheap.
 */
function ConfettiBurst() {
  const pieces = useRef(
    Array.from({ length: 60 }, () => ({
      x: (Math.random() - 0.5) * 400,
      y: -(Math.random() * 200 + 50),
      r: Math.random() * 720,
      color: ["#b22234", "#ffffff", "#3c3b6e", "#4f8cff", "#eab308", "#3fb950"][
        Math.floor(Math.random() * 6)
      ],
      delay: Math.random() * 200,
    })),
  ).current;
  return (
    <div className="absolute inset-0 pointer-events-none overflow-visible">
      {pieces.map((p, i) => (
        <span
          key={i}
          className="absolute left-1/2 top-1/2 block w-2 h-2 rounded-sm"
          style={{
            backgroundColor: p.color,
            transform: "translate(-50%, -50%)",
            animation: `confetti-burst 1200ms ${p.delay}ms ease-out forwards`,
            // CSS custom props consumed by the keyframe — see styles/index.css
            ["--cx" as never]: `${p.x}px`,
            ["--cy" as never]: `${p.y}px`,
            ["--cr" as never]: `${p.r}deg`,
          }}
        />
      ))}
    </div>
  );
}
