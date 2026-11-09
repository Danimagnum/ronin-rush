import { Application, Container, Graphics, Sprite, Texture, type Ticker } from 'pixi.js';
import { createOni, createRonin, type FighterRig } from './fighters';

/**
 * The duel. Purely a view: it never decides anything, it just renders what the round state
 * says. Every frame it asks `frame()` for the phase and the locally-computed multiplier
 * (derived from the server's startedAt and the synced clock) and maps that to intensity:
 *
 *   < 2.00x   steady exchange
 *   2–5x      the oni enrages: faster attacks, sparks, camera shake on parries
 *   ≥ 5.00x   frenzy: golden aura, slow-motion parries
 *   crash     final blow: dash, slash, white flash, the ronin falls
 */

export type ScenePhase = 'BETTING' | 'RUNNING' | 'CRASHED' | 'SETTLED' | 'IDLE';

export interface SceneFrame {
  phase: ScenePhase;
  roundId: number;
  multiplier: number;
}

export interface SceneHooks {
  onClash?: (intensity: number) => void;
  onFinalBlow?: () => void;
}

export interface SceneOptions {
  reducedMotion: boolean;
  lowPower: boolean;
}

type Quality = 'high' | 'low';

interface Spark {
  s: Sprite;
  vx: number;
  vy: number;
  life: number;
  max: number;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Exponential approach that behaves the same at 20 fps and 144 fps. `rate` = fraction per 60 Hz frame. */
const approach = (current: number, target: number, rate: number, dtMs: number) => lerp(current, target, 1 - (1 - rate) ** (dtMs / 16.67));
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
const easeOut = (t: number) => 1 - (1 - t) ** 3;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const mixColor = (a: number, b: number, t: number) => {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (Math.round(lerp(ar, br, t)) << 16) | (Math.round(lerp(ag, bg, t)) << 8) | Math.round(lerp(ab, bb, t));
};

/** 0 below 2x, ramps to 1 at 5x, frenzy flag above. */
export function intensityFor(multiplier: number): { rage: number; frenzy: boolean; tier: 0 | 1 | 2 } {
  const rage = clamp01((multiplier - 2) / 3);
  return { rage, frenzy: multiplier >= 5, tier: multiplier >= 5 ? 2 : multiplier >= 2 ? 1 : 0 };
}

export class FightScene {
  private readonly world = new Container();
  private readonly backdrop = new Container();
  private readonly bambooFar = new Container();
  private readonly bambooMid = new Container();
  private readonly ground = new Graphics();
  private readonly mist = new Container();
  private readonly fx = new Container();
  private readonly bambooNear = new Container();
  private readonly flash = new Graphics();
  private readonly vignette = new Graphics();
  private readonly ronin: FighterRig = createRonin();
  private readonly oni: FighterRig = createOni();
  private aura!: Sprite;
  private dot!: Texture;
  private glow!: Texture;
  private sparks: Spark[] = [];
  private fireflies: Array<{ s: Sprite; phase: number; speed: number; baseX: number; baseY: number }> = [];

  private w = 0;
  private h = 0;
  private time = 0;
  private timeScale = 1;
  private slowmoUntil = 0;
  private shake = 0;
  private exchangeT = 0;
  private attacker: 0 | 1 = 0;
  private clashedThisExchange = false;
  private crashRound = -1;
  private crashT = 0;
  private flashAlpha = 0;
  private quality: Quality;
  private fpsSamples: number[] = [];
  private lastDt = 16;
  private lastPhase: ScenePhase = 'IDLE';
  private fadeIn = 1;

  private constructor(
    private readonly app: Application,
    private readonly frame: () => SceneFrame,
    private readonly hooks: SceneHooks,
    private readonly opts: SceneOptions,
  ) {
    this.quality = opts.lowPower ? 'low' : 'high';
  }

