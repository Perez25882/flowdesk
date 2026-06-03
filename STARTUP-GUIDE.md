# Flowdesk — Startup Guide

## Prerequisites

| Requirement | Version | Purpose |
|-------------|---------|---------|
| Node.js | `>= 20` | Runtime for API & web app |
| pnpm | `>= 9` | Package manager (enforced via `corepack`) |
| Docker + Docker Compose | Any recent | PostgreSQL 15 & Redis 7 |
| Git | Any | Clone & version control |

### Install pnpm via corepack

```bash
# pnpm is the required package manager for this project
corepack enable
corepack prepare pnpm@latest --activate
pnpm --version   # should print >= 9.12.0
```

> **Windows Note:** If `corepack pnpm` fails with "command not found", create the proxy manually:
> ```powershell
> Set-Content -Path C:\Users\<You>\AppData\Local\nvm\pnpm.cmd -Value "@echo off`ncorepack pnpm %*"
> ```

---

## 1. Infrastructure (PostgreSQL + Redis)

The project includes a `docker-compose.yml` with both services.

```bash
# From the project root
docker compose up -d

# Verify
docker ps
# You should see:
#   flowdesk-postgres   5432/tcp
#   flowdesk-redis      6379/tcp
```

Connection strings (default):
- **PostgreSQL:** `postgresql://flowdesk:flowdesk@localhost:5432/flowdesk`
- **Redis:** `redis://localhost:6379`

---

## 2. Environment Variables

Create an `.env` file in `apps/api/.env`.

**Required variables:**

```bash
# Database & Cache
DATABASE_URL=postgresql://flowdesk:flowdesk@localhost:5432/flowdesk
REDIS_URL=redis://localhost:6379

# Auth secrets (generate strong random strings, min 32 chars)
JWT_SECRET=dummy_jwt_secret_change_in_production_32chars
JWT_REFRESH_SECRET=dummy_refresh_secret_change_in_production_32chars

# Meta WhatsApp Business API
META_APP_ID=your_meta_app_id
META_APP_SECRET=dummy_meta_app_secret_with_at_least_32_chars
META_VERIFY_TOKEN=your_webhook_verify_token
META_WEBHOOK_SECRET=dummy_webhook_secret_with_at_least_32_chars
META_API_VERSION=v20.0
META_PHONE_NUMBER_ID=your_wa_phone_number_id
META_ACCESS_TOKEN=your_system_user_access_token

# AI Classification (Claude Haiku fallback)
ANTHROPIC_API_KEY=your_anthropic_api_key

# File Storage (S3-compatible)
AWS_ACCESS_KEY_ID=your_aws_key
AWS_SECRET_ACCESS_KEY=your_aws_secret
AWS_REGION=eu-west-1
AWS_S3_BUCKET=flowdesk-uploads

# Email (staff invites, alerts)
RESEND_API_KEY=your_resend_api_key
RESEND_FROM_EMAIL=notifications@yourdomain.com

# Payments (Paystack)
PAYSTACK_SECRET_KEY=sk_test_...
PAYSTACK_PUBLIC_KEY=pk_test_...

# App config
NODE_ENV=development
PORT=3000
FRONTEND_URL=http://localhost:5173

# Optional
# SENTRY_DSN=        # uncomment and set in production
LOG_LEVEL=info
HAIKU_FALLBACK_ENABLED=true
HAIKU_CONFIDENCE_THRESHOLD=0.75
```

> **Quick local dev:** Many external-service keys (Meta, AWS, Paystack, Anthropic) are only needed for production features. For local dashboard testing, you can use dummy values for optional services, but **JWT_SECRET**, **JWT_REFRESH_SECRET**, **DATABASE_URL**, and **REDIS_URL** are mandatory.

---

## 3. Install Dependencies

```bash
# From the repository root
corepack pnpm install
```

This installs dependencies for the monorepo (root, `apps/api`, `apps/web`, `packages/shared`) using pnpm workspaces.

---

## 4. Database Setup

### 4.1 Generate Prisma Client

The schema is at `prisma/schema.prisma` (copied from `docs/schema.prisma`).

```bash
# From repository root
corepack pnpm prisma generate --schema ./prisma/schema.prisma
```

