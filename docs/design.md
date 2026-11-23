# Visual identity

The duel is a painted scroll; the controls are objects from the dojo. Every piece of UI is
there because the game needs it, and each one is shaped like the thing it stands for.

| Game need | UI object |
| --- | --- |
| The fight | A scroll (kakemono): hinoki rods and brass caps frame the scene. |
| Betting window | An incense stick that burns down with a live ember, next to the number. |
| The multiplier | The only large element. Colour and a woodblock "misregistration" offset mark the tier: steady, enraged (crimson offset), frenzy (gold with ember flicker), defeated (crimson). |
| Stake | A strip of washi paper written in ink. |
| Chips | Gold *koban* coins that add to the stake. |
| The action | One button. Paper while betting; gold, with the live payout and a beating ring, while a cash-out is possible. |
| Result | A *hanko* stamp pressed on the scene ("Defeated"), plus a slip for your own bet (gold if you got out, crimson if not). |
| Players | A roll of names. A cut runs through the row: gold if they escaped, crimson if they did not. |
| History | A tally of cuts. Length is the multiplier on a log scale; colour is the tier. |
| Rest | The break reminder and the Rest section of the menu pause new bets on this device only. Rounds are shared and server-timed, so there is no pause; a bet already placed still settles. |

## Rules

- One cut-corner shape (top-left and bottom-right, like a katana tip). Round shapes are only coins and the sun.
- Colour has one meaning each: gold is money, bamboo is in play, crimson is defeat, paper is a calm action.
- No gradients, glass or card grids. Depth comes from hard offsets and rods, not blur.
- Icons are one hand-drawn 24-unit family with square caps (`components/icons.tsx`).
- Phones: the action button is stuck to the bottom edge in the thumb zone; the menu and settings are a bottom sheet.
- The cash-out button never moves its box (only brightness and an inner ring animate), so it stays easy to hit and to test.
- Settings: sound, reduced effects (on top of the automatic low-power check), system view, and rest.
- `prefers-reduced-motion` is honoured globally; focus rings are drawn inside cut shapes so they are never clipped.

Fonts are the ones already in the project (Shippori Mincho B1 for display, Zen Kaku Gothic New for UI).
The kanji 浪 on the seal is original to this project; the fighters are the CC0 sprites credited in
`apps/web/public/assets/fighters/CREDITS.md`.