  static async create(el: HTMLElement, frame: () => SceneFrame, hooks: SceneHooks, opts: SceneOptions): Promise<FightScene> {
    const app = new Application();
    await app.init({
      resizeTo: el,
      backgroundAlpha: 0,
      antialias: !opts.lowPower,
      resolution: Math.min(window.devicePixelRatio || 1, opts.lowPower ? 1.25 : 2),
      autoDensity: true,
      preference: 'webgl',
      powerPreference: opts.lowPower ? 'low-power' : 'high-performance',
    });
    app.canvas.setAttribute('aria-hidden', 'true');
    el.appendChild(app.canvas);
    const scene = new FightScene(app, frame, hooks, opts);
    scene.build();
    return scene;
  }

  destroy(): void {
    this.app.destroy({ removeView: true }, { children: true, texture: true });
  }

  // ── construction ─────────────────────────────────────────────────────────

  private build(): void {
    this.dot = this.app.renderer.generateTexture(new Graphics().circle(0, 0, 6).fill(0xffffff));
    const glowG = new Graphics();
    for (let i = 10; i > 0; i--) glowG.circle(0, 0, i * 12).fill({ color: 0xffffff, alpha: 0.05 });
    this.glow = this.app.renderer.generateTexture(glowG);

    this.world.addChild(this.backdrop, this.bambooFar, this.bambooMid, this.ground, this.mist, this.oni.root, this.ronin.root, this.fx, this.bambooNear);
    this.app.stage.addChild(this.world, this.vignette, this.flash);

    this.aura = new Sprite(this.glow);
    this.aura.anchor.set(0.5);
    this.aura.blendMode = 'add';
    this.aura.tint = 0xd6af5c;
    this.aura.alpha = 0;
    this.world.addChildAt(this.aura, this.world.getChildIndex(this.ronin.root));

    this.layout();
    this.app.renderer.on('resize', () => this.layout());
    this.app.ticker.add((t) => this.tick(t));
  }

  /** Rebuilds size-dependent geometry. Cheap enough to run on every resize. */
  private layout(): void {
    this.w = this.app.screen.width;
    this.h = this.app.screen.height;
    const { w, h } = this;
    const groundY = h * 0.8;

    // Sky as stacked bands: a gradient without shader cost.
    this.backdrop.removeChildren().forEach((c) => c.destroy());
    const sky = new Graphics();
    const bands = 14;
    for (let i = 0; i < bands; i++) {
      sky.rect(0, (groundY / bands) * i, w, groundY / bands + 1).fill(mixColor(0x090e1b, 0x1e2a44, i / (bands - 1)));
    }
    // Moon sits high in the right third, clear of the multiplier that owns the centre.
    const moonX = w * 0.82;
    const moonY = h * 0.19;
    const r = Math.min(w, h) * 0.075;
    const halo = new Graphics();
    for (let i = 8; i > 0; i--) halo.circle(moonX, moonY, r * (1 + i * 0.28)).fill({ color: 0xe8e2d2, alpha: 0.018 });
    const moon = new Graphics().circle(moonX, moonY, r).fill({ color: 0xe8e2d2, alpha: 0.92 }).circle(moonX - r * 0.3, moonY - r * 0.15, r * 0.18).fill({ color: 0xcfc7b3, alpha: 0.5 });
    this.backdrop.addChild(sky, halo, moon);

    this.drawBamboo(this.bambooFar, { count: this.quality === 'high' ? 26 : 14, color: 0x1b2b37, alpha: 0.75, minW: 4, maxW: 8, top: 0.05, groundY, leaves: false });
    this.drawBamboo(this.bambooMid, { count: this.quality === 'high' ? 14 : 8, color: 0x1f3a3c, alpha: 0.9, minW: 8, maxW: 14, top: 0, groundY, leaves: true, avoidCenter: true });
    this.drawBamboo(this.bambooNear, { count: 4, color: 0x070b13, alpha: 1, minW: 16, maxW: 24, top: -0.1, groundY: h, leaves: false, edgesOnly: true });

    this.ground.clear().rect(0, groundY, w, h - groundY).fill(0x0d1424).rect(0, groundY, w, 2).fill({ color: 0x3a4a6a, alpha: 0.8 });
    for (let i = 0; i < 6; i++) this.ground.rect(0, groundY + 8 + i * ((h - groundY) / 6), w, 1).fill({ color: 0x1a2438, alpha: 0.6 });

    this.mist.removeChildren().forEach((c) => c.destroy());
    for (let i = 0; i < 3; i++) {
      const m = new Graphics().ellipse(0, 0, w * 0.45, h * 0.035).fill({ color: 0x8b94aa, alpha: 0.05 });
      m.position.set((w / 3) * i, groundY - h * 0.01 + i * 6);
      this.mist.addChild(m);
    }

    this.vignette.clear();
    const edge = Math.max(w, h) * 0.18;
    for (let i = 0; i < 8; i++) {
      const inset = (edge / 8) * i;
      this.vignette.rect(inset, inset, w - inset * 2, h - inset * 2).stroke({ width: edge / 8, color: 0x05070d, alpha: 0.09 });
    }

    const scale = h * 0.36;
    this.ronin.root.scale.set(scale);
    this.oni.root.scale.set(-scale * 1.08, scale * 1.08); // mirrored: faces left
    this.ronin.root.y = groundY;
    this.oni.root.y = groundY;

    this.spawnFireflies();
  }