### 4.2 Run Migrations

```bash
corepack pnpm prisma migrate dev --schema ./prisma/schema.prisma --name init
```

> This creates the database tables based on the Prisma schema. On first run it will create the database and apply all migrations.

---

## 5. Build the Shared Package

The API references `packages/shared`. Build it first so TypeScript project references resolve:

```bash
cd packages/shared
corepack pnpm build
```

---

## 6. Start the Applications

You need **two terminal sessions** (or use `turbo` — see below).

### Option A: Separate Terminals (Recommended for debugging)

**Terminal 1 — API Server:**
```bash
cd apps/api
corepack pnpm dev
# Runs on PORT=3000 (from .env)
# Logs: "Flowdesk API server started"
```

**Terminal 2 — Web Dashboard:**
```bash
cd apps/web
corepack pnpm dev
# Vite dev server on http://localhost:5173
```

### Option B: Turbo (runs both in one command)

```bash
# From repository root
corepack pnpm dev
```

> This runs `turbo run dev` which starts both apps concurrently based on the pipeline in `turbo.json`.

---

## 7. Verify Everything is Running

| Check | URL / Command | Expected Result |
|-------|-------------|-----------------|
| API Health | `curl http://localhost:3000/health` | `{"status":"ok","db":"connected","redis":"connected",...}` |
| API Docs | `http://localhost:3000/docs` | Swagger UI (dev only) |
| Web Dashboard | `http://localhost:5173` | Login page loads |
| PostgreSQL | `docker exec flowdesk-postgres pg_isready -U flowdesk` | `accepting connections` |
| Redis | `docker exec flowdesk-redis redis-cli ping` | `PONG` |

---

## 8. First-Time Login

The app uses **OTP-based phone authentication**.

1. Open `http://localhost:5173`
2. Enter a phone number in international format: `233XXXXXXXXX`
3. Request OTP — in development, the OTP is logged to the API console (or use the mock OTP endpoint if implemented)
4. Enter the OTP to authenticate
5. You are redirected to the Dashboard

---

## Common Issues

### `pnpm: command not found`
Run `corepack enable` then `corepack pnpm <command>` instead of bare `pnpm`.

### Prisma errors like "Namespace 'Prisma' has no exported member 'X'"
Regenerate the client:
```bash
corepack pnpm prisma generate --schema ./prisma/schema.prisma
```

### Type errors in existing files (`exactOptionalPropertyTypes`)
The project uses strict TypeScript settings. Some legacy files have pre-existing type mismatches. They do not prevent the app from running via `tsx` (API) or `vite` (web), but you may see them during `tsc --noEmit`.

### Web module resolution errors (`Cannot find module '@/hooks/...'`)
Ensure `tsconfig.base.json` includes the path alias:
```json
"paths": {
  "@/*": ["apps/web/src/*"]
}
```
Vite handles this at runtime; TypeScript needs it for type-checking.

---

## Project Structure Summary

```
flowdesk/
├── apps/
│   ├── api/           # Fastify backend (port 3000)
│   │   ├── src/
│   │   │   ├── modules/   # orders, products, customers, payments, messages, settings, staff, auth, webhook
│   │   │   ├── services/  # SSE, WhatsApp outbound, intent classification
│   │   │   ├── workers/   # BullMQ message processor
│   │   │   └── server.ts
│   │   └── .env
│   └── web/           # React + Vite frontend (port 5173)
│       ├── src/
│       │   ├── pages/     # Dashboard, Orders, Customers, Products, Payments, Messages, Settings, Staff, Login
│       │   ├── hooks/     # React Query hooks (useAuth, useOrders, useCustomers, etc.)
│       │   └── components/
│       └── vite.config.ts
├── packages/
│   └── shared/        # Shared types & utilities
├── prisma/
│   └── schema.prisma  # Database schema
├── docker-compose.yml
└── package.json       # Workspace root
```

---

## Production Build

```bash
# API
cd apps/api
corepack pnpm build    # tsc --build -> dist/
corepack pnpm start    # node dist/server.js

# Web
cd apps/web
corepack pnpm build    # vite build -> dist/
corepack pnpm preview  # vite preview --host
```
