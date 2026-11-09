import { formatX100 } from '@ronin/shared';

/** "3.41×" with a typographically smaller multiplication sign (the font's × is display-sized). */
export function Mult({ x100, className }: { x100: number; className?: string }) {
  return (
    <span className={`tabular whitespace-nowrap ${className ?? ''}`}>
      {formatX100(x100)}
      <span className="x-sign">×</span>
    </span>
  );
}
