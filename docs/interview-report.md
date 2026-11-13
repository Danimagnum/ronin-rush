# Ronin Rush — Informe técnico para entrevista (Senior Full-Stack, iGaming en tiempo real)

> Fuente única: código, configuración, tests, documentación e historial Git del repositorio
> `Danimagnum/ronin-rush` (rama `main`, commit `b24c978`, 13-nov-2026, 87 commits).
> Lo que no aparece en el repositorio se marca como **no consta**.
> Las rutas son relativas a la raíz del repositorio.

---

## 1. Qué hace y para quién

- **Qué:** juego *crash* multijugador en tiempo real con rondas compartidas. Un ronin se bate con un oni; mientras resiste, un multiplicador `m(t) = e^(k·t)` sube; cada jugador retira (cash-out) cuando quiere; en el *crash point* precomputado pierden los que siguen dentro. Solo dinero ficticio ("ryō") (`README.md`).
- **Para quién:** proyecto de portfolio dirigido a equipos de ingeniería de empresas de juego y producto: muestra arquitectura en tiempo real, *provably fair*, reloj autoritativo del servidor y un monedero que no permite gastar dos veces (`README.md`, intro).
- **Estado:** **demo / portfolio, en curso.** Hay una demo jugable en un NAS Synology vía Tailscale Funnel, incrustada en iframe (`docs/deploy-nas.md`, `deploy/portfolio/embed-snippet.html`). La integración con la plataforma (`PLATFORM_MODE=true`) está verificada en parte; el README tiene una lista explícita de lo que **aún no está verificado** (`README.md` § *Platform integration: verified and not verified*). No es producción con dinero real.

## 2. Arquitectura

### Servicios (despliegue)

| Servicio | Tecnología | Papel | Referencia |
|---|---|---|---|
| `proxy` | nginx 1.27 | Origen único: `/` → web, `/api` y `/socket.io` → API; CSP `frame-ancestors` | `Dockerfile` (target `proxy`), `deploy/nginx/default.conf.template` |
| `web` | Next.js 15 standalone | UI + escena PixiJS | `apps/web` |
| `api` ×N | NestJS 11 | Una réplica es **líder** (bucle de ronda); las demás hacen de **relay** | `apps/api`, `docker-compose.yml` (`replicas: 2`) |
| PostgreSQL 16 | | Libro mayor, rondas, apuestas, cadena de semillas, outbox | `apps/api/src/db/migrations/*` |
| Redis 7 | | Lease de líder, reloj de referencia, bus de comandos (Streams), pub/sub, adaptador Socket.IO, leaderboards | `apps/api/src/leader`, `realtime/command-bus.ts` |
| Kafka | Redpanda v24.2.7 (compose local) / apache/kafka 3.9.1 (NAS y CI) | Eventos de dominio `ronin.*.v1` + `system.health.reported.v1` | `docker-compose.yml`, `.github/workflows/ci.yml` |
| platform-core (opcional) | servicio externo | Identidad (JWT RS256/JWKS) y monedero (*holds*) en `PLATFORM_MODE=true` | `apps/api/src/platform/*`, `docs/platform-mode.md` |

### Módulos del API (`apps/api/src`)

`round/` (motor de estados `round-engine.ts`, cola serie, store y semillas en Postgres) · `leader/` (elección por lease Redis con *fencing tokens*) · `clock/` (reloj monotónico alineado a Redis `TIME`) · `wallet/` (libro mayor de partida doble) · `realtime/` (gateway Socket.IO, bus de comandos, barrera de drenaje, read model, métricas de sistema) · `events/` (relay del outbox a Kafka y consumidor "tap") · `auth/` (usuarios propios argon2id + HS256, o JWT de Core) · `platform/` (cliente de Core y ledger de plataforma) · `bots/`, `leaderboard/`, `observability/`, `health/`.

`packages/shared`: código puro e isomórfico (fairness, curva del multiplicador, regla de cash-out, sincronización NTP, esquemas zod) usado por servidor y por la página `/verify` del navegador.

### Comunicación

| Canal | Uso |
|---|---|
| REST (HTTP) | auth (registro, login, invitado), config, rondas/historial, health, `/metrics` (`auth/auth.controller.ts`, `realtime/round.controller.ts`, `health/health.controller.ts`) |
| WebSockets (Socket.IO 4.8) | comandos `placeBet`, `cashout`, `timePing`, `authRenew`; difusión de eventos de ronda y `round:batch` (`realtime/realtime.gateway.ts`) |
| Redis Streams | comandos del relay → líder (`ronin:commands`), respuestas por pub/sub `ronin:reply:<instancia>` (`realtime/command-bus.ts`) |
| Redis pub/sub | adaptador Socket.IO (`@socket.io/redis-adapter`), con prefijo por entorno `REDIS_NAMESPACE` |
| Kafka | outbox transaccional → topics versionados; consumer group que relee los eventos para la *System view* (`events/*`) |
| HTTP a Core | `/api/v1` holds, intenciones de liquidación y settle (`platform/core-client.ts`) |
| RabbitMQ | **no consta** |
| n8n | **no consta** |

### Diagrama

