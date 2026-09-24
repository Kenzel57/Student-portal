# Student Portal — Pipeline

This is the Week 1 foundation: infrastructure + CI/CD, wired end-to-end and
provable before any real service logic is built.

## What's in here

| Piece | File | Role |
|---|---|---|
| Database | `docker-compose.yml` → `postgres` | One Postgres instance, one schema per service |
| Schema setup | `init-db/01-schemas.sql` | Creates `auth`, `student`, `transcript`, `pastpapers` schemas + per-service roles |
| Connection pooling | `docker-compose.yml` → `pgbouncer` | Sits in front of Postgres — critical for surviving 1,000 concurrent connections |
| Cache / sessions | `docker-compose.yml` → `redis` | |
| Event bus | `docker-compose.yml` → `rabbitmq` | Management UI at `:15672` |
| API Gateway | `docker-compose.yml` → `gateway` (Traefik) | Single entry point; routes by path/label |
| Proof-of-pipeline | `services/health-service/` | Minimal service that proves code → container → gateway routing works |
| CI | `.github/workflows/ci.yml` | Builds + tests each service, then runs a full `docker compose` smoke test |
| Provisioning | `setup-oracle-cloud.sh` | One-shot script to stand this up on your Oracle Cloud Always Free instance |

## Run it locally

```bash
cp .env.example .env
docker compose up -d --build
curl http://localhost/health
```

You should get back:
```json
{"status":"ok","service":"health-service","timestamp":"..."}
```

That confirms the full chain: gateway received the request, routed it by
the `PathPrefix(/health)` label, and the container answered — the same
path every real service (Auth, Student, Transcript, Past Papers) will use.

## Run it on Oracle Cloud

```bash
chmod +x setup-oracle-cloud.sh
./setup-oracle-cloud.sh https://github.com/<you>/student-portal.git
```

## Adding your first real service (Auth, Week 1 priority)

1. Create `services/auth-service/` with its own `Dockerfile` and `package.json`, same shape as `health-service/`.
2. Add it to `docker-compose.yml` with a Traefik label, e.g.:
   ```yaml
   labels:
     - "traefik.enable=true"
     - "traefik.http.routers.auth.rule=PathPrefix(`/auth`)"
     - "traefik.http.services.auth.loadbalancer.server.port=3000"
   ```
3. Add its schema role from `init-db/01-schemas.sql` (`auth_svc`) as its `DATABASE_URL`, pointed at **PgBouncer** (`pgbouncer:6432`), not Postgres directly.
4. Add `auth-service` to the `matrix.service` list in `.github/workflows/ci.yml`.

Repeat this same four-step pattern for Student, Transcript, and Past
Papers — it's the same shape every time, which is why the pipeline is
worth getting right first.

## Load testing (Week 3+)

Scale any service with Compose directly — no Kubernetes required to prove
the 1,000-concurrent claim:
```bash
docker compose up -d --scale auth-service=3 --scale student-service=3
```
Then point `k6` at the Gateway (`http://<oracle-ip>/`), not at individual
services — that's what proves the whole pipeline, not just one container.

## Fixing "Error response from daemon" on Windows

If `docker compose logs gateway` shows repeated lines like:
```
ERR Failed to retrieve information of the docker client and server host error="Error response from daemon: " providerName=docker
```
this is a known Docker Desktop for Windows issue — mounting
`/var/run/docker.sock` into a container doesn't reliably work on that
platform. The fix is to have Traefik talk to Docker over TCP instead:

1. Open **Docker Desktop → Settings → General**, enable **"Expose daemon
   on tcp://localhost:2375 without TLS"**, click **Apply & Restart**.
2. In your `.env` file, uncomment this line:
   ```
   DOCKER_ENDPOINT=tcp://host.docker.internal:2375
   ```
3. Restart the pipeline so the change takes effect:
   ```powershell
   docker compose down
   docker compose up -d
   ```
4. Check the dashboard again at http://localhost:8080/dashboard/ — you
   should now see a `health` router listed alongside the internal ones.
5. Confirm routing works:
   ```powershell
   curl http://localhost/health
   ```

This only affects local Windows development. When you deploy to the
Oracle Cloud Ubuntu instance later, the standard socket mount works
fine as-is — this override isn't needed there.

## Security notes before this goes anywhere public

- The Traefik dashboard (`--api.insecure=true`) is open in this config for
  local dev convenience only. Disable it or put it behind auth before
  deploying anywhere reachable from the internet.
- Replace every `_dev_pw` placeholder in `init-db/01-schemas.sql` and
  `.env.example` with real, unique secrets before deploying.