  private drawBamboo(
    layer: Container,
    o: { count: number; color: number; alpha: number; minW: number; maxW: number; top: number; groundY: number; leaves: boolean; avoidCenter?: boolean; edgesOnly?: boolean },
  ): void {
    layer.removeChildren().forEach((c) => c.destroy());
    const { w, h } = this;
    const g = new Graphics();
    let seed = o.count * 97 + Math.round(w);
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < o.count; i++) {
      let x = rand() * w;
      if (o.edgesOnly) x = i % 2 === 0 ? rand() * w * 0.12 : w - rand() * w * 0.12;
      if (o.avoidCenter && x > w * 0.28 && x < w * 0.72) x = x < w / 2 ? x - w * 0.25 : x + w * 0.25;
      const sw = lerp(o.minW, o.maxW, rand()) * (h / 600);
      const top = h * o.top + rand() * h * 0.1;
      g.rect(x, top, sw, o.groundY - top).fill({ color: o.color, alpha: o.alpha });
      for (let y = o.groundY - 40 - rand() * 30; y > top; y -= 50 + rand() * 40) {
        g.rect(x - 1, y, sw + 2, Math.max(2, sw * 0.18)).fill({ color: mixColor(o.color, 0x000000, 0.35), alpha: o.alpha });
        if (o.leaves && rand() < 0.4) {
          // A spray of 2-3 narrow blades hanging from the node.
          const dir = rand() < 0.5 ? -1 : 1;
          const ox = dir > 0 ? x + sw : x;
          const blades = 2 + Math.floor(rand() * 2);
          const len = Math.min(sw * 5, h * 0.06) * (0.8 + rand() * 0.5);
          for (let b = 0; b < blades; b++) {
            const a = (0.25 + b * 0.32 + rand() * 0.15) * dir;
            const tipX = ox + Math.cos(a) * len * dir * dir;
            const tipY = y + Math.abs(Math.sin(a)) * len + len * 0.15;
            const wdt = Math.max(1.5, len * 0.12);
            g.poly([ox, y, (ox + tipX) / 2, (y + tipY) / 2 - wdt, tipX, tipY, (ox + tipX) / 2, (y + tipY) / 2 + wdt * 0.4]).fill({ color: o.color, alpha: o.alpha * 0.9 });
          }
        }
      }
    }
    layer.addChild(g);
    layer.pivot.set(w / 2, o.groundY);
    layer.position.set(w / 2, o.groundY);
  }

  private spawnFireflies(): void {
    for (const f of this.fireflies) f.s.destroy();
    this.fireflies = [];
    const n = this.quality === 'high' ? 18 : 8;
    for (let i = 0; i < n; i++) {
      const s = new Sprite(this.dot);
      s.anchor.set(0.5);
      s.scale.set(0.35 + Math.random() * 0.3);
      s.tint = 0xd6af5c;
      s.blendMode = 'add';
      this.fx.addChild(s);
      this.fireflies.push({ s, phase: Math.random() * Math.PI * 2, speed: 0.3 + Math.random() * 0.6, baseX: Math.random() * this.w, baseY: this.h * (0.35 + Math.random() * 0.4) });
    }
  }