```
                         Navegador (Next.js 15 + React 19 + PixiJS 8)
                                   │ HTTPS + WebSocket (un solo origen)
                                   ▼
                           nginx / Ingress  ──►  web (Next.js standalone)
                          /api   /socket.io
                     ┌────────────┴─────────────┐
                     ▼                          ▼
          API #1 (LÍDER)                  API #2 (RELAY)
          RoundEngine + timers            Gateway Socket.IO
          decide con receivedAt           sella receivedAt ──XADD──┐
             ▲         │                                          │
             │         │      ┌──────────── Redis ──────────────┐ │
             │         └─────►│ lease+fencing · TIME (reloj)    │◄┘
             └── XREAD ───────│ Streams comandos · pub/sub      │
                              │ adaptador Socket.IO · ZSET top  │
                              └─────────────────────────────────┘
             │ persist-then-broadcast
             ▼
        PostgreSQL: ledger (partida doble) · rounds · bets · seed_chain · leader_fence · outbox
             │ OutboxRelay (todas las instancias, FOR UPDATE SKIP LOCKED)
             ▼
        Kafka  ronin.round.started.v1 · ronin.bet.placed.v1 · ronin.bet.cashed_out.v1
               ronin.round.crashed.v1 · ronin.round.settled.v1 · system.health.reported.v1
             │ consumer group <client-id>-system-view
             ▼
        System view (offsets, lag, retardo commit→consumo)

   PLATFORM_MODE=true:  API ──HTTP /api/v1──► platform-core (JWKS, holds, settle)
```

## 3. Stack exacto con versiones

Versiones tal como figuran en los manifiestos (`^` = rango semver del `package.json`; las resueltas están en `pnpm-lock.yaml`).

| Capa | Paquete / imagen | Versión | Archivo |
|---|---|---|---|
| Runtime | Node | `22` (`.nvmrc`), `engines >=20.11`; imagen `node:22-bookworm-slim` | `.nvmrc`, `package.json`, `Dockerfile` |
| Gestor | pnpm | `9.15.4` | `package.json` |
| API | `@nestjs/common` / `core` / `platform-express` | `^11.0.10` | `apps/api/package.json` |
| | `typeorm` | `^0.3.20` | |
| | `pg` | `^8.13.1` | |
| | `ioredis` | `^5.4.2` | |
| | `socket.io` / `@socket.io/redis-adapter` | `^4.8.1` / `^8.3.0` | |
| | `kafkajs` | `^2.2.4` | |
| | `argon2` | `^0.41.1` | |
| | `zod` | `^3.24.2` | |
| | `@sentry/nestjs` | `^9.10.0` | |
| | `@danigil/platform-contracts` | `0.3.0` (fijada) | |
| | TypeScript | `~5.8.3` | |
| Web | `next` | `15.5.4` | `apps/web/package.json` |
| | `react` / `react-dom` | `19.1.1` | |
| | `pixi.js` | `8.13.2` | |
| | `zustand` | `5.0.8` | |
| | `tailwindcss` / `@tailwindcss/postcss` | `^4.1.13` | |
| | `@sentry/nextjs` | `^9.10.0` | |
| | `socket.io-client` | `^4.8.1` | |
| Shared | `zod` `^3.24.2`, TypeScript `~5.7.3`, salida dual ESM+CJS | | `packages/shared/package.json` |
| Tests | `vitest` `^3.0.5`; `@playwright/test` `1.63.0`; k6 (versión **no consta**) | | `*/package.json`, `load/players.k6.js` |
| Infra local | `postgres:16-alpine`, `redis:7-alpine`, `redpandadata/redpanda:v24.2.7`, `nginx:1.27-alpine` | | `docker-compose.yml`, `Dockerfile` |
| Kafka NAS/CI | `apache/kafka:3.9.1` (KRaft) | | `.github/workflows/ci.yml`, `deploy/nas/*` |
| Helm | chart `ronin-rush` `0.1.0`, appVersion `0.1.0` | | `deploy/helm/ronin-rush/Chart.yaml` |
| AWS | **no consta** (el chart es genérico; no hay Terraform ni referencias a AWS) | | |

## 4. Modelo de datos (PostgreSQL)

Migraciones TypeORM en SQL plano: `apps/api/src/db/migrations/` (`InitialSchema`, `PlatformSettlements`, `OutboxRejected`, `CoreWalletV1`).

### Tablas principales

| Tabla | Propósito | Constraints / índices clave |
|---|---|---|
| `users` | usuarios propios, bots y "sombras" de Core | `username UNIQUE`, `external_id UNIQUE` (sujeto de Core), `external_wallet_id` |
| `accounts` | cuentas `user`/`escrow`/`house`/`mint` | `CHECK no_overdraft (balance >= 0)`; `CHECK` dueño y caché solo en cuentas de usuario; índice único parcial `one_system_account_per_kind`. Las cuentas de sistema **no tienen saldo cacheado** a propósito (saldo = `SUM(postings)`) para no serializar todas las apuestas en una fila caliente |
| `ledger_transactions` | cabecera de cada movimiento (`GRANT`, `BET`, `CASHOUT`, `ROUND_LOSS`) | `idempotency_key UNIQUE` |
| `postings` | asientos firmados en céntimos (`bigint`) | `CHECK amount <> 0`; índices por cuenta y por transacción |
| `fairness_chains` | compromiso (hash) de la cadena, salt pública | `commitment UNIQUE`; índice único parcial `one_active_chain` |
| `seed_chain` | semillas por ronda | PK `(chain_id, round_id)` |
| `leader_fence` | fila única con el *fencing token* vigente | `CHECK id = 1` |
| `rounds` | estado de cada ronda (id = posición en la cadena) | `CHECK seed_revealed_only_when_settled`; instantes en epoch ms `double precision` (el instante de crash es fraccionario y debe volver exacto); índice parcial `rounds_settled_idx` |
| `bets` | apuestas | `UNIQUE (round_id, user_id)`, `UNIQUE (user_id, client_key)`, `CHECK amount > 0`, `CHECK auto_x100 > 100`, `CHECK cashout_fields`; índice `(user_id, created_at DESC)`; `external_hold_id` en modo plataforma |
| `outbox` | eventos pendientes de Kafka | `event_id uuid` estable; `rejected_at`/`reject_reason`; índice parcial `outbox_pending_idx WHERE published_at IS NULL AND rejected_at IS NULL` |
| `platform_settlements` | *command outbox* hacia Core | PK `bet_id`, `idempotency_key UNIQUE`, `CHECK status IN ('PENDING','DONE','FAILED')`, `CHECK payout >= 0`; índice parcial por `next_attempt_at WHERE status='PENDING'` |

