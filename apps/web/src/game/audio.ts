/**
 * Synthesised sound (Web Audio, no asset files): a metallic clash per parry, a taiko-like
 * pulse whose tempo follows the duel's intensity, and a gong for the final blow.
 * Off by default; the context is created on the first user toggle (autoplay policies).
 */
export class DuelAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private drumTimer: ReturnType<typeof setTimeout> | null = null;
  private tier = -1;
  enabled = false;

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (on) {
      if (!this.ctx) this.init();
      void this.ctx!.resume();
      this.master!.gain.setTargetAtTime(0.5, this.ctx!.currentTime, 0.05);
    } else if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
    }
  }

  private init(): void {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(this.ctx.destination);
    this.noise = this.ctx.createBuffer(1, this.ctx.sampleRate * 0.4, this.ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }

  clash(intensity: number): void {
    const { ctx, master } = this;
    if (!this.enabled || !ctx || !master) return;
    const t = ctx.currentTime;
    // Steel ring: two detuned high partials with a fast decay.
    for (const [freq, gain] of [
      [2350, 0.12],
      [3410, 0.07],
    ] as const) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'triangle';
      o.frequency.value = freq * (0.98 + Math.random() * 0.04);
      g.gain.setValueAtTime(gain * (0.6 + intensity * 0.6), t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35 + intensity * 0.3);
      o.connect(g).connect(master);
      o.start(t);
      o.stop(t + 0.8);
    }
    // Impact transient.
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 3000;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.25 * intensity, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    n.connect(bp).connect(ng).connect(master);
    n.start(t);
  }

  finalBlow(): void {
    const { ctx, master } = this;
    if (!this.enabled || !ctx || !master) return;
    const t = ctx.currentTime;
    // Gong: inharmonic partials, long tail.
    for (const [freq, gain, len] of [
      [98, 0.35, 3.2],
      [161, 0.18, 2.6],
      [233, 0.12, 2.0],
      [347, 0.06, 1.4],
    ] as const) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(freq * 1.03, t);
      o.frequency.exponentialRampToValueAtTime(freq, t + 0.4);
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      o.connect(g).connect(master);
      o.start(t);
      o.stop(t + len);
    }
    this.setTier(-1);
  }

  /** 0 steady, 1 enraged, 2 frenzy; -1 silence. Changes tempo of the pulse. */
  setTier(tier: number): void {
    if (tier === this.tier) return;
    this.tier = tier;
    if (this.drumTimer) clearTimeout(this.drumTimer);
    this.drumTimer = null;
    if (tier < 0) return;
    const interval = [620, 420, 260][tier]!;
    const beat = (n: number) => {
      this.drum(n % 4 === 0 ? 1 : 0.55, tier);
      this.drumTimer = setTimeout(() => beat(n + 1), interval);
    };
    beat(0);
  }

  private drum(accent: number, tier: number): void {
    const { ctx, master } = this;
    if (!this.enabled || !ctx || !master) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(120 + tier * 10, t);
    o.frequency.exponentialRampToValueAtTime(48, t + 0.25);
    g.gain.setValueAtTime(0.32 * accent, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + 0.4);
  }

  dispose(): void {
    this.setTier(-1);
    void this.ctx?.close();
    this.ctx = null;
  }
}
