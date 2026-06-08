import { useEffect } from "react";
import { useAppStore } from "../state/appStore";

interface AboutModalProps {
  onClose: () => void;
}

export function AboutModal({ onClose }: AboutModalProps) {
  const inc = useAppStore((s) => s.incrementOpenModalCount);
  const dec = useAppStore((s) => s.decrementOpenModalCount);

  useEffect(() => {
    inc();
    return () => dec();
  }, [inc, dec]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 bg-black/60 z-[55] flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="bg-fvp-surface border border-fvp-border rounded-lg shadow-2xl p-6 min-w-[420px] max-w-[520px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-4 mb-4">
          <img
            src="/icon_96px.png"
            alt=""
            width={64}
            height={64}
            style={{ width: 64, height: 64 }}
            draggable={false}
          />
          <div>
            <div className="text-lg font-semibold text-fvp-text">Freedom Video Player</div>
            <div className="text-xs text-fvp-muted">Version 0.1.0 — dev build</div>
          </div>
        </div>
        <p className="text-[12px] text-fvp-muted leading-relaxed mb-3">
          For family viewing, or your own use, for those who want to —
          shocking, I know! — watch and enjoy a movie, rather than
          interspersed porn or random unrealistic swearing.
        </p>
        <p className="text-[12px] text-fvp-muted leading-relaxed mb-3">
          And who doesn&apos;t enjoy an in-your-face preachy pro
          LGBTQUIA+XYZ tirade? YOU BIGOTED ANIMAL.
        </p>
        <p className="text-[12px] text-fvp-muted leading-relaxed mb-3">
          A cross-platform video player with profile-based filtering.
          Create or share <code className="font-mono">.free</code> profiles
          to automate a modified playback of your own video files without
          modifying them.
        </p>
        <p className="text-[11px] text-fvp-text/80 leading-relaxed mb-4 italic">
          Freedom Video Player. Helping you hit the &quot;skip&quot; button.
        </p>

        <div className="mt-4 pt-3 border-t border-fvp-border text-[11px] text-fvp-muted leading-relaxed mb-3">
          <div className="text-fvp-text font-semibold mb-1">OUR PHILOSOPHY</div>
          <p className="mb-2">
            This software is meant to assist parents or individuals who want
            to enjoy movies again. It is not meant to be a lockdown, as if
            one could (haha!) lock smart teenagers out of all bad things.
            There&apos;s no wall in the world high enough to keep smart
            determined children out of trouble; and FVP is no exception.
            However, good tools can help, if there&apos;s a solid foundation
            and relationship. As such, FVP is meant to be a tool that helps
            equip for enjoyment and education, not a surveillance or
            lockout tool.
          </p>
          <p className="italic">
            Proverbs 22:6: &quot;Train up a child in the way he should go;
            even when he is old, he will not depart from it.&quot; Enjoy
            the show.
          </p>
        </div>

        <div className="mt-4 pt-3 border-t border-fvp-border text-[11px] text-fvp-muted leading-relaxed">
          <div className="text-fvp-text font-semibold mb-1">
            MAPS — Media Audience Prudence Standard
          </div>
          <p>
            Crowdsourced by parents and viewers who want practical
            guidance, not manipulable checkboxes. Ratings come in two
            forms: with FVP filtering applied, and without. Each rating
            is a threshold tier (&quot;Family&quot;, &quot;Teen&quot;,
            &quot;Adult&quot;, &quot;Married Adult&quot;,
            &quot;Degrading&quot;) plus a short summary of what&apos;s
            actually objectionable — because &quot;PG-13 for thematic
            elements&quot; tells you nothing useful. Viewer-driven, not
            industry-driven.
          </p>
        </div>
        <div className="flex justify-end">
          <button
            onClick={onClose}
            className="px-3 py-1.5 bg-fvp-accent text-white rounded text-xs cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