### Triggers

- `postings_must_balance`: **constraint trigger diferido** (`DEFERRABLE INITIALLY DEFERRED`) que en el commit rechaza cualquier transacción cuyos asientos no sumen 0 (`assert_transaction_balanced`).
- `postings_append_only` y `ledger_transactions_append_only`: `BEFORE UPDATE OR DELETE` → excepción (libro solo de inserción).

### Bloqueos

- `SELECT … FOR UPDATE` sobre la fila de la cuenta del usuario antes de leer el saldo (`wallet/postgres-ledger.ts`, `lockUserAccount`).
- `SELECT token FROM leader_fence … FOR SHARE` en cada operación de dinero; `UPDATE leader_fence … WHERE token <= $1` (exclusivo) en cada transición de fase (`db/fence.ts`).
- `FOR UPDATE SKIP LOCKED` en el relay del outbox (`events/outbox-relay.service.ts`).
- Advisory locks: `pg_advisory_lock(hashtext('ronin:migrations'))` para que varias réplicas arranquen contra una BD vacía (`db/db.module.ts`, commit `01e610d`) y `pg_advisory_xact_lock(hashtext('ronin:fairness-chain'))` al generar la cadena (`round/postgres-seed-source.ts`).
- Nivel de aislamiento: `READ COMMITTED` en todas las transacciones (`db/tx.ts`).

## 5. Flujos críticos paso a paso

### 5.1 Apuesta (modo standalone)

1. **Edge** (`realtime/realtime.gateway.ts`): la primera instrucción del handler sella `receivedAt = clock.now()` (reloj alineado a Redis), antes de parsear, autenticar o cualquier `await`.
2. Comprueba principal y expiración del token, *token bucket* de 10 comandos/s por socket, y valida con zod (`PlaceBetCommand`).
3. `CommandBus.submit`: si la instancia es líder, llama directamente al motor; si no, `XADD ronin:commands` (MAXLEN ~10 000) con `corr` y `replyTo`, y espera la respuesta en `ronin:reply:<instancia>` (timeout 3 s → `TIMEOUT`). El `receivedAt` se registra en un mapa *in-flight* de forma síncrona para la marca de agua.
4. **Líder** (`round/round-engine.ts`, `beginPlaceBet`), **dentro de la cola serie**: fase `BETTING` y `receivedAt < bettingEndsAt`; idempotencia por clave del cliente (`betKeys`); una apuesta por usuario y ronda; límites min/max; reserva síncrona.
5. **Fuera de la cola** (concurrente): `PostgresLedger.debitStake` en **una transacción**: (a) reclama `idempotency_key = bet:<round>:<user>` con `INSERT … ON CONFLICT DO NOTHING`; si ya existe, devuelve éxito sin repetir; (b) `assertFence` (`FOR SHARE`); (c) `FOR UPDATE` en la cuenta, comprueba saldo (`INSUFFICIENT_FUNDS` → `Rollback`); (d) asientos `user −stake / escrow +stake`; (e) `INSERT bets`; (f) `INSERT outbox` (`ronin.bet.placed.v1`). Commit: el trigger diferido verifica la suma 0.
6. Tras el commit: evento `bet.placed` al hub (se agrupa en `round:batch` cada 100 ms) y saldo solo a la sala `user:<id>`.
7. La promesa se registra en `inflight`; la transición `BETTING → RUNNING` drena todas antes de persistir.

### 5.2 Cash-out manual

1. Edge sella `receivedAt`. **El comando no lleva multiplicador.**
2. Líder (cola serie): `decideCashout({receivedAt, startedAt, crashAt, crashX100, k})` (función pura en `packages/shared/src/timing/multiplier.ts`). Si `receivedAt >= crashAt` → `CASHOUT_AFTER_CRASH`. Si el objetivo de auto-cash-out ya se había alcanzado, se paga el auto (lo que ocurrió primero).
3. Reintentos: si hay escritura en curso (`bet.cashing`) devuelve la misma promesa; si ya está `CASHED_OUT`, devuelve el resultado (idempotente).
4. `creditCashout` en una transacción: clave `cashout:<betId>`, fence, `FOR UPDATE` en cuenta, asientos `escrow −stake / house −profit / user +payout`, `UPDATE bets … WHERE status='ACTIVE'` (si no afecta a 1 fila, excepción), outbox `ronin.bet.cashed_out.v1`.

### 5.3 Auto cash-out

El líder programa un temporizador al instante exacto `startedAt + ln(target)/k` del menor objetivo ganador (`scheduleNextAuto`) y paga **al multiplicador objetivo exacto**, con `cashedAt` nominal. En el crash, cualquier auto cuyo objetivo esté por debajo del crash point se paga aunque su timer no haya llegado a dispararse (`crash()`).

### 5.4 Transiciones de ronda

