import { Assets, Container, Rectangle, Sprite, Texture } from 'pixi.js';

/**
 * Sprite-sheet fighters (CC0 "Samurai" by Nastanliev, based on "Martial Hero" by LuizMelo —
 * see public/assets/fighters/CREDITS.md). Each sheet is a horizontal strip of 200×200 frames,
 * character facing right, feet at y = 122.
 *
 * Frames are stepped by the scene's own (time-scaled) clock rather than AnimatedSprite's ticker,
 * so slow-motion parries slow the animation too, and an attack can be stretched to land its
 * hit frame exactly on the clash instant.
 */
export type FighterAnim = 'idle' | 'run' | 'attack1' | 'attack2' | 'take-hit' | 'death';

const FRAME = 200;
const FEET_Y = 122;
/** Visible body height inside a frame (head to feet), used to size fighters on stage. */
export const BODY_PX = 52;
/** Frame at which the blade connects, per attack (0-based, out of 6). */
export const HIT_FRAME: Record<'attack1' | 'attack2', number> = { attack1: 3, attack2: 3 };

const FILES: Record<FighterAnim, string> = {
  idle: 'idle.png',
  run: 'run.png',
  attack1: 'attack1.png',
  attack2: 'attack2.png',
  'take-hit': 'take-hit.png',
  death: 'death.png',
};

export type FighterSheets = Record<FighterAnim, Texture[]>;

export async function loadFighterSheets(basePath: string): Promise<FighterSheets> {
  const entries = await Promise.all(
    (Object.keys(FILES) as FighterAnim[]).map(async (anim) => {
      const tex = await Assets.load<Texture>(`${basePath}/${FILES[anim]}`);
      tex.source.scaleMode = 'nearest'; // crisp pixels at any zoom
      const count = Math.round(tex.source.width / FRAME);
      const frames = Array.from(
        { length: count },
        (_, i) => new Texture({ source: tex.source, frame: new Rectangle(i * FRAME, 0, FRAME, FRAME) }),
      );
      return [anim, frames] as const;
    }),
  );
  return Object.fromEntries(entries) as FighterSheets;
}

interface PlayOptions {
  /** Total duration of the clip in ms (defaults to 100 ms per frame). */
  durationMs?: number;
  loop?: boolean;
  /** Freeze on the last frame instead of returning to idle. */
  hold?: boolean;
  /** Restart even if this clip is already playing. */
  restart?: boolean;
}

export class SpriteFighter {
  readonly root = new Container();
  readonly sprite: Sprite;
  private anim: FighterAnim = 'idle';
  private elapsed = 0;
  private duration = 800;
  private loop = true;
  private hold = false;

  constructor(
    private readonly sheets: FighterSheets,
    readonly facing: 1 | -1,
  ) {
    this.sprite = new Sprite(sheets.idle[0]);
    this.sprite.anchor.set(0.5, FEET_Y / FRAME);
    this.root.addChild(this.sprite);
    this.play('idle', { loop: true, durationMs: 900 });
  }

  /** A raw frame of one of this fighter's clips (used for the cut-in close-up). */
  frameOf(anim: FighterAnim, index: number): Texture {
    const frames = this.sheets[anim];
    return frames[Math.min(index, frames.length - 1)]!;
  }

  get current(): FighterAnim {
    return this.anim;
  }

  /** Normalised progress of the current clip, 0..1. */
  get progress(): number {
    return Math.min(1, this.elapsed / this.duration);
  }

  play(anim: FighterAnim, opts: PlayOptions = {}): void {
    if (anim === this.anim && !opts.restart && this.loop === (opts.loop ?? false)) return;
    this.anim = anim;
    this.elapsed = 0;
    this.duration = opts.durationMs ?? this.sheets[anim].length * 100;
    this.loop = opts.loop ?? false;
    this.hold = opts.hold ?? false;
    this.applyFrame();
  }

  /** Advance by scene time (already slowed down during slow-motion). */
  update(dtMs: number): void {
    this.elapsed += dtMs;
    if (this.elapsed >= this.duration) {
      if (this.loop) this.elapsed %= this.duration;
      else if (this.hold) this.elapsed = this.duration;
      else {
        this.play('idle', { loop: true, durationMs: 900 });
        return;
      }
    }
    this.applyFrame();
  }

  setScale(px: number): void {
    this.root.scale.set(px * this.facing, px);
  }

  private applyFrame(): void {
    const frames = this.sheets[this.anim];
    const i = Math.min(frames.length - 1, Math.floor((this.elapsed / this.duration) * frames.length));
    this.sprite.texture = frames[i]!;
  }
}
