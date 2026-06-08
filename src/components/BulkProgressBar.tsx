import { useAppStore } from "../state/appStore";

export function BulkProgressBar() {
  const progress = useAppStore((s) => s.bulkProgress);
  if (!progress) return null;
  const pct =
    progress.total > 0
      ? Math.min(100, Math.round((progress.completed / progress.total) * 100))
      : 0;
  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[55] min-w-[320px] max-w-[600px] bg-fvp-surface border border-fvp-border rounded shadow-2xl px-4 py-2.5 text-sm text-fvp-text">
      <div className="flex justify-between items-center mb-1.5">
        <span className="font-medium">{progress.label}</span>
        <span className="text-fvp-muted tabular-nums text-xs">
          {progress.completed} / {progress.total}
        </span>
      </div>
      <div className="h-1.5 bg-fvp-surface2 rounded overflow-hidden">
        <div
          className="h-full bg-fvp-accent rounded transition-[width] duration-150"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