- Instantes **nominales** precalculados (`startedAt = bettingEndsAt`, `crashAt = startedAt + elapsedMsForX100(crashX100, k)`). Los timers solo disparan; su retraso se mide como "round loop latency" pero no cambia el resultado.
- **Persist-then-broadcast:** cada transición se guarda (fila `rounds` + `claimFence` + eventos al outbox, misma transacción, `round/postgres-round-store.ts`) antes de emitirse.
- `crash()`: drena `inflight`, persiste `CRASHED`.
- **Barrera de drenaje** (`realtime/redis-drain-barrier.ts`): antes de liquidar, espera a que todas las instancias vivas publiquen una marca de agua `>= crashedAt` (cada 25 ms, TTL 1 s) y a que el líder haya consumido el stream hasta la punta. Así, un cash-out recibido 1 ms antes del crash en otra máquina sigue siendo válido. Tiene timeout (`DRAIN_TIMEOUT_MS`).
- `settle()`: `settleLosses` en **una única transacción por ronda** (`round-loss:<id>`): `escrow −Σ / house +Σ`, `UPDATE bets SET status='LOST'`; revela la semilla (`SETTLED`, `CHECK` lo exige).

### 5.5 Outbox → Kafka

`OutboxRelay.tick()` cada 250 ms en **todas** las instancias: `SELECT … FOR UPDATE SKIP LOCKED LIMIT 200`, envuelve en el *envelope* de plataforma y valida con `@danigil/platform-contracts`; las filas inválidas se apartan (`rejected_at`, motivo) sin bloquear la cola; `producer.sendBatch` con `acks: -1`, productor `idempotent: true`, `maxInFlightRequests: 1`; clave = `roundId`; header `event-id` estable para deduplicar (**at-least-once**). Sin `KAFKA_BROKERS` funciona en *dry-run*.

### 5.6 Apuesta y liquidación en `PLATFORM_MODE=true`

(`platform/platform-ledger.ts`, `docs/platform-mode.md`)
1. Entrada: el token del **propio jugador** activa Ronin en Core una vez (`ensureWallet`), se guarda `external_wallet_id`.
2. Apuesta: `createHold` en Core (Core aplica KYC, autoexclusión y límites) → `registerHoldSettlementIntent` → solo entonces Ronin registra la apuesta con `external_hold_id` (sin asientos locales). Si un paso posterior falla, se devuelve el stake (settle `void` o release).
3. Cash-out o pérdida: la decisión se confirma localmente junto con una fila `platform_settlements` `PENDING` (*command outbox*, misma transacción). Un worker hace `settleHold` con clave `ronin:settle:<betId>`, con backoff. Respuestas permanentes (p. ej. `settlement_grace_expired`) → `FAILED` para reconciliación manual.

## 6. Concurrencia, reintentos y gestión de fallos

- **Un único escritor:** elección de líder por lease Redis (`SET NX PX`, renovación compare-and-pexpire en Lua, TTL 5 s, renovación 1 s) (`leader/leader-elector.ts`). Si Redis no responde, el líder **dimite** en cuanto el lease podría haber expirado ("dos líderes es peor que una pausa corta").
- **Fencing tokens:** `INCR` en cada adquisición, nunca por debajo del valor de `leader_fence` en Postgres aunque Redis pierda el contador (commit `6011566`). Toda escritura de dinero y de ronda comprueba el token; un exlíder pausado que despierta recibe `FencedOutError` y se para.
- **Failover:** el nuevo líder hidrata la ronda desde Postgres, **verifica que el estado persistido coincide con la cadena de hash** (si no, se niega a arrancar) y continúa según la fase (`resume()` en `round-engine.ts`). Los comandos encolados durante el relevo se procesan desde el cursor guardado en Redis.
- **Decisiones serializadas, escrituras concurrentes:** cola serie para decidir, conjunto `inflight` para escribir en paralelo y drenaje en cada transición (commit `86347be`).
- **Idempotencia en tres niveles:** clave del cliente en memoria (`betKeys`), clave de operación en `ledger_transactions.idempotency_key UNIQUE`, y claves de settle hacia Core.
- **Doble gasto:** `FOR UPDATE` + `CHECK (balance >= 0)` + trigger de balance.
- **Reintentos:** relay del outbox reintenta en el siguiente tick; kafkajs `retry: { retries: 8 }`; settlements de Core con backoff (`attempts`, `next_attempt_at`); el bus devuelve `TIMEOUT` a los 3 s.
- **Degradación:** Kafka caído → los eventos esperan en el outbox y el juego sigue. Core caído → la ronda termina, la decisión se mantiene, las liquidaciones quedan `PENDING`; nuevas apuestas → `WALLET_UNAVAILABLE`; `/health/ready` sigue en 200 (verificado contra Core real, `docs/platform-mode.md`).
- **Rate limiting:** token bucket de 10 comandos/s **por socket** (`realtime.gateway.ts`). En REST: **no consta**.

## 7. IA

**No consta.** No hay modelos, proveedores, prompts, RAG ni llamadas a LLM en el código, la configuración ni la documentación (búsqueda de `openai`, `anthropic`, `llm`, `gpt`, `embedding`, `langchain` sin resultados relevantes). El repositorio tampoco documenta si se usaron asistentes de IA para desarrollarlo.

## 8. Seguridad

