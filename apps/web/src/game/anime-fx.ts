import { Container, Graphics, Sprite, type Texture } from 'pixi.js';

/**
 * Anime screen language layered over the duel:
 *  - speed lines: radial streaks converging on a clash, redrawn every few frames so they flicker
 *  - impact frame: an inverted still (white field, black silhouettes) on the final blow
 *  - slash: a tapered white cut across the whole screen
 *  - cut-in: a slanted band with an extreme close-up of the ronin when the frenzy begins
 *
 * Everything here is purely presentational and screen-space; the scene decides when to fire.
 */
export class AnimeFx {
  /** Screen-space layers, added by the scene above the world. */
  readonly speedLines = new Graphics();
  readonly slash = new Graphics();
  readonly cutIn = new Container();
  /** World-space white field shown behind the fighters during an impact frame. */
  readonly impactField = new Graphics();

  private speedMs = 0;
  private speedTotal = 1;
  private speedX = 0;
  private speedY = 0;
  private speedTint = 0xffffff;
  private speedDensity = 0;
  private speedRedraw = 0;

  private impactMs = 0;
  private slashMs = 0;
  private slashTotal = 1;

  private cutMs = -1;
  private readonly cutBand = new Graphics();
  private readonly cutEdge = new Graphics();
  private readonly cutMask = new Graphics();
  /** Face + streaks, clipped to the band by a single mask. */
  private readonly cutContent = new Container();
  private readonly cutStreaks = new Graphics();
  private readonly cutFace: Sprite;

  private w = 0;
  private h = 0;

  constructor(roninFace: Texture) {
    this.cutFace = new Sprite(roninFace);
    this.cutFace.anchor.set(0.5);
    this.cutContent.addChild(this.cutStreaks, this.cutFace);
    this.cutIn.addChild(this.cutBand, this.cutContent, this.cutEdge, this.cutMask);
    this.cutContent.mask = this.cutMask;
    this.cutIn.visible = false;
    this.impactField.visible = false;
  }

  get impactActive(): boolean {
    return this.impactMs > 0;
  }

  resize(w: number, h: number): void {
    this.w = w;
    this.h = h;
    // Oversized so camera shake/zoom never reveals its edges.
    this.impactField.clear().rect(-w, -h, w * 3, h * 3).fill(0xf4efe2);
  }

  /** Radial streaks converging on (x, y) in screen space. */
  speedLinesAt(x: number, y: number, intensity: number, ms: number, tint = 0xffffff): void {
    this.speedX = x;
    this.speedY = y;
    this.speedMs = this.speedTotal = ms;
    this.speedDensity = Math.max(this.speedDensity, intensity);
    this.speedTint = tint;
    this.speedRedraw = 0;
  }

  impact(ms: number): void {
    this.impactMs = ms;
  }

  slashAcross(ms: number): void {
    this.slashMs = this.slashTotal = ms;
  }

  /** Close-up band; `face` is a frame of the ronin sheet, zoomed until only the hat and eyes fit. */
  showCutIn(face: Texture): void {
    this.cutFace.texture = face;
    this.cutMs = 0;
    this.cutIn.visible = true;
  }

  update(realDt: number): void {
    this.updateSpeedLines(realDt);
    this.updateSlash(realDt);
    this.updateCutIn(realDt);
    if (this.impactMs > 0) this.impactMs = Math.max(0, this.impactMs - realDt);
    this.impactField.visible = this.impactMs > 0;
  }

