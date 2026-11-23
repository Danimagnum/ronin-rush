'use client';
import Link from 'next/link';
import { useState } from 'react';
import { CheckIcon, CopyIcon } from './icons';
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
      className="tabular inline-flex min-h-8 items-center gap-1 px-1 text-left font-medium text-washi hover:text-kin"
      aria-label={`Copy ${label}`}
      title={value}
    >
      {copied ? <><CheckIcon /> Copied</> : <>{shortHash(value)} <CopyIcon className="text-xs opacity-60" /></>}
    </button>
  );
}

/** What makes this round checkable: its committed hash now, its seed when it ends. */
export function FairnessBar() {
  const round = useGame((s) => s.round);
  const last = useGame((s) => s.lastSettled);
  const fairness = useGame((s) => s.fairness);
  return (
    <section aria-label="Provably fair" className="grid gap-x-6 gap-y-2 border-t-4 border-hinoki pt-2 text-sm text-washi/75 sm:grid-cols-[auto_auto_1fr]">
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
