'use client';
import { crashPointFromHmac, formatX100, hmacSha256Hex, isChainLink, isSeedHex, sha256Hex, verifyRound, type SettledRoundSummary } from '@ronin/shared';
import { useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Mult } from '@/components/Mult';
import { api, type Fairness } from '@/lib/api';
import { shortHash } from '@/lib/format';

interface Result {
  crashX100: number;
  hmac: string;
  h: string;
  u: number;
  roundNumber: number | null;
  linked: boolean | null;
  stepsTried: number;
}

/** Everything here runs in your browser with the same @ronin/shared code the server uses. */
export function VerifyClient() {
  const params = useSearchParams();
  const [fairness, setFairness] = useState<Fairness | null>(null);
  const [seed, setSeed] = useState(params.get('seed') ?? '');
  const [salt, setSalt] = useState('');
  const [commitment, setCommitment] = useState('');
  const [previous, setPrevious] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    api
      .fairness()
      .then((f) => {
        setFairness(f);
        setSalt((s) => s || f.publicSalt);
        setCommitment((c) => c || f.commitment);
      })
      .catch(() => setError('Could not load the published chain from the server. You can still paste the values by hand.'));
  }, []);

  const run = () => {
    setError(null);
    setResult(null);
    const s = seed.trim().toLowerCase();
    if (!isSeedHex(s)) return setError('A seed is 64 hexadecimal characters (0-9, a-f).');
    if (!salt) return setError('Enter the public salt published with the chain.');
    setChecking(true);
    // Let the "Checking" state paint before walking up to `chainLength` hashes.
    setTimeout(() => {
      const maxSteps = fairness?.chainLength ?? 100_000;
      const r = verifyRound({
        seed: s,
        publicSalt: salt,
        ...(commitment ? { commitment } : {}),
        ...(previous ? { previousSeed: previous } : {}),
        maxSteps,
      });
      const h = BigInt('0x' + r.h);
      setResult({ crashX100: r.crashX100, hmac: r.hmac, h: r.h, u: Number(h) / 2 ** 52, roundNumber: r.roundNumber, linked: r.linkedToPrevious, stepsTried: maxSteps });
      setChecking(false);
    }, 30);
  };

  useEffect(() => {
    if (params.get('seed') && salt && commitment && !result && !checking) run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [salt, commitment]);

  return (
    <div className="mx-auto grid max-w-5xl gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <section className="max-w-prose">
        <h1 className="font-display text-4xl font-extrabold">Verify a round</h1>
        <p className="mt-4 leading-relaxed text-washi/85">
          Every crash point was fixed before the round started. Before launch the server generated a chain of secret seeds, each one the
          SHA-256 of the next, and published only the hash of the first. Each round uses the next seed in that chain and reveals it when
          the round ends.
        </p>
        <p className="mt-3 leading-relaxed text-washi/85">
          From a revealed seed you can recompute the crash point and prove the seed belongs to the published chain. Nobody, including
          the operator, can pick a seed after the fact or know the next one in advance.
        </p>
        <ol className="mt-6 grid gap-3 text-sm leading-relaxed text-washi/85">
          <li>
            <span className="text-kin">1.</span> HMAC-SHA256 with the seed as key and the public salt as message.
          </li>
          <li>
            <span className="text-kin">2.</span> Take the first 52 bits as a number <i>h</i>, and <i>U</i> = <i>h</i> / 2<sup>52</sup>.
          </li>
          <li>
            <span className="text-kin">3.</span> Crash point = max(1.00, floor(99 / (1 − <i>U</i>)) / 100). The 99 is the 1% house edge:
            P(crash ≥ <i>x</i>) = 0.99 / <i>x</i>.
          </li>
          <li>
            <span className="text-kin">4.</span> Hash the seed repeatedly: after <i>r</i> hashes you must land on the published commitment,
            which proves this is round <i>r</i> of the chain.
          </li>
        </ol>
      </section>

      <section aria-label="Verifier" className="rounded-[var(--radius-panel)] bg-ai-800 p-5 sm:p-6">
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            run();
          }}
        >
          <Field label="Round seed (revealed after the round)" value={seed} onChange={setSeed} placeholder="64 hex characters" mono />
          <Field label="Public salt" value={salt} onChange={setSalt} />
          <Field label="Chain commitment" value={commitment} onChange={setCommitment} mono />
          <Field label="Previous round's seed (optional)" value={previous} onChange={setPrevious} mono />
          <button type="submit" disabled={checking} className="rounded-xl bg-kin py-3 font-display text-lg font-extrabold text-ai-950 hover:bg-[#e2bf72] disabled:opacity-60">
            {checking ? 'Checking…' : 'Verify'}
          </button>
        </form>
        {error ? (
          <p role="alert" className="mt-4 text-sm text-[#e8909c]">
            {error}
          </p>
        ) : null}
        {result ? <ResultView r={result} /> : null}
      </section>

      <RecentRounds rounds={fairness?.recentRounds ?? []} salt={fairness?.publicSalt ?? ''} onPick={(s) => setSeed(s)} />
    </div>
  );
}

