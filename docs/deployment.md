# Deployment

RadioPilot runs as four containers on a single host: Redis, the API, the worker,
and Caddy (which terminates TLS, serves the built web app, and proxies the API).

This setup is deliberately host-agnostic. The same `docker-compose.yml` runs
unchanged on AWS Lightsail, an EC2 instance, Hetzner, Oracle Cloud, or any box
with Docker installed. Only the bill and the console differ.

## Why one host rather than four managed services

The worker holds a persistent MQTT subscription to PSK Reporter and keeps rolling
15-minute windows in memory. It cannot be a serverless function or a cron job, so
any platform-native option has to be an always-on container — and per-service
pricing then multiplies across API, worker, and Redis for what is a low-traffic
application. One small host is cheaper and simpler.

The other reason is Redis access patterns. The DX rarity baseline reads 24 hourly
buckets on every input refresh. On a *metered* Redis (Upstash, ElastiCache
Serverless) that volume is billed per operation and gets expensive fast. Running
Redis in a container next to the app makes those reads free.

## Choosing a host

| Option | Rough cost | Notes |
| --- | --- | --- |
| AWS Lightsail | $5–7/mo | Fixed price, bundled data transfer, static IP included. The sane AWS shape for this workload. |
| AWS EC2 (t4g.small) | ~$12/mo + $3.60 IPv4 | More levers, more cost. Only worth it if you want to reserve capacity. |
| AWS Fargate + ElastiCache | $30+/mo | "Proper" AWS. Several times the cost for one user, plus metered Redis. |
| Hetzner CX22 | ~€4/mo | Cheapest reliable option; 2 vCPU / 4 GB. |
| Oracle Cloud Always Free | $0 | Genuinely free ARM capacity, when available. Free accounts can be reclaimed. |

Sizing: 1 GB RAM is the practical floor and 2 GB is comfortable. The worker's PSK
buffer is capped (see `maxRetainedReports` in `apps/worker/src/sources/psk-reporter.ts`)
but the cap is a backstop, not a target.

Note for AWS specifically: accounts created after 15 July 2025 get credits that
expire after six months rather than the old 12-month free tier, so budget for the
instance from the start.

## First deploy

1. Create the host and install Docker. Open ports 80 and 443.
2. Point your domain's A/AAAA record at the host's IP. Caddy needs this to
   resolve before it can obtain a certificate.
3. Clone the repository onto the host.
4. Configure the environment:

   ```sh
   cp .env.example .env
   ./scripts/hash-debug-password.sh   # prints a bcrypt hash
   ```

   Edit `.env` and set at minimum `SITE_ADDRESS`, `DEBUG_PASSWORD_HASH`,
   `HOME_GRID` and `PSK_REFERENCE_GRID`. If you set `SPOT_SOURCE=telnet` you must
   also set `DX_CLUSTER_CALLSIGN` to your own callsign.

5. Start it:

   ```sh
   docker compose up -d --build
   ```

6. Check it came up:

   ```sh
   curl https://your-domain/health
   docker compose logs -f worker
   ```

   `/health` reports `starting` until the first spots land, then `ok`.

## Updating

```sh
git pull
docker compose up -d --build
```

Redis data lives in the `redis-data` volume and survives rebuilds. Everything in
it is re-derivable from upstream sources, so losing it costs you the rolling
baselines, not correctness.

## Routing and access

Caddy serves the app at `/`, proxies `/api/*` and `/health` to the API, and puts
HTTP basic auth in front of `/debug/*`. Because the app and API share an origin,
the web bundle is built with an empty `VITE_API_BASE_URL` and issues relative
requests — there is no cross-origin traffic and the API's CORS allowlist is not
exercised.

## Known follow-ups

- Both services start through `tsx`, because `@radio-pilot/shared` exports raw
  TypeScript. The compiled `dist/` output is currently a typecheck artefact only.
  Baking `node_modules` into the image keeps this safe, but compiling the shared
  package and running plain `node` would be leaner.
- There is no CI. The image build runs `tsc` for the API and worker, so a type
  error fails the build rather than the container, but tests are not run.
