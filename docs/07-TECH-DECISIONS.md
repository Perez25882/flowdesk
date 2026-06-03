# Flowdesk — Technology Decision Log
**Purpose:** Every significant technology choice documented with its rationale.  
**Rule:** Before changing any decision in this log, document why. Don't change the stack on a whim.

---

## Backend Runtime: Node.js 20 LTS

**Decision:** Node.js 20 LTS  
**Alternatives considered:** Bun, Deno, Python (FastAPI)  
**Rationale:**
- Existing environment already running Node.js via nvm on the AWS EC2 instance
- Mature ecosystem for WhatsApp Business API integrations
- BullMQ (best-in-class job queue for this use case) is Node.js native
- Event-driven architecture suits webhook processing patterns
- No operational risk of switching runtime mid-project
- LTS version — supported until April 2026

**Verdict:** Do not change.

---

## Web Framework: Fastify 4

**Decision:** Fastify 4  
**Alternatives considered:** Express, Hono, Elysia  
**Rationale:**
- 2–3x higher throughput than Express on the same hardware — matters for webhook processing
- Built-in JSON schema validation (Ajv-based) — can derive from Zod schemas
- Plugin architecture is cleaner than Express middleware
- First-class TypeScript support
- @fastify/sensible handles common HTTP cases out of the box
- Swagger integration via @fastify/swagger — automatic API docs
- Same learning curve as Express for someone who knows Express

**Verdict:** Do not change. If Express familiarity is an argument, Express's performance ceiling is the counter-argument.

---

## ORM: Prisma 5

**Decision:** Prisma 5  
**Alternatives considered:** Drizzle, TypeORM, Kysely, raw SQL  
**Rationale:**
- Type-safe query builder with auto-generated types from schema
- Migration system is clean — schema-first, version-controlled
- Prisma Studio useful for manual data inspection during development
- Soft delete middleware available via Prisma extension
- Strong community, well-documented
- Drizzle is a valid alternative but smaller ecosystem; Prisma's stability wins for a production system

**Trade-offs:** Prisma can have N+1 query issues if relations are not loaded carefully. Solution: explicit `include` in repository functions, never lazy loading in loops.

**Verdict:** Do not change without a strong performance argument backed by benchmark data.

---

## Database: PostgreSQL 15

**Decision:** PostgreSQL 15  
**Alternatives considered:** MySQL, SQLite (dev only), MongoDB  
**Rationale:**
- Relational data model — orders have items, items have products, payments link to orders and customers. JOIN-heavy queries are natural.
- JSONB for flexible metadata (message metadata, reply template overrides) without a separate document DB
- Full ACID compliance — critical for payment and stock operations
- `uuid_generate_v4()` and `CUID` for IDs
- Mature, battle-tested, runs on existing EC2 instance
- PostgreSQL 15 has improved partitioning and performance over older versions

**Verdict:** Do not change.

---

## Job Queue: BullMQ 5 + Redis 7

**Decision:** BullMQ 5 backed by Redis 7  
**Alternatives considered:** Inngest, Temporal, AWS SQS, pg-boss (PostgreSQL-based)  
**Rationale:**
- Message capture → processing is the core reliability concern. BullMQ's job persistence in Redis ensures zero message loss even if the processing server crashes.
- Retry strategies, delay, priority, rate limiting — all built in
- Bull Board provides a management UI for inspecting queues and failed jobs
- pg-boss was considered (simpler, one less infrastructure dependency) but BullMQ's performance and features win
- AWS SQS would add complexity and cost for MVP
- Inngest/Temporal are valuable but overkill for MVP scope

**Redis requirement:** BullMQ requires Redis to work. Redis is also used for caching. Two separate client connections are needed (BullMQ requirement).

**Verdict:** Do not change the queue solution. Redis dependency is non-negotiable.

---

## Intent Classification: Rule Engine + Claude Haiku

**Decision:** Two-stage classification  
**Alternatives considered:** Fine-tuned BERT model, GPT-4o for all, Groq Llama  
**Rationale:**
- Rule engine handles 80%+ of real SME messages with ≥0.75 confidence at zero cost and <200ms latency
- Claude Haiku handles edge cases: Twi-English mix, ambiguous phrasing, unusual sentence structure
- Haiku is the cheapest capable model at $0.00025/1K input tokens — a single classification costs <$0.001
- Results cached in Redis for 24hrs — the same ambiguous message won't cost twice
- Groq Llama was a previous recommendation for agentic tasks but Haiku's structured output reliability is better for this classification use case
- GPT-4o is 100x the cost for marginal improvement in this domain — not justified

**Cost analysis at scale:**
- 1,000 businesses × 100 messages/day = 100,000 messages/day
- If 20% need Haiku: 20,000 Haiku calls × $0.001 = $20/day
- With 24hr cache: realistically <$10/day
- Covered by subscription revenue at any scale above 100 businesses

**Verdict:** Do not replace with a heavier model. The rule engine is the primary path. Haiku is the safety net.

---

## Real-Time: Server-Sent Events (SSE)

