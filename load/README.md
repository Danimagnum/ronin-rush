# Load test — 1,000 simulated players

`players.k6.js` drives the real-time API the way browsers do: guest sign-in over HTTP, then a
Socket.IO connection (raw Engine.IO v4 framing over WebSocket), bets in ~60% of rounds, half of
them with an auto cash-out, the rest cashing out by hand at a random target.

```bash
k6 run load/players.k6.js                                      # 1,000 players → localhost:3001
k6 run -e BASE_URL=https://ronin.example -e VUS=300 load/players.k6.js
```

Thresholds: bet / cash-out acknowledgement p95 < 300 ms and p99 < 800 ms, real failures < 1%
(game rejections such as `BETTING_CLOSED` or `CASHOUT_AFTER_CRASH` are counted apart), WebSocket
connect p95 < 1 s.

## What the first run found, and the fix

The first 1,000-player run failed badly: bet acknowledgements took **~15 s at p95**, with the
round engine's command queue up to 383 commands deep. Two causes:

1. **Ledger writes were serialized.** Every bet and cash-out awaited its Postgres transaction
   *inside* the engine's serial queue, so throughput was one transaction at a time.
   Now only the *decision* is serialized (betting window open? multiplier at server receive
   time? already cashed?). The ledger write runs concurrently, tracked in an in-flight set.
   Each phase transition (`RUNNING`, `CRASHED`, `SETTLED`) first drains that set, so no write
   can straddle a transition. Covered by `apps/api/test/pipeline.test.ts`: 20 concurrent bets
   take about the time of one write, a retried cash-out is paid once, and a bet accepted just
   before the window closes is still in the round.
2. **O(N²) broadcasting.** Every bet and cash-out was pushed to every socket individually. They
   are now coalesced into a `round:batch` message every 100 ms. Phase changes (start, crash,
   settle) are still sent immediately.

## Results after the fix

Same machine, 1,000 VUs: queue depth 0, API process ~23% CPU, 5,739 bets placed, real failures
0.00%.

k6 itself still reported bet ack p95 ≈ 5 s. That figure measures the load generator, not the
server: k6 ran on the same container at ~100% CPU, and its event loop delayed reading the
replies. To separate the two, an independent probe client played alongside the 1,000 VUs:

| probe (during 1,000-VU load) | p50  | p95  | max  |
|------------------------------|------|------|------|
| bet acknowledgement          | 4 ms | 7 ms | 7 ms |
| cash-out acknowledgement     | 5 ms | 7 ms | 7 ms |
| ping round-trip              | 1 ms | 1 ms | 3 ms |

For meaningful k6 numbers, run the generator on a different machine from the API, or use
k6 Cloud / several generator hosts.