- **Autenticación standalone:** contraseñas argon2id; JWT HS256 propio sobre `node:crypto`, con `alg` fijado (nunca se lee de la cabecera), comparación `timingSafeEqual` y comprobación de `exp`/`nbf` (`auth/jwt.ts`). El login verifica contra un hash señuelo si el usuario no existe, para igualar tiempos (`auth/auth.service.ts`). Usuarios invitados con un clic.
- **Autenticación en plataforma:** tokens de Core verificados con el verificador del paquete de contratos: RS256, JWKS por `kid`, issuer y audience exactos, `exp`/`nbf`, tokens de máquina rechazados; si falla, se rechaza (*fail closed*).
- **Socket:** el token se valida en el handshake; a su expiración se emite `authExpired` y se rechazan comandos (`AUTH_EXPIRED`) sin cerrar el socket; renovación en el mismo socket con comprobación de identidad (`IDENTITY_MISMATCH`). Una apuesta ya aceptada se liquida aunque el token caduque (test `auth-renewal.e2e.test.ts`).
- **Validación de entrada:** zod en variables de entorno (`config/env.ts`, exige `JWT_SECRET` en producción y las variables `CORE_*` en modo plataforma), comandos de socket (`packages/shared/src/round/schemas.ts`) y credenciales. Importes enteros en céntimos y límites min/max en el motor.
- **Integridad del juego:** el cliente nunca envía multiplicador; las semillas solo las lee el líder y se revelan al liquidar; `CHECK` impide revelar antes de tiempo.
- **Navegador:** CSP `frame-ancestors` (solo el portfolio puede incrustarlo); `postMessage` solo con orígenes exactos de `PORTAL_ORIGINS`, nunca `*` (`docs/platform-mode.md`).
- **Contenedores:** imágenes `USER node`.
- **Roles:** **no consta** (no hay roles ni panel de administración).
- **Multiempresa / multi-tenant:** **no consta**. Es multiusuario; en modo plataforma el multi-servicio lo gestiona Core (*grants* por jugador y servicio).
- `CORS_ORIGIN` por defecto es `*` (`config/env.ts`); el chart de Helm lo fija a un dominio.

## 9. Tests

### Inventario (casos `it`/`test` en el código; `it.each` cuenta una vez)

| Suite | Archivos | Casos | Qué cubre |
|---|---|---|---|
| `packages/shared/test` | 7 | 38 en código (50 al ejecutar, por `it.each`) | SHA-256/HMAC frente a vectores, cadena de hash, fórmula BigInt del crash point, **distribución con 1 000 000 de rondas**, curva y regla de cash-out en los límites, sincronización NTP, esquemas |
| `apps/api/test` | 21 | 106 | motor de estados, failover, pipeline, ledger, **500 operaciones concurrentes**, bus de comandos, elección de líder, reloj, JWT, entorno, observabilidad, contrato de eventos, Kafka real, auth de plataforma con JWKS real por HTTP, ledger de plataforma contra un *stand-in* HTTP de Core, e2e con dos instancias reales, renovación de token, Core real |
| `apps/web/src/lib/portal.test.ts` | 1 | 3 | protocolo `postMessage` con el portal |
| `e2e/tests` (Playwright) | 3 | 3 | apostar → cash-out → ver el pago; cash-out tardío rechazado; página verify |
| `load/players.k6.js` (k6) | 1 | — | 1 000 jugadores simulados por WebSocket |

### Resultados ejecutados al preparar este informe (13-nov-2026, contenedor Linux, Node 22)

- `packages/shared`: **50/50 pasan** (7 archivos). El test de distribución de 1 M de rondas tarda unos 11,7 s.
- `apps/api` contra **PostgreSQL 16 y Redis reales**: **95 pasan, 11 se saltan, 0 fallan** (19 archivos pasan, 2 se saltan). Se saltan `kafka.e2e.test.ts` (requiere broker) y `core-real.e2e.test.ts` (requiere platform-core). Destacan: 500 apuestas + 500 cash-outs concurrentes con el libro cuadrado (1,8 s); failover del líder con el socket del relay recibiendo rondas (11,1 s); cash-out tardío rechazado; liquidación exactamente una vez tras matar al líder.
- Playwright y k6: **no ejecutados aquí**. CI ejecuta Playwright; para k6 solo constan los resultados documentados.

### Carga medida (documentada en `load/README.md`)

- **Primera ejecución con 1 000 VUs:** ACK de apuesta **p95 ≈ 15 s**, cola del motor de hasta **383 comandos**.
- **Tras la corrección:** cola 0, API al **~23 % de CPU**, **5 739 apuestas**, **0,00 % de fallos reales**. Una sonda independiente durante la carga midió ACK de apuesta p50 4 ms / **p95 7 ms**, ACK de cash-out p50 5 ms / **p95 7 ms** y ping 1 ms.
- Salvedad documentada: k6 seguía mostrando p95 ≈ 5 s porque el generador corría en la misma máquina al ~100 % de CPU (mide el generador, no el servidor).
- Umbrales del script: p95 < 300 ms, p99 < 800 ms, fallos < 1 %, conexión WS p95 < 1 s.
- Según el README, cada test nuevo se comprobó frente a una mutación deliberada del código que protege (`README.md` § Tests; mutaciones concretas listadas en `docs/platform-mode.md`).

## 10. Observabilidad

