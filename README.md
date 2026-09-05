# Bondzi Ghana — Backend

AI-powered WASSCE/BECE exam-prep backend. NestJS 11 · TypeORM 0.3 · PostgreSQL 15 · Redis 7 · BullMQ · Paystack · Anthropic Claude · OpenAI · Africa's Talking.

Canonical spec: [`docs/PassMaster_Backend_Engineering_Prompt.docx`](../docs/PassMaster_Backend_Engineering_Prompt.docx).

## Prerequisites

- Node.js 20 LTS
- Docker + Docker Compose (for local Postgres + Redis)
- A Paystack sandbox account (Ghana)
- Anthropic + OpenAI API keys
- Africa's Talking sandbox account (for SMS OTP)

## Local setup

```bash
# 1. Install deps
npm install

# 2. Start Postgres + Redis
docker compose up -d

# 3. Environment
cp .env.example .env
# fill in ANTHROPIC_API_KEY, OPENAI_API_KEY, PAYSTACK_*, AT_*, and JWT secrets.

# 4. Run migrations
npm run migration:run

# 5. Seed canonical data
npm run seed:subjects
npm run seed:prompts
npm run seed:admin      # creates the first superadmin from SEED_ADMIN_* env vars

# 6. Start the API (watch mode)
npm run start:dev
```

Swagger UI: <http://localhost:3000/docs>. Health probe: <http://localhost:3000/health>.

## Project structure

```
src/
├── main.ts                 # bootstrap, helmet, CORS, swagger, raw body for Paystack
├── app.module.ts           # wires config, throttler, BullMQ, TypeORM, feature modules
├── config/                 # registerAs configs + Joi validation schema
├── common/                 # decorators, filters, guards, interceptors, Redis client
├── database/               # TypeORM migrations + seed scripts
├── modules/
│   ├── auth/               # JWT, refresh rotation, OTP, Google OAuth
│   ├── users/              # profile, stats, progress
│   ├── subjects/           # subjects + topics (admin CRUD, student read)
│   ├── questions/          # question bank, past paper, adaptive, search, flagging
│   ├── exams/              # exam session lifecycle + answer submission
│   ├── srs/                # SM-2 spaced repetition (pure function + tests)
│   ├── explanations/       # AI explanation retrieval + regeneration
│   ├── ai/                 # Claude + OpenAI orchestration, cost tracking, budget guard
│   ├── subscriptions/      # Paystack initiate/verify/cancel + plan catalogue
│   ├── payments/           # Paystack webhook (HMAC + idempotency + 200-always)
│   ├── leaderboard/        # weekly top-100, Redis cached
│   ├── progress/           # user_subject_progress entity (used by exams)
│   ├── notifications/      # in-app + push/SMS queue dispatcher
│   ├── schools/            # [P2] entities only; licence flow ships with schools pilot
│   ├── admin/              # admin dashboard, flag review, AI usage, audit log
│   └── health/             # /health (Terminus: DB + Redis)
└── jobs/
    ├── ai-explanation.processor.ts   # BullMQ worker (concurrency 5)
    ├── notifications.processor.ts    # BullMQ worker for push/SMS/in-app
    ├── subscription-renewal.job.ts   # hourly cron, flips expired + notifies
    ├── leaderboard.job.ts            # weekly snapshot + hourly cache warm
    └── ai-budget-alert.job.ts        # 23:00 UTC daily spend alert
```

## Scripts

| Script                                                      | Purpose                                           |
| ----------------------------------------------------------- | ------------------------------------------------- |
| `npm run start:dev`                                         | Watch-mode server with hot reload                 |
| `npm run build`                                             | Compile TypeScript to `dist/`                     |
| `npm run start:prod`                                        | Run compiled output                               |
| `npm run migration:run`                                     | Apply pending TypeORM migrations                  |
| `npm run migration:generate src/database/migrations/<Name>` | Generate a migration from entity diff             |
| `npm run migration:revert`                                  | Roll back the last migration                      |
| `npm run seed:subjects`                                     | Idempotent upsert of canonical 14 WASSCE subjects |
| `npm run seed:admin`                                        | Upsert the initial superadmin user                |
| `npm run seed:prompts`                                      | Upsert versioned AI prompt templates              |
| `npm test`                                                  | Jest unit tests                                   |
| `npm run test:cov`                                          | Unit tests + coverage report                      |
| `npm run test:e2e`                                          | e2e tests (requires Postgres + Redis)             |
| `npm run lint`                                              | ESLint with auto-fix                              |

## Key architectural decisions

- **Refresh-token rotation** — every refresh invalidates the old token and issues a new family member. Reuse of a revoked token burns the entire family (theft detection).
- **Paystack webhook idempotency** — `payment_events.paystack_event_id` is UNIQUE. Duplicate deliveries insert-fail and short-circuit. The endpoint always returns `200` on authentic events.
- **`isCorrect` never leaks** — `toStudentQuestion()` in `modules/questions/serializers/question.serializer.ts` is the single serialiser for student responses. Covered by a regression test (`question.serializer.spec.ts`).
- **AI budget guard** — every Claude/OpenAI call checks both a per-user daily call limit and a global daily USD cap. Over-budget: serve cached content, fail safe, never block the student.
- **Async explanations** — wrong answer → BullMQ job → Claude Sonnet 4.6 (fallback OpenAI → static fallback). Client polls `/explanations/:qid` or sees cached `pending_explanation:{userId}:{qid}`.
- **SM-2 as a pure function** — `srs/utils/sm2.util.ts` has zero dependencies and is 100% unit-tested. `SrsService` only persists the function's output.
- **Graceful Redis degradation** — `RedisService` returns `null` on failure; callers fall back to DB. No crash when Redis is down.

## Deployment

```bash
docker build -t passmaster-backend .
```

The runtime image is Alpine-based, non-root, and includes a healthcheck. The production start command runs migrations automatically — bake `npm run migration:run && node dist/main.js` into your platform's start command if your deploy target doesn't call migrations explicitly.

## Phase roadmap

- **Phase 1 (ship)** — auth, exams, SRS, AI explanations, Paystack subscriptions, admin.
- **Phase 2 (build when revenue justifies)** — Schools licensing, AI chat tutor with SSE streaming, Nigeria expansion, teacher PDF reports, materialised analytics views.

## Security posture

- JWT access 15m, refresh 30d with rotation + family detection.
- Password hash: bcrypt cost 12. `passwordHash` column has `select: false` — only loaded explicitly when verifying.
- Global `ValidationPipe` with `whitelist: true, forbidNonWhitelisted: true`.
- Helmet enabled in production; CSP configurable.
- CORS: whitelist-only — never wildcard in production.
- Throttler: 30/10s short + 200/60s long globally; tighter per-endpoint caps on auth and OTP.
- Paystack webhook: HMAC-SHA512 signature verification + raw-body preservation + IP whitelisting at Cloudflare.
- Every admin mutation writes an `audit_log` row with previous + new values and IP.

See the full spec in [`docs/PassMaster_Backend_Engineering_Prompt.docx`](../docs/PassMaster_Backend_Engineering_Prompt.docx) §7 for the complete checklist.

<!-- Keep deploy linear going forward — update it with a squash instead of a merge next time:
git checkout deploy && git merge --squash origin/develop && git commit -m "sync: develop → deploy" -->
