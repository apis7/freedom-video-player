/**
 * Web Audio-based sine-tone player for the Beep snip action.
 *
 * Single global instance (a tone with a hyphen on top of a tone makes a
 * mess; we never want two beeps simultaneously). Lazy AudioContext init so
 * we don't allocate audio resources until the first beep — browsers also
 * require a user gesture before AudioContext.start works, and by the time
 * a snip fires the user has already clicked/pressed keys, so we're fine.
 *
 * Volume conversion: level in dB → linear gain via 10^(dB/20). Each beep
 * gets a brief linear fade-in / fade-out (~12ms) so the tone doesn't click
 * at the boundaries.
 */

const FADE_MS = 12;

class BeepPlayer {
  private ctx: AudioContext | null = null;
  private osc: OscillatorNode | null = null;
  private gain: GainNode | null = null;
  private currentFreq = 0;
  private currentLevelDb = 0;

  /** Start the beep (or update freq/level on an already-playing beep). */
  start(freqHz: number, levelDb: number): void {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
      } catch {
        return; // no audio support — silently degrade
      }
    }
    // Resume context if it was suspended (autoplay policy).
    if (this.ctx.state === "suspended") {
      void this.ctx.resume();
    }
    const targetGain = Math.pow(10, levelDb / 20);

    // Already playing? Just update freq/gain in place.
    if (this.osc && this.gain) {
      if (freqHz !== this.currentFreq) {
        this.osc.frequency.setTargetAtTime(
          freqHz,
          this.ctx.currentTime,
          0.01,
        );
        this.currentFreq = freqHz;
      }
      if (levelDb !== this.currentLevelDb) {
        this.gain.gain.setTargetAtTime(
          targetGain,
          this.ctx.currentTime,
          0.01,
        );
        this.currentLevelDb = levelDb;
      }
      return;
    }

    // Fresh start.
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freqHz;
    gain.gain.value = 0; // ramp in to avoid click
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start();
    const now = this.ctx.currentTime;
    gain.gain.linearRampToValueAtTime(targetGain, now + FADE_MS / 1000);

    this.osc = osc;
    this.gain = gain;
    this.currentFreq = freqHz;
    this.currentLevelDb = levelDb;
  }

  /** Stop the beep with a brief fade-out. Idempotent. */
  stop(): void {
    if (!this.osc || !this.gain || !this.ctx) return;
    const osc = this.osc;
    const gain = this.gain;
    const now = this.ctx.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, now + FADE_MS / 1000);
    // Stop the oscillator just after the fade completes so we don't cut
    // mid-fade. Disconnect to release the audio graph for GC.
    window.setTimeout(() => {
      try { osc.stop(); } catch {}
      try { osc.disconnect(); } catch {}
      try { gain.disconnect(); } catch {}
    }, FADE_MS + 5);
    this.osc = null;
    this.gain = null;
  }
}

export const beepPlayer = new BeepPlayer();