- **Logs:** `Logger` de NestJS (12 usos en `apps/api/src`). Logs estructurados o centralizados: **no consta**.
- **Métricas:** `GET /metrics` en formato Prometheus, con implementación propia (`observability/prometheus.ts`): `http_requests_total`, `http_request_duration_seconds`, latencia del bucle de ronda, apuestas y cash-outs, conexiones, offset de reloj, retraso del outbox y settlements de Core (`README.md`). La configuración de *scraping* para platform-infra está en `docs/platform-infra-additions.md` §6.
- **Health:** `/health/live`, `/health/ready` (503 solo si caen Postgres o Redis), `/health`; evento `system.health.reported.v1` cada 30 s y en cada cambio de estado (`observability/health.service.ts`).
- **Sentry:** opcional, en API (`instrument.ts`, `tracesSampleRate` 0,1 configurable) y web (`instrumentation-client.ts`, carga diferida solo si hay DSN).
- **System view** en la UI: reloj del servidor y offset del cliente, conexiones por instancia, apuestas por segundo, stream de Kafka con offsets y lag, suma del libro (siempre 0) y latencia del bucle (`apps/web/src/components/SystemView.tsx`, `realtime/system-metrics.service.ts`).
- **Grafana:** **no consta** (no hay dashboards en el repo).

## 11. Despliegue y CI/CD

- **Local:** `docker compose up --build` → `http://localhost:8080`, con 2 réplicas del API, nginx, Postgres, Redis y Redpanda (`docker-compose.yml`). Dockerfile multi-stage con targets `api`, `web` y `proxy`, y `pnpm deploy --prod`.
- **Kubernetes:** chart Helm `deploy/helm/ronin-rush`: Deployments de API (2 réplicas, requests 100m/192Mi, límite 384Mi) y web, ConfigMap, Secret o `existingSecret`, Ingress nginx con TLS, afinidad por cookie y timeouts de 3600 s para WebSocket, PDB `minAvailable: 1`, HPA opcional (2–6 réplicas, 70 % CPU). Postgres, Redis y Kafka quedan fuera del chart (servicios gestionados). **No consta** un despliegue real en Kubernetes ni en un proveedor cloud.
- **Demo real:** Synology DS918+ (4 GB RAM, Docker 20.10.3) detrás de Tailscale Funnel, con scripts `release.sh`/`release.ps1` (`docker save` + SHA-256), `deploy.sh`, `rollback.sh`, `backup-db.sh` (`pg_dump -Fc`, guarda las 10 últimas copias), `restore-db.sh` y `smoke.sh` (`deploy/nas/`, `docs/deploy-nas.md`). Límites: postgres 256 MB, redis 64 MB, api 384 MB, web 192 MB, proxy 64 MB; consumo real de unos 350–400 MB.
- **CI (GitHub Actions, `.github/workflows/ci.yml`):** typecheck y tests con servicios Postgres y Redis reales; test de contrato de eventos; Playwright; job con un **broker Kafka real** (`apache/kafka:3.9.1`); imágenes `linux/amd64` de los tres targets con push a GHCR en `main` (tags SHA completo, SHA corto y `main`; sin attestations porque el NAS usa Docker 20.10); `nginx -t`; `helm lint` + `helm template` + **kubeconform**; validación de los ficheros Compose y `bash -n` de los scripts.
- **CD automático:** **no consta**. El despliegue en el NAS es manual, con scripts.

## 12. Decisiones técnicas importantes

| Decisión | Alternativa descartada / motivo (según el repo) |
|---|---|
| Un líder único ejecuta el bucle de ronda; el resto hace de relay | Descartada la decisión distribuida: una ronda compartida necesita un único orden de decisiones. Failover dentro del TTL del lease (5 s) (`README.md` § Architecture) |
| Fencing token comprobado **en Postgres** | El lease de Redis por sí solo no evita que un líder pausado escriba al despertar (`leader-elector.ts`, `db/fence.ts`) |
| El servidor es dueño del reloj; el cash-out no lleva multiplicador | Confiar en el cliente permitiría manipular el pago (`README.md` § Why the server owns the clock) |
| Reloj monotónico alineado a Redis `TIME` | `Date.now()` es sensible a saltos de NTP en el host; todas las instancias comparan contra la misma referencia (`clock/clock.ts`) |
| Instantes nominales en vez de "después del paso anterior" | Evita la deriva de la línea temporal (`README.md` § Round state machine) |
| Crash point en BigInt | Coma flotante podría dar distinto resultado en servidor y navegador; así coinciden al céntimo (`README.md` § Provably fair) |
| SHA-256/HMAC síncronos propios en `shared` | Sin depender de WebCrypto, para que la página verify use exactamente las mismas funciones puras |
| Partida doble con invariantes en la BD (trigger diferido, append-only, CHECK) | No fiarse solo del código de aplicación (`InitialSchema`) |
| Cuentas de sistema sin saldo cacheado | Una fila caliente serializaría todas las apuestas |
| Outbox transaccional | Descartada la publicación directa a Kafka: no habría cash-out pagado sin evento ni evento sin apuesta; Kafka caído no para el juego |
| Escrituras al ledger fuera de la cola serie (*pipelining*) | La versión serializada daba p95 de 15 s con 1 000 jugadores (`load/README.md`) |
| Agrupar difusiones en `round:batch` cada 100 ms | Enviar cada evento a cada socket es O(N²) (`load/README.md`) |
| Redis Streams como bus de comandos, con marcas de agua | Necesario para no perder cash-outs recibidos justo antes del crash en otra instancia (`command-bus.ts`) |
| Liquidación con Core mediante *command outbox* | Core lento o caído nunca bloquea ni revierte una decisión (`PlatformSettlements`) |
| JWT HS256 propio en vez de una librería | Sin dependencias y lo bastante pequeño para auditarlo; `alg` fijado (`auth/jwt.ts`) |
| Kafka del NAS: apache/kafka 3.9.1 en vez de Redpanda | La imagen ya estaba descargada en el NAS por la plataforma y funciona con cualquier kernel (commit `fb0e2e6`) |
| Red del stack en el NAS: un solo network namespace | En el NAS el TCP por la red bridge daba timeout (commit `bb8deb9`) |
| Cash-out tras el crash → rechazo aunque la pantalla siguiera mostrando la ronda | Equidad: decide la hora de recepción en el servidor |

