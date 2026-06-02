/**
 * Tracks when the user last performed manual navigation (arrow seek, Home/End,
 * marker jump, etc.). The apply engine uses this to suppress the auto-Skip
 * action briefly — otherwise an arrow press that lands inside a Skip snip is
 * instantly bounced back out, making it impossible to navigate near snips.
 */

let lastNavTime = 0;

export function markUserNavigation(): void {
  lastNavTime = performance.now();
}

export function recentlyNavigated(thresholdMs = 500): boolean {
  return performance.now() - lastNavTime < thresholdMs;
}