**Decision:** Server-Sent Events  
**Alternatives considered:** WebSockets, Socket.io, Long polling, Polling  
**Rationale:**
- Dashboard updates are one-directional: server → browser. The browser never needs to push real-time data to the server (button clicks use regular REST endpoints).
- SSE is simpler than WebSockets for one-directional use cases — no handshake protocol, native browser support, automatic reconnection built into the EventSource API
- WebSockets would add bidirectional complexity we don't need
- Socket.io adds a dependency and its own reconnection/namespace logic
- Long polling is simpler to implement but creates thundering herd on reconnect
- SSE works through HTTP/1.1 proxies; WebSockets sometimes require proxy configuration

**Trade-off:** SSE connections are persistent. On a single EC2 instance with 1000 concurrent businesses having SSE connections, that's up to 1000 open HTTP connections. Nginx and Fastify handle this well. When scaling to multiple instances (ECS), a shared pub/sub layer (Redis pub/sub) will route SSE events to the correct instance. This is designed-in from day one.

**Verdict:** Do not switch to WebSockets unless there is a clear bidirectional real-time requirement.

---

## Frontend: React 18 + Vite + shadcn/ui

**Decision:** React 18 + Vite + shadcn/ui + Tailwind  
**Alternatives considered:** Next.js, Remix, SvelteKit, Vue  
**Rationale:**
- Existing stack — no context switching
- Vite's HMR and build speed make development fast
- shadcn/ui gives production-quality accessible components without fighting a design system
- Tailwind utility classes work well with shadcn's component patterns
- React 18 Concurrent features (Suspense, useTransition) improve dashboard responsiveness
- Next.js adds SSR complexity that isn't needed — this is an authenticated dashboard, not a public site
- Remix would be a valid choice but adds learning curve without sufficient benefit for this use case

**Verdict:** Do not change.

---

## Auth: JWT + Refresh Token Rotation

**Decision:** Stateless JWT access tokens with stateful refresh tokens  
**Alternatives considered:** Sessions + cookies, Clerk, Auth0, Supabase Auth  
**Rationale:**
- JWT access tokens (15 min) are stateless — no DB lookup on every request, scales horizontally
- Refresh tokens stored in DB (sessions table) — can be invalidated on logout or security event
- Refresh rotation: every refresh call issues new pair and invalidates old refresh token — limits stolen token exposure
- No external auth provider dependency — no vendor lock-in, no additional cost, full control
- Clerk/Auth0 solve real problems (MFA, social login, user management UI) but add a $50–$200/month cost and vendor dependency that isn't justified at MVP
- Cookie vs Authorization header: using `Authorization: Bearer` header removes CSRF attack surface entirely

**Verdict:** Do not add an external auth provider unless there is a specific feature gap (e.g., MFA requirement from enterprise customers).

---

## Billing: Paystack

**Decision:** Paystack  
**Alternatives considered:** Stripe, Flutterwave, Hubtel  
**Rationale:**
- Paystack has native MoMo support for Ghana (MTN, Vodafone, AirtelTigo) — the target market
- Local bank account settlement in Ghana Cedis
- Recurring billing API available
- Excellent developer documentation
- Paystack is already Ghana's dominant payment processor for SaaS
- Stripe does not support Ghana-issued cards or MoMo natively
- Flutterwave is a valid alternative but Paystack has stronger Ghana market penetration and documentation

**Verdict:** Do not change. Stripe is not a viable alternative for the Ghana market without a separate MoMo integration layer.

---

## Storage: AWS S3 (af-south-1)

**Decision:** AWS S3, Africa (Cape Town) region  
**Alternatives considered:** Cloudflare R2, DigitalOcean Spaces, Cloudinary  
**Rationale:**
- MoMo screenshots need secure, durable storage — S3 is the industry standard
- af-south-1 (Cape Town) is the closest AWS region to Ghana, minimizing latency for uploads
- Pre-signed URLs for direct uploads from browser — no proxying through our API server
- Lifecycle policies can expire old screenshots automatically
- Cloudflare R2 is a valid and cheaper alternative but requires Cloudflare account setup and has less mature SDK — acceptable trade-off in Phase 2
- Cloudinary adds image transformation features (thumbnails) but at higher cost

**Verdict:** R2 is acceptable in Phase 2 for cost optimization. S3 for MVP.

---

## Infrastructure: AWS EC2 + Cloudflare

**Decision:** Single EC2 instance + Cloudflare free tier  
**Alternatives considered:** Railway, Render, Vercel, DigitalOcean  
**Rationale:**
- Existing EC2 server is already running and configured
- Zero infrastructure migration cost
- Cloudflare free tier provides: DDoS protection, SSL termination, CDN, bot protection — all for free
- PM2 provides process management and basic monitoring without additional tooling
- Railway/Render are excellent choices for new projects but migrating an existing server adds risk without benefit at this stage

**Phase 2 migration path:** When >100 businesses are active → containerize with Docker → move to ECS Fargate for auto-scaling. The application is designed stateless from day one to make this migration straightforward.

**Verdict:** Do not migrate infrastructure until Phase 2 criteria are met.

---

## Monorepo: pnpm + Turborepo

**Decision:** pnpm workspaces + Turborepo  
**Alternatives considered:** Nx, Yarn workspaces, npm workspaces  
**Rationale:**
- pnpm is significantly faster than npm/yarn for large dependency trees, uses less disk space
- Turborepo handles task caching and pipeline ordering with minimal config
- Both apps (api, web) share types from packages/shared — monorepo makes this clean
- Nx is more powerful but overkill for a two-app monorepo
- Learning curve is minimal — Turborepo is configuration-driven

**Verdict:** Do not change.
