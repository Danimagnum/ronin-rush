'use client';
import Link from 'next/link';
import { useState } from 'react';
import { mult, shortHash } from '@/lib/format';
import { useGame } from '@/lib/store';

function Copyable({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="tabular rounded px-1 text-left font-medium text-washi/90 hover:text-kin"
      aria-label={`Copy ${label}`}
      title={value}
    >
      {copied ? 'Copied' : shortHash(value)}
    </button>
  );
}

/** What makes this round checkable: its committed hash now, its seed when it ends. */
export function FairnessBar() {
  const round = useGame((s) => s.round);
  const last = useGame((s) => s.lastSettled);
  const fairness = useGame((s) => s.fairness);
  return (
    <section aria-label="Provably fair" className="grid gap-x-6 gap-y-2 text-sm text-mist sm:grid-cols-[auto_auto_1fr]">
      <div>
        Round {round ? `#${round.roundId}` : '—'} hash {round ? <Copyable value={round.seedHash} label="round hash" /> : '—'}
      </div>
      <div>
        Chain commitment {fairness ? <Copyable value={fairness.commitment} label="chain commitment" /> : '—'}
      </div>
      <div className="sm:text-right">
        {last ? (
          <Link href={`/verify?round=${last.roundId}&seed=${last.seed}`} className="text-kin underline-offset-4 hover:underline">
            Verify round #{last.roundId} ({mult(last.crashX100)})
          </Link>
        ) : (
          <Link href="/verify" className="text-kin underline-offset-4 hover:underline">
            How fairness works
          </Link>
        )}
      </div>
    </section>
  );
}