  // ── per frame ────────────────────────────────────────────────────────────

  private tick(ticker: Ticker): void {
    const realDt = Math.min(ticker.deltaMS, 50);
    this.adaptQuality(ticker.FPS);
    const now = performance.now();
    this.timeScale = now < this.slowmoUntil ? 0.3 : approach(this.timeScale, 1, 0.15, realDt);
    const dt = realDt * this.timeScale;
    this.time += dt / 1000;

    const f = this.frame();
    const { rage, frenzy, tier } = intensityFor(f.multiplier);
    const fighting = f.phase === 'RUNNING';
    const defeated = f.phase === 'CRASHED' || f.phase === 'SETTLED';

    // Ambient: bamboo sway, mist drift, fireflies.
    const sway = this.opts.reducedMotion ? 0 : 1;
    this.bambooFar.skew.x = Math.sin(this.time * 0.5) * 0.008 * sway;
    this.bambooMid.skew.x = Math.sin(this.time * 0.7 + 1) * 0.012 * sway;
    this.bambooNear.skew.x = Math.sin(this.time * 0.6 + 2) * 0.018 * sway;
    this.mist.children.forEach((m, i) => {
      m.x = ((m.x + realDt * 0.01 * (i + 1)) % (this.w * 1.4)) - this.w * 0.05;
    });
    for (const ff of this.fireflies) {
      ff.phase += (realDt / 1000) * ff.speed;
      ff.s.x = ff.baseX + Math.sin(ff.phase) * 30;
      ff.s.y = ff.baseY + Math.cos(ff.phase * 0.7) * 18;
      ff.s.alpha = 0.25 + 0.35 * Math.sin(ff.phase * 3) ** 2;
    }

    const groundY = this.h * 0.8;
    const center = this.w / 2;
    const restGap = Math.min(this.w * 0.17, this.h * 0.32);

    // New round after a defeat: cut to both fighters back in guard, fading in, instead of
    // sliding the fallen ronin and the oni through each other.
    if (f.phase === 'BETTING' && this.lastPhase !== 'BETTING') {
      this.ronin.root.position.x = center - restGap * 1.25;
      this.oni.root.position.x = center + restGap * 1.25;
      this.ronin.root.rotation = 0;
      this.ronin.arm.rotation = -0.35;
      this.oni.arm.rotation = -0.5;
      this.ronin.body.rotation = 0;
      this.oni.body.rotation = 0;
      this.fadeIn = this.lastPhase === 'IDLE' ? 1 : 0;
    }
    this.lastPhase = f.phase;
    this.fadeIn = Math.min(1, this.fadeIn + realDt / 450);
    const breathe = Math.sin(this.time * 2.2) * 0.012;

    if (defeated) {
      this.playDefeat(f, realDt, center, groundY);
    } else {
      this.crashT = 0;
      this.ronin.root.rotation = approach(this.ronin.root.rotation, 0, 0.2, realDt);
      this.ronin.root.alpha = approach(this.ronin.root.alpha, 1, 0.1, realDt);
      this.oni.setRage(fighting ? rage : 0);

      if (fighting) {
        this.animateExchange(dt, center, restGap, rage, frenzy, tier);
      } else {
        // Betting: ready stances, a wary half-step back and forth.
        const drift = Math.sin(this.time * 0.8) * this.w * 0.006;
        this.ronin.root.x = approach(this.ronin.root.x, center - restGap * 1.25 + drift, 0.08, realDt);
        this.oni.root.x = approach(this.oni.root.x, center + restGap * 1.25 - drift, 0.08, realDt);
        this.ronin.arm.rotation = approach(this.ronin.arm.rotation, -0.35, 0.1, realDt);
        this.oni.arm.rotation = approach(this.oni.arm.rotation, -0.5, 0.1, realDt);
        this.ronin.body.rotation = approach(this.ronin.body.rotation, 0, 0.1, realDt);
        this.oni.body.rotation = approach(this.oni.body.rotation, 0, 0.1, realDt);
      }
      this.ronin.body.scale.y = 1 + breathe;
      this.oni.body.scale.y = 1 - breathe;
    }

    // Aura in frenzy.
    const auraTarget = fighting && frenzy ? 0.55 + Math.sin(this.time * 6) * 0.15 : 0;
    this.aura.alpha = approach(this.aura.alpha, auraTarget, 0.08, realDt);
    this.aura.position.set(this.ronin.root.x, groundY - this.h * 0.2);
    this.aura.scale.set((this.h / 260) * (1 + Math.sin(this.time * 3) * 0.04));

    this.updateSparks(realDt);

    // Camera: shake decays; frenzy pushes in slightly.
    const zoom = fighting && frenzy && !this.opts.reducedMotion ? 1.045 : 1;
    this.world.scale.set(approach(this.world.scale.x, zoom, 0.04, realDt));
    this.world.pivot.set(center, groundY);
    this.world.position.set(center + (Math.random() - 0.5) * this.shake, groundY + (Math.random() - 0.5) * this.shake);
    this.shake *= 0.86 ** (realDt / 16.67);

    this.flashAlpha *= 0.9 ** (realDt / 16.67);
    this.flash.clear().rect(0, 0, this.w, this.h).fill({ color: defeated && this.crashT < 0.5 ? 0xffffff : 0xb4394a, alpha: this.flashAlpha });
    this.vignette.tint = fighting ? mixColor(0xffffff, 0xff6070, rage * 0.6) : 0xffffff;
    if (this.fadeIn < 1) {
      this.ronin.root.alpha = Math.min(this.ronin.root.alpha, this.fadeIn);
      this.oni.root.alpha = this.fadeIn;
    } else if (!defeated) this.oni.root.alpha = 1;
    this.lastDt = realDt;
  }

