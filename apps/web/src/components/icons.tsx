import type { SVGProps } from 'react';

/**
 * One small icon family for the whole game: 24-unit grid, 2-unit square-cap strokes, so every
 * glyph looks cut with the same brush. Decorative by default (aria-hidden); the button that holds
 * the icon carries the accessible name.
 */
function Icon({ children, ...p }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      focusable="false"
      {...p}
    >
      {children}
    </svg>
  );
}

export const MenuIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M4 7h16M4 12h12M4 17h16" />
  </Icon>
);
export const CloseIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
);
export const SoundOnIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M4 9v6h4l5 4V5L8 9H4z" />
    <path d="M17 9c1.5 1.5 1.5 4.5 0 6M19.5 6.5c3 3 3 8 0 11" />
  </Icon>
);
export const SoundOffIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M4 9v6h4l5 4V5L8 9H4z" />
    <path d="M17 9l5 6M22 9l-5 6" />
  </Icon>
);
export const ClockIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M12 3a9 9 0 100 18 9 9 0 000-18z" />
    <path d="M12 7v5l3 2" />
  </Icon>
);
export const CopyIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M8 8h11v12H8zM5 16V4h11" />
  </Icon>
);
export const CheckIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M4 12l5 5L20 6" />
  </Icon>
);
export const BladeIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M20 4L9 15M9 15l-2 2M7 17l-3 3M12 12l-2.5-2.5M6.5 13.5l4 4" />
  </Icon>
);
export const ScrollIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M5 4h14v16H5zM5 8h14M5 16h14M9 12h6" />
  </Icon>
);
export const PulseIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M3 12h4l3-7 4 14 3-7h4" />
  </Icon>
);
export const LeafIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M5 19C5 10 10 5 20 4c0 10-5 15-14 15zM5 19l8-8" />
  </Icon>
);

/** Rough-edged ink: the SVG filter that makes a hanko stamp look pressed, not drawn. Rendered once. */
export function InkFilters() {
  return (
    <svg width="0" height="0" aria-hidden="true" focusable="false" style={{ position: 'absolute' }}>
      <filter id="ink-rough" x="-5%" y="-5%" width="110%" height="110%">
        <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" result="n" />
        <feDisplacementMap in="SourceGraphic" in2="n" scale="3.2" xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </svg>
  );
}