## 13. Problemas reales y cómo se resolvieron (según commits y documentación)

1. **ACKs de apuesta de 15 s con 1 000 jugadores** (cola de hasta 383 comandos). Causas: escrituras al ledger serializadas y difusión O(N²). Solución: *pipelining* (commit `86347be`) y `round:batch` (commit `f92024d`). Resultado: p95 de 7 ms medido por la sonda (`load/README.md`).
2. **La métrica de latencia del bucle mostraba un p99 de 85 s tras un reinicio**, porque contaba como retraso del timer el tiempo de caída. Ahora el retraso se mide desde que se programa el timer (commit `ea81e00`).
3. **Fugas entre entornos por pub/sub**: el pub/sub de Redis ignora el número de base de datos lógica; un e2e en la DB 1 recibía rondas de la DB 0 de desarrollo. Solución: `REDIS_NAMESPACE` (commit `e51eeea`).
4. **Fencing token por debajo de la fence de la BD tras un reset de Redis**: el contador se eleva siempre por encima de `leader_fence` (commit `6011566`).
5. **Varias réplicas arrancando contra una BD vacía**: advisory lock para las migraciones (commit `01e610d`).
6. **Arranque en frío del API en el NAS: unos 90 s** cargando módulos (Sentry 41 s, Nest 16 s, TypeORM 13 s, app 17 s), lo que lo marcaba como unhealthy. Solución: *start period* de 300 s y espera de hasta 7 min en `deploy.sh` (commit `3b4fb6b`).
7. **TCP por la red bridge con timeout en el NAS** (el DNS resolvía): se usa un network namespace compartido (`network_mode: service:redis`) (commit `bb8deb9`, `docs/deploy-nas.md`).
8. **`docker load` fallaba en Docker 20.10** por las attestations de proveniencia (archivo OCI sin `manifest.json`). Solución: `--provenance=false --sbom=false` y validación del bundle (commit `e6861d4`).
9. **`docker-compose` con timeout de 60 s** durante el deploy: `COMPOSE_HTTP_TIMEOUT=300` (commit `c248674`).
10. **El traductor de Chrome rompía React** (`removeChild`): `translate="no"` (commit `84bae1e`).
11. **CI:** el paso apt de Playwright falló una vez y otra se colgó más de 13 min → solo se descarga Chromium, con límite de tiempo (commit `a8e5720`). `nginx -t` fallaba al no poder resolver los upstreams; el e2e de Kafka se suscribía antes de que existiera el topic (commit `8539f5d`).
12. **Huecos en la API de Core** (pago de premios, settle atómico, grants, etc.): ocho carencias registradas frente a Core `71e2e50`, cerradas con Core v0.2.0 y contratos 0.3.0 (`docs/platform-mode.md` § *Migrated to /api/v1*).

Issues de GitHub: **no consta** (no se consultaron por un error 503 del proxy de credenciales y no hay referencias en el repo). PRs: #1–#5 fusionados según el historial Git.

## 14. Uso real

**No consta** (no hay cifras de usuarios ni de volumen reales). Solo constan: 12 bots por defecto que animan la mesa (`BOTS_COUNT`), la demo del NAS y los volúmenes de las pruebas de carga.

## 15. Limitaciones conocidas y qué mejoraría para producción a gran escala

**Documentadas en el repositorio**
- Sin verificar: la imagen de Core en sí, Core en el staging del NAS, caídas de Core de más de unos 90 min (Core reembolsa el stake y un premio ya decidido queda `FAILED` para reconciliación manual), el lado del portal en el traspaso de token y una segunda instancia dentro del staging de plataforma (`README.md`, `docs/platform-mode.md`).
- Siguientes pasos citados: *sharding* de rondas por "mesa", read model en una réplica y particionar el relay del outbox por clave (`README.md` § How it scales).
- Resultados de k6 limitados porque el generador compartía máquina con el API.

**Observaciones sobre el código (propuestas de mejora, no documentadas como tales)**
- **Un solo líder = un solo proceso** decide todas las rondas: techo vertical; *sharding* por mesa con un lease por mesa.
- **Semillas en claro** en `seed_chain`: en producción convendría guardarlas en un KMS/HSM, o solo la semilla terminal cifrada para derivar las demás.
- **Auditoría sobre `SUM(postings)`** sin snapshots: crecerá linealmente; faltan saldos de cierre periódicos y particionado de `postings`.
- **Sin retención** para `outbox`, `platform_settlements` ni el stream de comandos más allá de `MAXLEN ~10000`: falta limpieza o particionado por tiempo.
- **Rate limiting solo por socket**; ninguno en REST (creación de invitados) ni por usuario o IP entre sockets.
- `CORS_ORIGIN='*'` por defecto; JWT HS256 de 7 días sin revocación en modo standalone.
- **Sin roles ni backoffice**; sin multi-tenant; sin KYC ni límites propios (se delegan a Core).
- **Observabilidad:** sin logs estructurados, sin trazas distribuidas que unan socket → bus → BD → Kafka, sin dashboards ni alertas versionados.
- **Despliegue:** sin CD, sin manifiestos de infraestructura (Terraform) ni gestión de secretos (External Secrets o similar); Redis sin persistencia en Compose (el lease y el cursor se pierden al reiniciar; mitigado por la fence de Postgres).
- **Kafka:** at-least-once; los consumidores deben deduplicar por `event-id`. Productor idempotente pero sin transacciones de Kafka.

