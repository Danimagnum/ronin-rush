# Adding Ronin Rush to platform-infra

What platform-infra needs so Ronin Rush runs as a platform service (`PLATFORM_MODE=true`: Core
identity and wallet, platform Kafka). **Nothing here has been applied to platform-infra yet**;
the owner of that repository adds it. The standalone demo on the NAS (`deploy/nas`, port 10000)
is a separate stack and does not change.

Read against platform-infra `25950e7` and platform-core `71e2e50`.

Contents: [1. Images](#1-images) · [2. Compose services](#2-compose-services-profile-full) ·
[3. Database and role](#3-database-and-role) · [4. Kafka topics](#4-kafka-topics) ·
[5. Core service client](#5-core-service-client) · [6. Prometheus](#6-prometheus) ·
[7. Helm / Argo CD](#7-helm--argo-cd) · [8. NAS staging variant](#8-nas-staging-variant-platform-staging) ·
[9. Variables](#9-variables-example-values-no-secrets) · [10. Memory budget](#10-memory-budget) ·
[11. Open points](#11-open-points)

## 1. Images

Three images, `linux/amd64`, pushed from `main` by Ronin's CI (public packages):

| Image | Role | Listens on |
|---|---|---|
| `ghcr.io/danimagnum/ronin-rush-api:<sha7>` | NestJS API, Socket.IO, round loop, outbox relay | `PORT` |
| `ghcr.io/danimagnum/ronin-rush-web:<sha7>` | Next.js standalone | `PORT` |
| `ghcr.io/danimagnum/ronin-rush-proxy:<sha7>` | nginx: serves web, `/api`, `/socket.io` and `/health` on one origin | `LISTEN_PORT` (8080) |

Tags: full SHA, short SHA (7 characters, the same tags as the NAS release bundles) and `main`.
Pin the short SHA, never `main`. Note the namespace: `danimagnum`, not the `danigil` placeholders
used by the other services in platform-infra.

The web build has an empty `NEXT_PUBLIC_API_URL`: the browser calls `/api` and `/socket.io` on
its own origin, so **the proxy is required** in front of the web app. Prometheus scrapes the API
directly; `/metrics` is not routed by the proxy.

Image facts against `docs/service-integration.md`: runs as `node` (UID 1000), `GET /health/live`,
`GET /health/ready` (503 while Postgres or Redis is down; Kafka and Core only degrade), `GET
/metrics` (Prometheus, includes `http_requests_total` and `http_request_duration_seconds`),
graceful SIGTERM, `SERVICE_NAME`, `PORT`, `DATABASE_URL`, `KAFKA_BROKERS`, `REDIS_URL`,
`CORE_ISSUER`, `CORE_AUDIENCE`, `CORE_JWKS_URL`, `CORE_CLIENT_ID`, `CORE_CLIENT_SECRET`.
Read-only root filesystem: the API writes nothing to disk; the web app needs a writable
`.next/cache`, and nginx its cache and pid directories (tmpfs below).

## 2. Compose services (profile `full`)

For `docker-compose.yml`, next to `spotkick`. The API reuses the `*backend` anchor (health check
on `/health/ready`, depends on Kafka, Postgres, Redis and Core).

```yaml
  ronin:
    <<: *backend
    image: ${RONIN_API_IMAGE:-ghcr.io/danimagnum/ronin-rush-api:<sha7>}
    env_file:
      - path: .env.ronin            # CORE_CLIENT_SECRET, JWT_SECRET (see section 9)
        required: false
    environment:
      <<: *backend-env
      SERVICE_NAME: ronin-rush      # event `source`; Ronin's events have always used this name
      PLATFORM_MODE: 'true'
      DATABASE_URL: postgresql://ronin:${RONIN_DB_PASSWORD:-ronin-local}@postgres:5432/ronin
      REDIS_URL: redis://redis:6379/3
      REDIS_NAMESPACE: ronin-platform  # pub/sub ignores the DB index: keep a distinct prefix
      CORE_URL: http://core:3000
      CORE_CLIENT_ID: ronin
      CORE_HOUSE_ACCOUNT_ID: ${RONIN_HOUSE_ACCOUNT_ID:?house account id from Core}
      CORE_CURRENCY: EUR
      KAFKA_CLIENT_ID: ronin-rush
      KAFKA_PARTITIONS: '3'
      PORTAL_ORIGINS: ${RONIN_PORTAL_ORIGINS:-http://localhost:3000}
      CORS_ORIGIN: ${RONIN_PUBLIC_ORIGIN:-http://localhost:3007}
      BOTS_COUNT: '4'               # bots stay on Ronin's local ledger, never on Core
      NODE_OPTIONS: --max-old-space-size=224
    read_only: true
    tmpfs: [/tmp]
    mem_limit: 320m
    # No published port: reached through ronin-proxy; Prometheus scrapes ronin:3000/metrics.

  ronin-web:
    image: ${RONIN_WEB_IMAGE:-ghcr.io/danimagnum/ronin-rush-web:<sha7>}
    profiles: [full]
    restart: unless-stopped
    environment:
      PORT: '3000'
      HOSTNAME: 0.0.0.0
      NODE_OPTIONS: --max-old-space-size=128
    read_only: true
    tmpfs: [/tmp, /app/apps/web/.next/cache]
    mem_limit: 160m
    healthcheck:
      test: [CMD, node, -e, "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 10s
      retries: 5
      start_period: 60s

  ronin-proxy:
    image: ${RONIN_PROXY_IMAGE:-ghcr.io/danimagnum/ronin-rush-proxy:<sha7>}
    profiles: [full]
    restart: unless-stopped
    environment:
      LISTEN_PORT: '8080'
      API_UPSTREAM: ronin:3000
      WEB_UPSTREAM: ronin-web:3000
      FRAME_ANCESTORS: ${RONIN_FRAME_ANCESTORS:-http://localhost:3000}
    read_only: true
    tmpfs: [/var/cache/nginx, /var/run, /etc/nginx/conf.d, /tmp]
    mem_limit: 48m
    ports:
      - '127.0.0.1:${RONIN_PORT:-3007}:8080'
    depends_on:
      ronin: { condition: service_healthy }
      ronin-web: { condition: service_healthy }
```

`/etc/nginx/conf.d` is a tmpfs because the nginx image renders `default.conf` from the template
at start. `CORE_JWKS_URL`, `CORE_ISSUER`, `CORE_AUDIENCE`, `KAFKA_BROKERS` and `PORT` come from
`*backend-env`.

## 3. Database and role

`postgres/init/01-service-databases.sh`: add `ronin` to the loop, and the password to the
`postgres` service:

```sh
for service in core spotkick dropzone payouts ops orchestrator ronin; do
```

```yaml
      RONIN_DB_PASSWORD: ${RONIN_DB_PASSWORD:-ronin-local}
```

The script only runs on an empty data volume. On an existing volume, run the same statements
once by hand (`CREATE ROLE ronin LOGIN PASSWORD …; CREATE DATABASE ronin OWNER ronin; REVOKE ALL
ON DATABASE ronin FROM PUBLIC; GRANT CONNECT ON DATABASE ronin TO ronin;`).

Ronin's migrations need no extension and no superuser (`gen_random_uuid()` is built in since
PostgreSQL 13). They run on API start under `pg_advisory_lock`, so several replicas can start
together.

## 4. Kafka topics

Produced by Ronin (key = round id, 3 partitions, envelope validated with
`@danigil/platform-contracts` 0.2.0):

| Topic | Notes |
|---|---|
| `ronin.round.started.v1` | |
| `ronin.bet.placed.v1` | Two facts per bet: the ledger shape and the engine shape (both in the 0.2.0 schema). Consumers counting bets must dedupe by `data.betId` / `data.bet.betId`. |
| `ronin.bet.cashed_out.v1` | Same two shapes. |
| `ronin.round.crashed.v1` | |
| `ronin.round.settled.v1` | |
| `system.health.reported.v1` | Shared topic; Ronin publishes every 30 s and on every status change, key = instance id. |

`KAFKA_AUTO_CREATE_TOPICS_ENABLE` is on in platform-infra, and Ronin's consumer also creates the
five Ronin topics with `KAFKA_PARTITIONS` at start. If auto-creation is ever turned off:

```sh
for t in ronin.round.started.v1 ronin.bet.placed.v1 ronin.bet.cashed_out.v1 ronin.round.crashed.v1 ronin.round.settled.v1; do
  docker compose exec kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server kafka:29092 \
    --create --if-not-exists --topic "$t" --partitions 3 --replication-factor 1
done
```

Consumer group: `ronin-rush-system-view` (`KAFKA_CLIENT_ID` + `-system-view`), reading the five
Ronin topics for the System view. ACLs, if they arrive: write on the six topics above, read and
group access for that group.

## 5. Core service client

Ronin settles through Core's **legacy** wallet routes (`/v1/wallet/...`, atomic capture with
`payoutAmount`), as `docs/migration-0.2.0.md` of the contracts package requires for Ronin. The
client therefore needs:

| Client id | Scopes |
|---|---|
| `ronin` | `wallet:legacy:read wallet:legacy:write` |

`rg:check` is optional (advisory; Core enforces responsible-gaming limits inside the hold
transaction anyway). Generic `wallet:read`/`wallet:write` do not grant the legacy routes.

**Core's seed script cannot create it today:** `pnpm db:seed` only creates `local-service`
(`wallet:read wallet:write accounts:write rg:check`). Two options:

- **Preferred:** extend Core's seed with an optional client, e.g. `LOCAL_SERVICE_CLIENTS=ronin:wallet:legacy:read,wallet:legacy:write`.
- **Interim:** insert the row with Core's own hash function, from a platform-core checkout:

  ```sh
  export RONIN_SECRET=$(openssl rand -hex 24)
  HASH=$(pnpm exec tsx -e "import('./packages/database/src/password').then(async m => console.log(await m.hashSecret(process.env.RONIN_SECRET)))")
  # psql only substitutes :'hash' in statements read from stdin or a file, not in -c.
  echo "INSERT INTO service_clients(id, secret_hash, scopes) VALUES ('ronin', :'hash', ARRAY['wallet:legacy:read','wallet:legacy:write']) ON CONFLICT (id) DO NOTHING;" \
    | psql "$CORE_DATABASE_URL" -v hash="$HASH"
  echo "CORE_CLIENT_SECRET=$RONIN_SECRET" >> .env.ronin   # never commit it
  ```

  This exact sequence was used against platform-core `71e2e50` built from source. Core accepts
  `Idempotency-Key` values matching `^[\w:.-]{8,128}$`; Ronin's keys (`ronin:hold:…`,
  `ronin:capture:…`, `ronin:release:…`) comply.

House account for `CORE_HOUSE_ACCOUNT_ID` (created by the seed):

```sql
SELECT id FROM accounts WHERE kind = 'house' AND currency = 'EUR';
```

## 6. Prometheus

`prometheus/prometheus.yml`, under the existing `services` job:

```yaml
      - targets: ['ronin:3000']
        labels: {service: ronin-rush}
```

Useful series: `ronin_bets_total` and `ronin_cashouts_total` (counted on the leader only, so
`sum()` across replicas is correct), `ronin_round_loop_latency_seconds{quantile}`,
`ronin_outbox_lag_seconds`, `ronin_outbox_rejected_total`, `ronin_platform_pending_settlements`,
`ronin_platform_oldest_settlement_seconds`, `ronin_core_failures_total`, `ronin_health_status`.

## 7. Helm / Argo CD

The API fits `helm/nestjs-service`. The web app and proxy do not (no NestJS probes, the proxy is
nginx), so either add them as plain Deployments or point an Argo CD Application at Ronin's own
chart (`deploy/helm/ronin-rush`, already serving `/`, `/api` and `/socket.io` on one Ingress).

```yaml
# helm/platform/values.yaml (API only, if nestjs-service is used)
ronin:
  enabled: true
  fullnameOverride: ronin
  image: {repository: ghcr.io/danimagnum/ronin-rush-api, tag: '<sha7>'}
  existingSecret: ronin-env          # CORE_CLIENT_SECRET, JWT_SECRET, DATABASE_URL
  env:
    SERVICE_NAME: ronin-rush
    PLATFORM_MODE: 'true'
    CORE_CLIENT_ID: ronin
    REDIS_NAMESPACE: ronin-platform
```

plus a `nestjs-service` dependency with `alias: ronin` and `condition: ronin.enabled` in
`helm/platform/Chart.yaml`.

## 8. NAS staging variant (`platform-staging`)

The NAS stack is not platform-infra's compose file as is. Observed on 2026-11-11:

- Every service shares the network namespace of `platform-staging_redis_1`, because TCP between
  containers on a bridge network times out on that NAS. Services talk over `127.0.0.1`.
- Published ports (on the Redis container): `3410→3000`, `3411→3001`, `3401→3002`, `3400→3003`,
  `3490→9000`. Ports 3000 to 3003 and 9000 are therefore taken inside the namespace.
- Kafka listens on `127.0.0.1:19092` only.

For Ronin inside that namespace:

```yaml
  ronin:
    image: ronin-rush-api:<sha7>        # loaded from the PC-built bundle (no GHCR pull on the NAS)
    network_mode: "service:redis"
    environment:
      PORT: '3021'
      DATABASE_URL: postgresql://ronin:<password>@127.0.0.1:5432/ronin
      REDIS_URL: redis://127.0.0.1:6379/3
      REDIS_NAMESPACE: ronin-staging
      KAFKA_BROKERS: 127.0.0.1:19092
      CORE_URL: http://127.0.0.1:<core-api port, inside the namespace>
      CORE_JWKS_URL: http://127.0.0.1:<core-api port>/.well-known/jwks.json
      # remaining variables as in section 9
    mem_limit: 320m
    healthcheck:
      test: [CMD, node, -e, "fetch('http://127.0.0.1:3021/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 10s
      retries: 5
      start_period: 300s                # cold start on the NAS: ~90 s of module loading (less now that Sentry loads only with a DSN)

  ronin-web:
    image: ronin-rush-web:<sha7>
    network_mode: "service:redis"
    environment: { PORT: '3020', HOSTNAME: 127.0.0.1 }
    mem_limit: 160m

  ronin-proxy:
    image: ronin-rush-proxy:<sha7>
    network_mode: "service:redis"
    environment:
      LISTEN_PORT: '3022'
      API_UPSTREAM: 127.0.0.1:3021
      WEB_UPSTREAM: 127.0.0.1:3020
      FRAME_ANCESTORS: https://danielgil.eu https://www.danielgil.eu
    mem_limit: 48m
```

On the Redis (anchor) service: `ports: ['127.0.0.1:3420:3022', '127.0.0.1:3421:3021']`. 3420
and 3421 were free on 2026-11-11, and 3310/3311 belong to the public demo. Check both again
before applying. Images reach the NAS the same way as the demo: `deploy/release.ps1` on the PC,
`scp -O`, SHA-256 check, `docker load` (see `docs/deploy-nas.md`).

## 9. Variables (example values, no secrets)

```env
# .env.ronin (platform-infra, local) — copy and fill; never commit real values
SERVICE_NAME=ronin-rush
PLATFORM_MODE=true
NODE_ENV=production
CORE_URL=http://core:3000
CORE_TOKEN_URL=                     # empty: CORE_URL/oauth/token
CORE_JWKS_URL=http://core:3000/.well-known/jwks.json
CORE_ISSUER=http://localhost:3001   # must equal Core's JWT_ISSUER (a URL)
CORE_AUDIENCE=core-api              # must equal the aud Core puts in user tokens (see 11)
CORE_CLIENT_ID=ronin
CORE_CLIENT_SECRET=<generated in section 5>
CORE_HOUSE_ACCOUNT_ID=<uuid from section 5>
CORE_CURRENCY=EUR
JWT_SECRET=<32+ random characters>  # required in production even in platform mode (bots' sessions)
KAFKA_BROKERS=kafka:29092
KAFKA_CLIENT_ID=ronin-rush
REDIS_NAMESPACE=ronin-platform
PORTAL_ORIGINS=http://localhost:3000
CORS_ORIGIN=http://localhost:3007
BOTS_COUNT=4
SENTRY_DSN=                         # empty: the Sentry SDK is not even loaded
```

NAS staging: the same, with `127.0.0.1` addresses from section 8, `REDIS_NAMESPACE=ronin-staging`,
`PORTAL_ORIGINS` and `CORS_ORIGIN` set to the staging portal and Ronin's staging origin.

## 10. Memory budget

Budget for the second instance on the NAS: **600 MB**. The NAS had about 1 GB available with the
current stacks running (2026-11-11).

| Container | Limit | Expected use |
|---|---|---|
| `ronin` (API) | 320 MB | to be measured (the standalone API on the NAS has a 384 MB limit) |
| `ronin-web` | 160 MB | to be measured |
| `ronin-proxy` | 48 MB | ~5 MB for nginx |
| **Total limits** | **528 MB** | |

No own Postgres, Redis or Kafka: the instance uses the staging ones (a database, a Redis
namespace and topics). Measure after 15 minutes of play with bots and one player:

```sh
sudo docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}' | grep -E 'NAME|ronin'
free -m
```

Rule agreed: if the sum goes over 600 MB, or `free -m` drops below about 150 MB available, stop
the instance and report before tuning.

## 11. Open points

- **Core audience.** platform-infra defaults `CORE_AUDIENCE` to `core-api`; Ronin verifies user
  tokens against exactly that value. Confirm it is the `aud` Core issues for player tokens.
- **Seed of the `ronin` client** (section 5): extend Core's seed, or use the interim SQL.
- **Portal hand-over.** In platform mode Ronin asks the embedding portal for renewed tokens over
  `postMessage` (`docs/platform-mode.md`). The portal side is not implemented yet; without it a
  player's session ends when the 10-minute token expires.
- **Core port inside `platform-staging`** for `CORE_URL` (section 8).
