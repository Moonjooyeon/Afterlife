# Lightsail production

Run `docker compose -f docker-compose.prd.yml ...` in `/home/ubuntu/Afterlife`.
`web` joins `levelup-net` and the application network; `backend` and `db` join only
the application network. PostgreSQL has no published port. The shared proxy uses
`afterlife-web-1:80`; the frontend proxy uses `backend:3000`.

Set `AF_DB_PASSWORD` to a random hex string and keep `.env` mode 600. Compose
provides the backend DATABASE_URL. Preserve SESSION_SECRET across restarts.
Install the `unread` certificate/key at `secrets/toss/unread_public.crt` and
`secrets/toss/unread_private.key`, mode 600. They are mounted read-only and excluded
from Git and Docker build contexts.

Enable TOSS_LOGIN_ENABLED, TOSS_IAP_ENABLED and TICKET_ENABLED together only after
certificate verification; keep TICKET_TEST_PASS_ENABLED=false and free credits 0.
Set TOSS_IAP_SKU to the console product ID. The server owns price and credit count;
client amounts are ignored. Every grant checks the Toss order and userKey over
mTLS. Grants are atomic and order-idempotent. Refund status is checked before AI
generation; refunded passes are revoked. Failed verification blocks consumption.

## Migration

1. Back up `.env`, Compose and nginx config outside the repository. Tag current
   app images for rollback. Build new images while the old containers run.
2. Start only `db`, then create a separate `afterlife_test` database. Execute
   `backend/integration.test.js` with its DATABASE_URL ending `/afterlife_test`.
   Tests never clear data and generate unique test identifiers.
3. Stop backend; use Python sqlite3's backup API to create a consistent SQLite
   backup under `runtime`. Keep an additional copy outside the application.
4. Run `docker compose -f docker-compose.prd.yml run --rm --no-deps backend
   node backend/migrate-sqlite.js /app/runtime/pre-postgres.sqlite`.
   Do this before starting the new backend: migration refuses nonempty target
   tables, copies all eight tables in one transaction and checks row counts.
5. Start backend and web. Verify Compose health, HTTPS health/config and SQL row
   counts before considering the deployment complete.

Never run `down -v`: it destroys the database volume. Rollback before accepting
new writes can restore the prior config/images and SQLite backup. After new
writes, preserve PostgreSQL and reconcile those writes before rolling back.

## Backups and tests

Use `docker compose -f docker-compose.prd.yml exec -T db pg_dump -U afterlife
-d afterlife -Fc > backup.dump` with restrictive file permissions. Store a copy
off-server through the operator's backup system. Test restores regularly.

Local contract tests: `node --test backend/integration.test.js` (Node 22.13+).
PostgreSQL tests require a dedicated *_test database and cover concurrent grants,
credit exhaustion, refund revocation and generation locks.

The browser cannot complete Toss login or purchases outside the Toss app. Build
the .ait bundle with VITE_API_BASE_URL=https://afterlife.ashwoodfriends.com and
test with a real Toss account. A successful TLS probe with an invalid access token
verifies transport only; it is not an end-to-end login or payment test.

## Audit operations

Set a random `AUDIT_LOG_TOKEN` in the server `.env` (never in frontend/VITE
variables). `GET /api/v1/audit/recent?limit=100` accepts `x-audit-token` or
`Authorization: Bearer` with this operator token; missing/invalid tokens return
403. The limit is an integer clamped to 1–500. Responses include event/user
identity, metadata and timestamp, but omit IP/User-Agent hashes.

`POST /api/v1/audit/client-error` requires an authenticated user session and
records `client_report_error`. Only bounded kind/name/message/phase/reportMode
fields are stored; known credential patterns are redacted. The frontend reports
generation failures and uncaught errors best-effort, at most once per 5 seconds.
Telemetry failures do not interfere with the user flow.
