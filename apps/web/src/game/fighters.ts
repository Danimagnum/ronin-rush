import { Container, Graphics } from 'pixi.js';

/**
 * Procedural placeholder fighters, drawn with vector shapes so the game ships with a 100%
 * original identity and zero third-party art. Each fighter exposes the same small rig
 * (body lean, crouch, sword-arm angle, x offset), so swapping in a sprite-sheet later only
 * means implementing this interface again.
 *
 * Local space: feet at (0, 0), 1 unit = fighter height, facing +x.
 */
export interface FighterRig {
  readonly root: Container;
  /** Rotates the sword arm around the shoulder, radians (0 = guard, negative = raised). */
  arm: Container;
  body: Container;
  setRage(level: number): void;
}

const INK = 0x0b111c;

export function createRonin(): FighterRig {
  const root = new Container();
  const body = new Container();
  root.addChild(body);

  // Hakama (wide pleated trousers), stance slightly open.
  const legs = new Graphics()
    .poly([-0.17, 0, -0.06, -0.42, 0.08, -0.42, 0.2, 0, 0.06, 0, 0.01, -0.22, -0.03, 0])
    .fill(0x2a3552);
  // Kimono torso with a pale collar line.
  const torso = new Graphics()
    .poly([-0.11, -0.42, -0.13, -0.74, 0.12, -0.76, 0.13, -0.42])
    .fill(0x3b4a6b)
    .moveTo(-0.07, -0.75)
    .lineTo(0.04, -0.5)
    .stroke({ width: 0.018, color: 0xe8e2d2, alpha: 0.85 })
    .rect(-0.13, -0.47, 0.26, 0.04)
    .fill(0x1b2236); // obi belt
  const head = new Graphics().circle(0.01, -0.82, 0.065).fill(0x1d2538);
  // Kasa: the wide straw hat is the silhouette everyone reads as "wandering swordsman".
  const hat = new Graphics()
    .poly([-0.24, -0.84, 0.0, -0.98, 0.25, -0.84, 0.0, -0.81])
    .fill(0xc8b07e)
    .moveTo(-0.24, -0.84)
    .lineTo(0.25, -0.84)
    .stroke({ width: 0.012, color: 0x8a7550 });
  body.addChild(legs, torso, head, hat);

  const arm = new Container();
  arm.position.set(0.07, -0.7);
  const armShape = new Graphics().roundRect(-0.03, -0.03, 0.2, 0.06, 0.03).fill(0x34425f);
  const katana = new Graphics()
    .rect(0.17, -0.012, 0.07, 0.024)
    .fill(0x1a1a1a) // grip
    .circle(0.245, 0, 0.022)
    .fill(0xd6af5c) // tsuba
    .poly([0.26, -0.01, 0.78, -0.03, 0.82, 0.0, 0.26, 0.012])
    .fill(0xdfe6ef);
  arm.addChild(armShape, katana);
  body.addChild(arm);

  return { root, body, arm, setRage: () => undefined };
}

export function createOni(): FighterRig {
  const root = new Container();
  const body = new Container();
  root.addChild(body);

  const legs = new Graphics()
    .poly([-0.2, 0, -0.08, -0.42, 0.1, -0.42, 0.22, 0, 0.08, 0, 0.01, -0.2, -0.06, 0])
    .fill(0x2b1b26);
  // Lacquered armour: a broad cuirass and squared shoulder plates.
  const torso = new Graphics()
    .poly([-0.15, -0.42, -0.17, -0.78, 0.17, -0.8, 0.16, -0.42])
    .fill(0x3d2230)
    .rect(-0.15, -0.6, 0.31, 0.025)
    .fill(0x5a3344)
    .rect(-0.15, -0.53, 0.31, 0.025)
    .fill(0x5a3344)
    .roundRect(-0.25, -0.8, 0.14, 0.12, 0.03)
    .fill(0x4a2838)
    .roundRect(0.11, -0.82, 0.14, 0.12, 0.03)
    .fill(0x4a2838);
  // Horned mask: an original oni-like menpo, not any existing character.
  const head = new Graphics()
    .roundRect(-0.07, -0.95, 0.15, 0.15, 0.04)
    .fill(0x241520)
    .poly([-0.06, -0.93, -0.12, -1.06, -0.03, -0.95])
    .fill(0xe8e2d2)
    .poly([0.06, -0.95, 0.13, -1.07, 0.04, -0.93])
    .fill(0xe8e2d2);
  const eyes = new Graphics().rect(-0.045, -0.9, 0.035, 0.014).fill(0xffffff).rect(0.02, -0.9, 0.035, 0.014).fill(0xffffff);
  body.addChild(legs, torso, head, eyes);

  const arm = new Container();
  arm.position.set(0.08, -0.72);
  const armShape = new Graphics().roundRect(-0.035, -0.035, 0.22, 0.07, 0.035).fill(0x4a2838);
  // Heavy nodachi: longer, darker blade.
  const blade = new Graphics()
    .rect(0.19, -0.015, 0.09, 0.03)
    .fill(INK)
    .rect(0.28, -0.03, 0.03, 0.06)
    .fill(0x8a6a3a)
    .poly([0.31, -0.014, 0.92, -0.04, 0.97, 0.0, 0.31, 0.016])
    .fill(0xb9c2cf);
  arm.addChild(armShape, blade);
  body.addChild(arm);

  return {
    root,
    body,
    arm,
    // Rage tints the eyes from moonlit white to gold to crimson.
    setRage: (level) => {
      eyes.tint = level < 0.33 ? 0xffffff : level < 0.66 ? 0xd6af5c : 0xff4a5e;
    },
  };
}