  private updateSpeedLines(dt: number): void {
    const g = this.speedLines;
    if (this.speedMs <= 0) {
      if (this.speedDensity) g.clear();
      this.speedDensity = 0;
      return;
    }
    this.speedMs -= dt;
    this.speedRedraw -= dt;
    if (this.speedRedraw > 0) return;
    this.speedRedraw = 45; // re-roll the pattern ~22 times a second: the flicker sells it
    const fade = Math.max(0, this.speedMs / this.speedTotal);
    const { w, h } = this;
    const reach = Math.hypot(w, h);
    const inner = Math.min(w, h) * (0.24 + 0.1 * (1 - this.speedDensity)); // keep the fighters readable
    const count = Math.round(24 + 46 * this.speedDensity);
    g.clear();
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const spread = (0.004 + Math.random() * 0.012) * (0.6 + this.speedDensity);
      const r0 = inner + Math.random() * inner * 0.9;
      const cx = this.speedX;
      const cy = this.speedY;
      g.poly([
        cx + Math.cos(a) * r0,
        cy + Math.sin(a) * r0,
        cx + Math.cos(a - spread) * reach,
        cy + Math.sin(a - spread) * reach,
        cx + Math.cos(a + spread) * reach,
        cy + Math.sin(a + spread) * reach,
      ]).fill({ color: this.speedTint, alpha: (0.2 + Math.random() * 0.3) * fade });
    }
  }

  private updateSlash(dt: number): void {
    const g = this.slash;
    if (this.slashMs <= 0) {
      g.clear();
      return;
    }
    this.slashMs -= dt;
    const p = 1 - Math.max(0, this.slashMs / this.slashTotal); // 0 → 1
    const { w, h } = this;
    // The cut draws itself in the first 25%, then thins out.
    const draw = Math.min(1, p / 0.25);
    const thick = h * 0.05 * (1 - Math.max(0, (p - 0.25) / 0.75));
    const x0 = -w * 0.05;
    const y0 = h * 0.86;
    const x1 = x0 + (w * 1.1) * draw;
    const y1 = y0 - h * 0.62 * draw;
    const nx = (y0 - y1) / Math.hypot(x1 - x0, y1 - y0 || 1);
    const ny = (x1 - x0) / Math.hypot(x1 - x0, y1 - y0 || 1);
    g.clear()
      .poly([x0, y0, (x0 + x1) / 2 + nx * thick, (y0 + y1) / 2 + ny * thick, x1, y1, (x0 + x1) / 2 - nx * thick * 0.35, (y0 + y1) / 2 - ny * thick * 0.35])
      .fill({ color: 0xffffff, alpha: 0.95 })
      .poly([x0, y0, (x0 + x1) / 2 + nx * thick * 0.25, (y0 + y1) / 2 + ny * thick * 0.25, x1, y1])
      .fill({ color: 0xb4394a, alpha: 0.9 });
  }

  private updateCutIn(dt: number): void {
    if (this.cutMs < 0) return;
    this.cutMs += dt;
    const IN = 160;
    const HOLD = 720;
    const OUT = 180;
    const t = this.cutMs;
    if (t > IN + HOLD + OUT) {
      this.cutMs = -1;
      this.cutIn.visible = false;
      return;
    }
    const { w, h } = this;
    // Slide in from the left, hold, slide out to the right.
    const ease = (x: number) => 1 - (1 - x) ** 3;
    const offset = t < IN ? -w * (1 - ease(t / IN)) : t > IN + HOLD ? w * ease((t - IN - HOLD) / OUT) : 0;
    const bandH = h * 0.24;
    const cy = h * 0.6;
    const skew = bandH * 0.45;
    const band = [offset - skew, cy + bandH / 2, offset + w + skew, cy + bandH / 2 - skew, offset + w + skew, cy - bandH / 2 - skew, offset - skew, cy - bandH / 2];
    // Ink black, so the band reads as a cut-away panel against the night sky.
    this.cutBand.clear().poly(band).fill({ color: 0x030408, alpha: 1 });
    this.cutEdge.clear().poly(band).stroke({ width: Math.max(2, h * 0.006), color: 0xd6af5c });
    this.cutMask.clear().poly(band).fill(0xffffff);
    // Horizontal streaks racing behind the face.
    this.cutStreaks.clear();
    for (let i = 0; i < 14; i++) {
      const y = cy - bandH / 2 + Math.random() * bandH;
      const x = offset + Math.random() * w;
      this.cutStreaks.rect(x, y, w * (0.08 + Math.random() * 0.2), Math.max(1, h * 0.003)).fill({ color: 0xd6af5c, alpha: 0.35 });
    }
    // In the 200px frame the hat starts at y≈70 and the eyes sit near y≈80: centre the eyes in
    // the band (nudged to frame the scarf too) and zoom until hat and face fill it — an extreme close-up.
    const zoom = bandH / 22;
    this.cutFace.scale.set(zoom);
    this.cutFace.position.set(offset + w * 0.5, cy + (100 - 86) * zoom);
  }
}