  private animateExchange(dt: number, center: number, restGap: number, rage: number, frenzy: boolean, tier: number): void {
    const duration = frenzy ? 560 : lerp(1150, 720, rage);
    this.exchangeT += dt / duration;
    if (this.exchangeT >= 1) {
      this.exchangeT -= 1;
      this.attacker = this.attacker === 0 ? 1 : 0;
      this.clashedThisExchange = false;
    }
    const t = this.exchangeT;
    // wind-up (0-.45), strike (.45-.6), recoil (.6-1)
    const windup = clamp01(t / 0.45);
    const strike = clamp01((t - 0.45) / 0.15);
    const recoil = clamp01((t - 0.6) / 0.4);
    const lunge = strike < 1 ? easeOut(strike) : 1 - easeInOut(recoil);
    const raise = t < 0.45 ? easeInOut(windup) : 1 - easeOut(strike);

    const atkIsRonin = this.attacker === 0;
    const gap = restGap * (1 - 0.62 * lunge);
    const aggression = 1 + rage * 0.6;
    this.ronin.root.x = center - gap * (atkIsRonin ? 0.85 : 1.15);
    this.oni.root.x = center + gap * (atkIsRonin ? 1.15 : 0.85 / aggression);

    const atk = atkIsRonin ? this.ronin : this.oni;
    const def = atkIsRonin ? this.oni : this.ronin;
    atk.arm.rotation = lerp(-0.3, -2.1, raise) + lunge * 0.9;
    def.arm.rotation = lerp(-0.4, -1.0, lunge);
    atk.body.rotation = lerp(-0.08, 0.12, lunge);
    def.body.rotation = lerp(0, -0.08, lunge);

    if (!this.clashedThisExchange && t >= 0.56) {
      this.clashedThisExchange = true;
      const contactX = (this.ronin.root.x + this.oni.root.x) / 2;
      const contactY = this.h * 0.8 - this.h * 0.36 * 0.72;
      const intensity = tier === 0 ? 0.35 : tier === 1 ? 0.6 + rage * 0.3 : 1;
      this.burst(contactX, contactY, tier === 0 ? 6 : tier === 1 ? 14 : 26, intensity);
      if (tier >= 1 && !this.opts.reducedMotion) this.shake = Math.max(this.shake, 4 + rage * 10 + (frenzy ? 6 : 0));
      if (frenzy && !this.opts.reducedMotion) this.slowmoUntil = performance.now() + 260;
      this.hooks.onClash?.(intensity);
    }
  }