function Field({ label, value, onChange, placeholder, mono }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean }) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="text-mist">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        className={`rounded-lg bg-ai-950 px-3 py-2 text-washi ring-1 ring-ai-600 outline-none focus:ring-kin ${mono ? 'tabular text-[13px] tracking-tight' : ''}`}
      />
    </label>
  );
}

function ResultView({ r }: { r: Result }) {
  return (
    <div className="mt-6 border-t border-ai-700 pt-5" aria-live="polite">
      <div className="flex items-baseline justify-between">
        <span className="text-mist">Crash point</span>
        <Mult x100={r.crashX100} className="font-display text-4xl font-extrabold text-kin" />
      </div>
      <dl className="mt-4 grid gap-2 text-sm">
        <Row k="HMAC-SHA256" v={shortHash(r.hmac, 20)} />
        <Row k="h (first 52 bits)" v={`0x${r.h} = ${BigInt('0x' + r.h).toString()}`} />
        <Row k="U = h / 2^52" v={r.u.toFixed(12)} />
        <Row k="floor(99 / (1 − U)) / 100" v={formatX100(r.crashX100)} />
        <Row
          k="Chain"
          v={r.roundNumber !== null ? `reaches the commitment after ${r.roundNumber} hashes: round #${r.roundNumber}` : `not found within ${r.stepsTried.toLocaleString('en')} hashes`}
          ok={r.roundNumber !== null}
        />
        {r.linked !== null ? <Row k="Link to previous seed" v={r.linked ? 'SHA-256(seed) equals the previous seed' : 'does not match the previous seed'} ok={r.linked} /> : null}
      </dl>
    </div>
  );
}

function Row({ k, v, ok }: { k: string; v: string; ok?: boolean }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[180px_1fr] sm:gap-3">
      <dt className="text-mist">{k}</dt>
      <dd className={`tabular break-all ${ok === undefined ? 'text-washi' : ok ? 'text-take' : 'text-[#e8909c]'}`}>{v}</dd>
    </div>
  );
}

/** The last rounds, each re-verified on the spot: crash recomputed and linked to its predecessor. */
function RecentRounds({ rounds, salt, onPick }: { rounds: SettledRoundSummary[]; salt: string; onPick: (seed: string) => void }) {
  const checked = useMemo(
    () =>
      salt
        ? rounds.map((r, i) => {
            const crashOk = crashPointFromHmac(hmacSha256Hex(r.seed, salt)).crashX100 === r.crashX100;
            const hashOk = sha256Hex(r.seed) === r.seedHash;
            const prev = rounds[i + 1];
            const linkOk = prev && prev.roundId === r.roundId - 1 ? isChainLink(r.seed, prev.seed) : null;
            return { ...r, ok: crashOk && hashOk && linkOk !== false };
          })
        : [],
    [rounds, salt],
  );
  if (!checked.length) return null;
  return (
    <section aria-label="Recent rounds, verified in your browser" className="lg:col-span-2">
      <h2 className="font-display text-2xl font-semibold">Recent rounds</h2>
      <p className="mt-1 text-sm text-mist">Recomputed here just now. Each seed hashes to the one before it.</p>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[560px] text-left text-sm">
          <thead className="text-mist">
            <tr className="border-b border-ai-700">
              <th className="py-2 pr-4 font-normal">Round</th>
              <th className="py-2 pr-4 font-normal">Crash</th>
              <th className="py-2 pr-4 font-normal">Seed</th>
              <th className="py-2 font-normal">Check</th>
            </tr>
          </thead>
          <tbody>
            {checked.map((r) => (
              <tr key={r.roundId} className="border-b border-ai-700/60">
                <td className="tabular py-2 pr-4">#{r.roundId}</td>
                <td className="py-2 pr-4">
                  <Mult x100={r.crashX100} />
                </td>
                <td className="py-2 pr-4">
                  <button type="button" onClick={() => onPick(r.seed)} className="tabular text-washi/85 hover:text-kin" title="Use this seed">
                    {shortHash(r.seed, 16)}
                  </button>
                </td>
                <td className={`py-2 ${r.ok ? 'text-take' : 'text-[#e8909c]'}`}>{r.ok ? 'Matches' : 'Mismatch'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
