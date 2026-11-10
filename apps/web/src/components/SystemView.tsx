'use client';
import type { FightScene } from '@/game/scene';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { clock } from '@/lib/clock';
import { money } from '@/lib/format';
import { commands } from '@/lib/realtime';
import { useGame } from '@/lib/store';

/**
 * Engineering view of the running system, for the people evaluating it: who owns the clock and
 * how far you are from it, which instance leads, how fast commands and events flow, and proof
 * that the ledger balances. Data is pushed by the leader once a second, only while this is open.
 */
export function SystemView() {
  const m = useGame((s) => s.system);
  const history = useGame((s) => s.betsHistory);
  const offset = useGame((s) => s.offsetMs);
  const latency = useGame((s) => s.latencyMs);
  const connection = useGame((s) => s.connection);

  useEffect(() => {
    commands.subscribeSystem(true);
    return () => {
      commands.subscribeSystem(false);
    };
  }, [connection]);

  return (
    <section aria-label="System view" className="rounded-[var(--radius-panel)] border border-ai-700 bg-ai-950/60 p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-xl font-semibold">System view</h2>
        <p className="text-sm text-mist">
          {m ? (
            <>
              Leader <span className="text-washi">{m.leader}</span>, fencing token <span className="tabular text-washi">{m.fencingToken ?? '—'}</span>
              {m.round ? (
                <>
                  , round <span className="tabular text-washi">#{m.round.roundId}</span> {m.round.phase.toLowerCase()}
                </>
              ) : null}
            </>
          ) : (
            'Waiting for the leader to publish metrics…'
          )}
        </p>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Tile title="Server clock">
          <ServerClock />
          <Stat label="Your offset" value={`${offset >= 0 ? '+' : '−'}${Math.abs(offset).toFixed(1)} ms`} />
          <Stat label="Round trip" value={latency !== null ? `${latency} ms` : '—'} />
          <p className="mt-2 text-xs leading-snug text-mist">The server owns time. Your browser only estimates the offset to animate smoothly; payouts use the server&apos;s receive time.</p>
        </Tile>

        <Tile title="Throughput">
          <Stat label="Bets per second" value={m ? m.betsPerSecond.toFixed(1) : '—'} />
          <Stat label="Cash-outs per second" value={m ? m.cashoutsPerSecond.toFixed(1) : '—'} />
          <Sparkline values={history} />
          <Stat label="Commands relayed to leader" value={m ? String(m.instances.reduce((s, i) => s + i.commandsForwarded, 0)) : '—'} />
        </Tile>

        <Tile title="Round loop">
          <Stat label="Timer latency p50 / p99" value={m ? `${m.loop.p50Ms.toFixed(2)} / ${m.loop.p99Ms.toFixed(2)} ms` : '—'} />
          <Stat label="Worst" value={m ? `${m.loop.maxMs.toFixed(2)} ms` : '—'} />
          <Stat label="Queued commands" value={m ? String(m.loop.queueDepth) : '—'} />
          <Stat label="Last settlement drain" value={m ? `${m.drain.lastMs} ms${m.drain.timeouts ? `, ${m.drain.timeouts} timeouts` : ''}` : '—'} />
        </Tile>

        <Tile title="This browser">
          <SceneStats />
          <p className="mt-2 text-xs leading-snug text-mist">The scene drops to a lighter render on its own if it cannot hold 45 fps.</p>
        </Tile>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        <Tile title={`Instances${m ? ` (${m.instances.length})` : ''}`}>
          {m ? (
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-mist">
                <tr>
                  <th className="pb-1 font-normal">Instance</th>
                  <th className="pb-1 text-right font-normal">Sockets</th>
                  <th className="pb-1 text-right font-normal">Clock</th>
                </tr>
              </thead>
              <tbody>
                {m.instances.map((i) => (
                  <tr key={i.instanceId} className="border-t border-ai-700/60">
                    <td className="py-1.5">
                      {i.instanceId} <span className={`text-xs ${i.leader ? 'text-kin' : 'text-mist'}`}>{i.leader ? 'leader' : 'relay'}</span>
                    </td>
                    <td className="tabular py-1.5 text-right">{i.connections}</td>
                    <td className="tabular py-1.5 text-right text-mist" title="Offset to the shared Redis clock">
                      {i.clockOffsetMs >= 0 ? '+' : '−'}
                      {Math.abs(i.clockOffsetMs).toFixed(2)} ms
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          <Stat label="Sockets in total" value={m ? String(m.connections) : '—'} />
        </Tile>

        <Tile title="Kafka events">
          {m ? (
            <>
              <p className="text-xs text-mist">{m.kafka.mode === 'kafka' ? 'Published to Kafka from the outbox.' : 'Dry run: the outbox is drained but no broker is configured.'}</p>
              <Stat label="Events published since start" value={String(m.kafka.published)} />
              <ul className="mt-2 grid gap-1 text-xs">
                {m.kafka.recent.map((e) => (
                  <li key={e.eventId} className="grid grid-cols-[1fr_auto] gap-2 border-t border-ai-700/60 pt-1">
                    <span className="truncate text-washi/90">{e.type}</span>
                    <span className="tabular text-mist">
                      #{e.key} {new Date(e.occurredAt).toLocaleTimeString('en-GB')}
                    </span>
                  </li>
                ))}
              </ul>
              {m.kafka.consumer ? (
                <div className="mt-3 border-t border-ai-700 pt-2">
                  <p className="text-xs text-mist">
                    Read back by consumer group <span className="text-washi/90">{m.kafka.consumer.groupId}</span>
                  </p>
                  <div className="grid grid-cols-2 gap-x-4">
                    <Stat label="Consumed" value={String(m.kafka.consumer.consumed)} />
                    <Stat label="Consumer lag" value={m.kafka.consumer.lag === null ? '—' : String(m.kafka.consumer.lag)} />
                  </div>
                  <ul className="mt-2 grid gap-1 text-xs">
                    {m.kafka.consumer.recent.map((e) => (
                      <li
                        key={`${e.topic}-${e.partition}-${e.offset}`}
                        className="grid grid-cols-[1fr_auto] gap-2 border-t border-ai-700/60 pt-1"
                      >
                        <span className="truncate text-washi/90">{e.topic}</span>
                        <span className="tabular text-mist">
                          p{e.partition} @{e.offset} · {e.endToEndMs} ms
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          ) : null}
        </Tile>

        <Tile title="Ledger">
          {m ? (
            <>
              <div className="grid grid-cols-2 gap-x-4">
                <Stat label="Transactions" value={String(m.ledger.transactions)} />
                <Stat label="Postings" value={String(m.ledger.postings)} />
              </div>
              <Stat
                label="Sum of every posting (must be 0)"
                value={money(m.ledger.sumOfPostings)}
                tone={m.ledger.sumOfPostings === 0 ? 'text-take' : 'text-[#e8909c]'}
              />
              <ul className="mt-2 grid gap-1 text-xs">
                {m.ledger.recent.map((e) => (
                  <li key={e.id} className="grid grid-cols-[4.5rem_1fr_auto] gap-2 border-t border-ai-700/60 pt-1">
                    <span className="text-mist">{e.txType.toLowerCase().replace('_', ' ')}</span>
                    <span className="truncate text-washi/90">{e.account}</span>
                    <span className={`tabular ${e.amount >= 0 ? 'text-take' : 'text-[#e07383]'}`}>
                      {e.amount >= 0 ? '+' : '−'}
                      {money(Math.abs(e.amount))}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </Tile>
      </div>
    </section>
  );
}

function Tile({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg bg-ai-800/70 p-3">
      <h3 className="mb-2 text-sm font-medium text-washi">{title}</h3>
      {children}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5 text-sm">
      <span className="text-mist">{label}</span>
      <span className={`tabular ${tone ?? 'text-washi'}`}>{value}</span>
    </div>
  );
}

/** Server time ticking at display rate from the synced clock (not polled from the server). */
function ServerClock() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const d = new Date(clock.serverNow());
      if (ref.current) ref.current.textContent = `${d.toLocaleTimeString('en-GB', { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, []);
  return <span ref={ref} className="tabular block font-display text-2xl font-semibold text-kin" />;
}

function SceneStats() {
  const [stats, setStats] = useState<FightScene['stats'] | null>(null);
  useEffect(() => {
    const t = setInterval(() => setStats((window as unknown as { __roninScene?: FightScene }).__roninScene?.stats ?? null), 1_000);
    return () => clearInterval(t);
  }, []);
  return (
    <>
      <Stat label="Frames per second" value={stats ? String(stats.fps) : '—'} tone={stats && stats.fps < 45 ? 'text-kin' : undefined} />
      <Stat label="Render quality" value={stats ? stats.quality : '—'} />
      <Stat label="Live particles" value={stats ? String(stats.sparks) : '—'} />
    </>
  );
}

/** Bets per second over the last minute. */
function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  const w = 200;
  const h = 32;
  const step = w / 59;
  const pts = values.map((v, i) => `${(i + 60 - values.length) * step},${h - (v / max) * (h - 2) - 1}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="my-1 h-8 w-full" role="img" aria-label="Bets per second, last minute">
      <polyline points={pts} fill="none" stroke="var(--color-kin)" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}