## 16. Diez preguntas difíciles de un entrevistador senior (respuestas en inglés)

**1. How do you guarantee a player can't get paid a multiplier they didn't actually reach?**
The cash-out command carries no multiplier. The edge stamps `receivedAt` from a Redis-aligned monotonic clock as the very first statement of the handler, and the leader pays `m(receivedAt − startedAt)` via the pure `decideCashout` function. If `receivedAt >= crashAt`, it returns `CASHOUT_AFTER_CRASH`, even if the client still showed the round running. A Playwright test and a two-instance e2e test cover the late case.

**2. What happens if the leader pauses for a long GC, loses its lease, and then wakes up mid-write?**
Every acquisition increments a fencing token that never drops below the `leader_fence` row in Postgres. Each ledger write takes a `FOR SHARE` lock on that row and fails if a newer token exists; each phase transition bumps it with `UPDATE … WHERE token <= $1`. The stale leader gets `FencedOutError`, stops its engine and answers `NOT_LEADER`. `engine-postgres.test.ts` covers this case.

**3. Two instances: a cash-out lands on the relay 1 ms before the crash. How is it not lost?**
Every edge publishes a watermark every 25 ms: the oldest in-flight `receivedAt`, or now. Before settling, the leader waits until every live watermark is `>= crashedAt` and it has consumed the Redis stream up to its tip (`RedisDrainBarrier`). The command is still judged by its original `receivedAt`, so it's paid. There's a timeout so a dead edge can't block settlement forever.

**4. How do you prevent double spending under concurrency?**
Each operation is one transaction. It claims a unique idempotency key with `ON CONFLICT DO NOTHING`, locks the user account `FOR UPDATE` before reading the balance, and writes postings that a deferred constraint trigger forces to sum to zero. `CHECK (balance >= 0)` is the last line of defence. A test fires 500 concurrent bets plus 500 cash-outs against real Postgres and checks there are no negative balances, no double pay, and that all postings sum to zero.

**5. Why not just publish to Kafka after the DB commit?**
Because a crash between the commit and the publish loses the event, and publishing first can emit an event for a bet that rolled back. I write the event into an `outbox` row in the same transaction. A relay on every instance drains it with `FOR UPDATE SKIP LOCKED`, sending with `acks=-1` and an idempotent producer. Delivery is at-least-once with a stable `event-id` header for dedup. Events are schema-validated, and invalid ones are set aside instead of blocking the queue.

**6. Your first load test showed 15 s p95 bet acks. What was wrong and how did you fix it?**
Two things. Postgres writes were awaited inside the engine's serial queue, so throughput was one transaction at a time. I kept only the decision serialized and moved the writes into a tracked in-flight set that every phase transition drains first. The second problem was O(N²) broadcasting, which I fixed by coalescing bets and cash-outs into a 100 ms `round:batch`. An independent probe then measured 7 ms p95 with 1,000 simulated players.

**7. How is the game provably fair, and could the house still cheat?**
A hash chain is generated backwards (`seed_i = SHA256(seed_{i+1})`) and only the commitment is published. Each round's crash point is `floor(99·2^52 / (2^52 − h))/100` from HMAC-SHA256(seed, publicSalt), computed in BigInt so browser and server agree. Seeds are revealed at settlement, and `/verify` recomputes them in the browser. The house can't choose a crash after seeing bets. It could in theory leak future seeds, because they're stored in Postgres; in production I'd put them in a KMS/HSM. On resume, the leader refuses to run if the stored state doesn't match the chain.

**8. What does the leader do with a round that was in progress when it took over?**
It loads the latest round from Postgres, verifies the seed hash and crash point against the chain, claims the fence, and resumes by phase. In `BETTING` it re-announces and keeps the countdown. In `RUNNING` it reschedules auto cash-outs and the crash, or crashes at once if the instant has passed. From `CRASHED` it goes straight to the drain and settlement, and from `SETTLED` it schedules the next round. Because state is persisted before it's broadcast, clients never saw anything a failover could undo.

**9. In platform mode, what if the wallet service is down when a player cashes out?**
The decision commits locally together with a `PENDING` `platform_settlements` row. A worker retries the settle with backoff using a fixed key, `ronin:settle:<betId>`, so a lost response is replayed safely. Core keeps the hold settleable for 1800 s past its expiry. Permanent answers park the row as `FAILED` with degraded health and a metric. Bets are refused with `WALLET_UNAVAILABLE` while Core is down. This was verified against a real platform-core v0.2.0 that was SIGKILLed mid-round.

**10. How would you scale this to 100k concurrent players?**
WebSocket fan-out already scales horizontally: stateless API replicas, the Redis adapter, batched broadcasts and balances sent only to their owner. The bottleneck is the single leader and the single Postgres primary. I'd shard rounds into tables, each with its own lease and fence. I'd snapshot balances and partition `postings` and `outbox` by time, move the read model and history to replicas, and partition the outbox relay by key. Load generation would run from separate hosts, since our k6 numbers were limited by co-locating the generator.

---

*Generado el 13-nov-2026 a partir del repositorio. Las cifras de tests de §9 "ejecutados al preparar este informe" proceden de una ejecución real en esta sesión; el resto procede literalmente de los archivos citados.*
