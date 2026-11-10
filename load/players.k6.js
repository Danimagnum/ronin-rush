// k6 load test: up to 1,000 simulated players on the real-time API.
//
// Each virtual player signs in as a guest, opens a Socket.IO connection (raw Engine.IO v4
// framing over WebSocket, exactly what a browser sends), and plays rounds: bets in ~60% of them,
// half with an auto cash-out, the rest cashing out by hand at a random target.
//
//   k6 run load/players.k6.js                                  # 1,000 players against localhost:3001
//   k6 run -e BASE_URL=https://ronin.example -e VUS=200 load/players.k6.js
//
// Rejections that are part of the game (BETTING_CLOSED, CASHOUT_AFTER_CRASH, NO_ACTIVE_BET…) are
// counted separately from real failures (timeouts, NOT_LEADER, transport errors).
import http from 'k6/http';
import ws from 'k6/ws';
import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE_URL = (__ENV.BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const WS_URL = BASE_URL.replace(/^http/, 'ws') + '/socket.io/?EIO=4&transport=websocket';
const VUS = Number(__ENV.VUS || 1000);
const HOLD = __ENV.HOLD || '3m';
const SESSION_S = Number(__ENV.SESSION_S || 90);

export const options = {
  scenarios: {
    players: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: __ENV.RAMP || '1m', target: VUS },
        { duration: HOLD, target: VUS },
        { duration: '20s', target: 0 },
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    // Command round-trip as seen by a player: socket -> (relay) -> leader -> ledger -> ack.
    bet_ack_ms: ['p(95)<300', 'p(99)<800'],
    cashout_ack_ms: ['p(95)<300', 'p(99)<800'],
    command_failures: ['rate<0.01'],
    ws_connecting: ['p(95)<1000'],
    checks: ['rate>0.99'],
  },
};

const betAck = new Trend('bet_ack_ms', true);
const cashoutAck = new Trend('cashout_ack_ms', true);
const failures = new Rate('command_failures');
const rejections = new Counter('game_rejections');
const betsPlaced = new Counter('bets_placed');
const cashedOut = new Counter('cash_outs');

const GAME_REJECTIONS = new Set(['BETTING_CLOSED', 'ALREADY_BET', 'CASHOUT_AFTER_CRASH', 'NO_ACTIVE_BET', 'NOT_RUNNING', 'ROUND_MISMATCH', 'INSUFFICIENT_FUNDS']);

function guestToken() {
  const res = http.post(`${BASE_URL}/api/auth/guest`, null, { tags: { name: 'guest' } });
  check(res, { 'guest created': (r) => r.status === 201 });
  return res.status === 201 ? res.json('token') : null;
}

const randomKey = () => `${__VU}-${__ITER}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`.replace(/[^a-z0-9-]/gi, '');

export default function () {
  const token = guestToken();
  if (!token) return;

  let ackId = 0;
  const pending = new Map(); // ack id -> { sentAt, kind }
  let manualTarget = null;
  let myRound = null;
  let k = 0.00006;

  const res = ws.connect(WS_URL, { tags: { name: 'socket' } }, (socket) => {
    const emit = (event, payload, kind) => {
      const id = ackId++;
      pending.set(id, { sentAt: Date.now(), kind });
      socket.send(`42${id}${JSON.stringify([event, payload])}`);
    };

    const onAck = (id, result) => {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      const ms = Date.now() - p.sentAt;
      if (p.kind === 'bet') betAck.add(ms);
      if (p.kind === 'cashout') cashoutAck.add(ms);
      if (result.ok) {
        failures.add(false);
        if (p.kind === 'bet') betsPlaced.add(1);
        if (p.kind === 'cashout') cashedOut.add(1);
      } else if (GAME_REJECTIONS.has(result.error)) {
        failures.add(false);
        rejections.add(1, { error: result.error });
      } else {
        failures.add(true);
      }
    };

    const onEvent = (e) => {
      if (e.type === 'round.betting') {
        myRound = null;
        manualTarget = null;
        const left = e.bettingEndsAt - e.serverTime;
        if (Math.random() < 0.6 && left > 800) {
          // Humans don't all click at once: spread bets across the betting window.
          socket.setTimeout(() => {
            const auto = Math.random() < 0.5;
            const target = Math.max(101, Math.floor(105 / (1 - Math.random() * 0.85)));
            emit('bet:place', { amount: 100 * (1 + Math.floor(Math.random() * 10)), autoX100: auto ? target : null, idempotencyKey: randomKey() }, 'bet');
            myRound = e.roundId;
            if (!auto) manualTarget = target;
          }, Math.random() * (left - 600));
        }
      } else if (e.type === 'round.started' && e.roundId === myRound && manualTarget) {
        k = e.k;
        // Aim at the target multiplier using local time; the server decides what is actually paid.
        const delay = Math.log(manualTarget / 100) / k + (Math.random() * 300 - 100);
        socket.setTimeout(() => emit('bet:cashout', { roundId: e.roundId, idempotencyKey: randomKey() }, 'cashout'), Math.max(0, delay));
      }
    };

    socket.on('message', (msg) => {
      if (msg === '2') return socket.send('3'); // Engine.IO ping/pong
      if (msg.startsWith('0')) return socket.send(`40${JSON.stringify({ token })}`); // open -> connect with auth
      if (msg.startsWith('43')) {
        const m = msg.match(/^43(\d+)(.*)$/);
        if (m) onAck(Number(m[1]), JSON.parse(m[2])[0]);
        return;
      }
      if (msg.startsWith('42')) {
        const [event, payload] = JSON.parse(msg.slice(2));
        if (event === 'round:event') onEvent(payload);
        // bets/cash-outs arrive batched in 'round:batch'; this player only reacts to phase changes
      }
    });

    socket.on('error', () => failures.add(true));
    socket.setTimeout(() => socket.close(), SESSION_S * 1000);
  });

  check(res, { 'socket upgraded': (r) => r && r.status === 101 });
}