  private playDefeat(f: SceneFrame, realDt: number, center: number, groundY: number): void {
    const freshCrash = this.crashRound !== f.roundId;
    if (freshCrash) {
      this.crashRound = f.roundId;
      // Only play the strike if we are watching it happen; late joiners see the aftermath.
      this.crashT = f.phase === 'CRASHED' ? 0 : 1;
      if (f.phase === 'CRASHED') {
        this.flashAlpha = this.opts.reducedMotion ? 0.35 : 0.9;
        this.shake = this.opts.reducedMotion ? 0 : 22;
        this.burst(this.ronin.root.x, groundY - this.h * 0.25, 40, 1);
        this.hooks.onFinalBlow?.();
      }
    }
    this.crashT = Math.min(1, this.crashT + realDt / 900);
    const dash = easeOut(clamp01(this.crashT / 0.18));
    const fall = easeInOut(clamp01((this.crashT - 0.15) / 0.6));
    // The oni dashes through to the ronin's far side; the ronin crumples.
    this.oni.root.x = approach(this.oni.root.x, center - this.w * 0.2 * dash - this.w * 0.02, 0.35, realDt);
    this.oni.arm.rotation = approach(this.oni.arm.rotation, 0.9, 0.3, realDt);
    this.oni.body.rotation = approach(this.oni.body.rotation, 0.15, 0.2, realDt);
    this.oni.setRage(1);
    this.ronin.root.x = approach(this.ronin.root.x, center + this.w * 0.02, 0.1, realDt);
    this.ronin.root.rotation = lerp(0, 1.35, fall);
    this.ronin.root.alpha = lerp(1, 0.75, fall);
    this.ronin.arm.rotation = approach(this.ronin.arm.rotation, 0.6, 0.1, realDt);
  }

  // ── particles ────────────────────────────────────────────────────────────

  private burst(x: number, y: number, count: number, intensity: number): void {
    const limit = this.quality === 'high' ? 220 : 70;
    const n = Math.min(count, Math.max(0, limit - this.sparks.length), this.opts.reducedMotion ? 6 : count);
    for (let i = 0; i < n; i++) {
      const s = new Sprite(this.dot);
      s.anchor.set(0.5);
      s.blendMode = 'add';
      s.tint = Math.random() < 0.3 ? 0xffffff : 0xd6af5c;
      s.scale.set(0.25 + Math.random() * 0.35);
      s.position.set(x, y);
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.6;
      const speed = (0.15 + Math.random() * 0.45) * (0.6 + intensity) * (this.h / 500);
      const max = 260 + Math.random() * 380;
      this.fx.addChild(s);
      this.sparks.push({ s, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life: max, max });
    }
  }

  private updateSparks(dt: number): void {
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const p = this.sparks[i]!;
      p.life -= dt;
      if (p.life <= 0) {
        p.s.destroy();
        this.sparks.splice(i, 1);
        continue;
      }
      p.vy += 0.0012 * dt * (this.h / 500);
      p.s.x += p.vx * dt;
      p.s.y += p.vy * dt;
      p.s.alpha = p.life / p.max;
      p.s.scale.x = p.s.scale.y * (1 + Math.abs(p.vx) * 4); // stretch along motion
    }
  }

  /** Degrades gracefully: if a device can't hold ~45 fps for 2 s, drop to the low-power scene. */
  private adaptQuality(fps: number): void {
    if (this.quality === 'low') return;
    this.fpsSamples.push(fps);
    if (this.fpsSamples.length < 120) return;
    const avg = this.fpsSamples.reduce((a, b) => a + b, 0) / this.fpsSamples.length;
    this.fpsSamples = [];
    if (avg < 45) {
      this.quality = 'low';
      this.layout();
    }
  }

  get stats() {
    return { fps: Math.round(this.app.ticker.FPS), quality: this.quality, sparks: this.sparks.length, dt: Math.round(this.lastDt) };
  }
}
