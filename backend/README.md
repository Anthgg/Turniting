# Turniting backend

NestJS is the application's API boundary. It owns PostgreSQL access through Prisma and calls the FastAPI service through `AI_SERVICE_URL`.

## Local setup

Use Node.js 22 LTS. Copy `.env.example` to `.env`, set local PostgreSQL URLs for `DATABASE_URL` and `DIRECT_URL`, and start the API from this directory:

```bash
npm ci
npm run prisma:generate
npm run prisma:migrate:dev
npm run start:dev
```

For local Docker Compose, run `npm run start:with-migrations` after the PostgreSQL health check succeeds. The command applies checked-in migrations with `prisma migrate deploy` before starting NestJS. Production release automation should run `npm run prisma:migrate:deploy` once before routing traffic; the default container command starts the API without running migrations on every Cloud Run instance.

The local AI URL is `http://localhost:8000`. In Docker Compose, set `AI_SERVICE_URL=http://ai-service:8000`; service-to-service traffic must use the Compose service name.

## Endpoints

- `GET /api/health` reports backend process health.
- `GET /api/health/db` runs `SELECT 1` through Prisma.
- `GET /api/health/ai` calls FastAPI's `/health` endpoint.
- `GET /api/docs` serves the OpenAPI UI.

AI requests have a configurable timeout. `AI_SERVICE_AUTH_MODE=none` is intended for local development. Set `google-id-token` when calling a private Cloud Run AI service; the backend obtains a short-lived identity token from the runtime's Google credentials and does not store a token or key.

## Database

The Prisma schema pins the project to Prisma ORM 6.x because this foundation uses `DIRECT_URL` in the datasource for direct migration connections. `DATABASE_URL` is used by the application runtime; `DIRECT_URL` is intended for migrations, including Supabase setups that use a pooled runtime URL. Supply actual connection URLs from the target environment rather than inferring a Supabase pooler host.

Run `npm run prisma:migrate:deploy` in a deployment environment after configuring both URLs. The initial migration creates only `User`, `Document`, and `Analysis`.

## Checks

```bash
npm run lint
npm run test
npm run test:e2e
npm run build
```
