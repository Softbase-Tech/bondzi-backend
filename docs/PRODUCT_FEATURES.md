# Bondzi — Student Features & AI Platform

A product + engineering reference for the student-facing surface of the Bondzi
backend (NestJS + Postgres/pgvector + Redis + BullMQ, AI on AWS Bedrock).

It covers **what each feature is**, **how it's achieved**, **the engineering
considerations**, and **the "wow factors"** that make it a real product rather
than a quiz app — the layered entitlement economy, the cost-governed AI factory,
and the syllabus-grounded RAG that keeps generated content honest to the WAEC
curriculum.

> All quota numbers below are the **seed defaults** (migration
> `1960000000000-EntitlementMatrix.ts`). Every one is **admin-editable at
> runtime**, so live values may differ. Prices are per 1M tokens
> (`ai-cost.util.ts`).

---

## Table of contents

1. [The product in one page](#1-the-product-in-one-page)
2. [The entitlement engine (the spine)](#2-the-entitlement-engine-the-spine)
3. [Feature catalogue](#3-feature-catalogue)
   - [3.1 Past Papers — Core subjects](#31-past-papers--core-subjects)
   - [3.2 Past Papers — Elective subjects](#32-past-papers--elective-subjects)
   - [3.3 Level Tests](#33-level-tests)
   - [3.4 Mock Exams](#34-mock-exams)
   - [3.5 AI Explanations](#35-ai-explanations)
   - [3.6 AI Weakness Narratives](#36-ai-weakness-narratives)
   - [3.7 AI Study Review (AI Insight)](#37-ai-study-review-ai-insight)
   - [3.8 Post-exam AI Breakdown (deferred)](#38-post-exam-ai-breakdown-deferred)
4. [The AI generation platform](#4-the-ai-generation-platform)
5. [Wow factors](#5-wow-factors)
6. [Quick reference](#6-quick-reference)
7. [Known caveats & deferred work](#7-known-caveats--deferred-work)

---

## 1. The product in one page

Bondzi prepares Ghanaian secondary-school students for the **WAEC** exams —
**BECE** (junior high), **WASSCE** (senior high), and **NOVDEC** (the private
re-sit). The student surface is built from three "quiz modes" and four AI
features, all gated by a per-tier entitlement economy:

| Layer | What the student gets |
|---|---|
| **Practice from real exams** | Past Papers (core = always free; elective = metered) |
| **AI-authored practice** | Level Tests (form-level, syllabus-mapped), Mock Exams (timed 3-hour simulation) |
| **AI that teaches** | Per-question Explanations, Weakness Narratives, a full Study Review |

Three tiers — **Free**, **Plus** (one-time lifetime unlock), **Pro** (recurring)
— entitle different amounts of each. Entitlements are scoped **per exam level**:
Plus on WASSCE does not cover BECE.

The design principle throughout: **free where the marginal cost is ~zero (serving
stored past-paper questions), metered where it costs money (every AI token)**, and
never let a bad or off-syllabus AI answer reach a student.

---

## 2. The entitlement engine (the spine)

Every metered feature runs through one gate, so the whole product's business
rules live in **data**, not scattered `if` statements.

### The model

- **Tiers** — `AccountType` enum: `free | plus | pro` (`src/common/types/enums.ts`).
  Entitlements are per **(user, exam level)**; Plus is a one-time lifetime unlock,
  Pro is recurring.
- **Services** — `EntitlementService` enum: `past_papers_core`,
  `past_papers_elective`, `level_tests`, `mock_exams`, `ai_explanations`,
  `ai_weakness_narratives`, `post_exam_ai_breakdown`.
- **The matrix** — table `tier_services`, one row per `(account_type, service)`
  with `enabled` (bool), `daily_cap` (int; `NULL` = unlimited, `0`+enabled =
  kill-switch), and a `config` JSONB. Seeded by migration
  `1960000000000-EntitlementMatrix.ts`.
- **Usage counters** — table `user_service_usage`, composite PK
  `(user_id, service, day)`, `used_count`. Days roll at **Accra midnight**
  (`accraDateIso()`), not UTC — correct for the local audience.

### The gate — `EntitlementsService.assertAndConsume()`

`src/modules/entitlements/entitlements.service.ts`. Two ways to invoke it:

- **Declaratively** — `@RequiresService(EntitlementService.X)` on a route +
  the global `RequiresServiceGuard` (wired as `APP_GUARD` in `app.module.ts`).
  Used by AI Explanations.
- **Imperatively** — services call `assertAndConsume(userId, service)` inline.
  Used by past papers, level tests, mock exams, weakness narratives.

Flow (guard → quota → HTTP status):

1. Resolve the user's tier for their exam level (fails **safe** to Free).
2. Load the `(tier, service)` policy row. Missing row → **503** (that's an app bug,
   fail-closed).
3. `!enabled` → **403** ("not available on your tier").
4. **Config gate:** `config.requiresFormLevel === true && user.formLevel == null`
   → **403**. This is the NOVDEC refusal (see below).
5. **Atomic UPSERT** `used_count + 1 … ON CONFLICT … RETURNING` — one round-trip,
   so two concurrent requests can't both slip past the cap.
6. `dailyCap != null && usedCount > dailyCap` → decrement back, throw **429**
   ("hit your daily limit… upgrade or try tomorrow").
7. `dailyCap == null` → unlimited (still counted, for analytics).

### Why this is a wow factor

- **The whole business model is a database table.** Pricing/packaging experiments
  ("give Free 5 elective papers instead of 10", "enable mock exams for Plus") are
  a one-row `PATCH /admin/entitlements/:tier/:service` — no deploy.
- **Race-proof metering** via the atomic upsert-then-check.
- **Accra-day** rollovers, not UTC — quotas reset at local midnight.
- **Client transparency:** `GET /me/entitlements` returns
  `{ service, enabled, dailyCap, used, remaining }` so the app can show
  "3 of 10 left today" and upsell precisely at the wall.

### NOVDEC handling

NOVDEC (the private WASSCE re-sit) users have **no form level**
(`form_level = NULL`). Their question pool is shared with WASSCE
(`questionPoolFor()` remaps `NOVDEC → WASSCE`), but any feature whose policy
carries `config.requiresFormLevel: true` (Level Tests) cleanly **403**s them —
enforced once, in the gate, not duplicated per feature.

---

## 3. Feature catalogue

Each feature below: **what it is → how it's achieved → considerations → wow factor**,
with the seed quota per tier.

### 3.1 Past Papers — Core subjects

Core subjects: English, Mathematics, Science, Social Studies.

| | Free | Plus | Pro |
|---|---|---|---|
| `past_papers_core` | **Unlimited** | Unlimited | Unlimited |

- **What it is.** The real, historical WAEC questions for the compulsory core
  subjects — the product's front door, free forever.
- **How it's achieved.** Two paths: a **read** path,
  `GET /questions/past-paper` (`QuestionsController` → `QuestionsService.getPastPaper`),
  filtered by `subjectId + year + paper`, **Redis-cached 24h**; and an **exam
  session** path, `POST /exams` with `mode=past_paper` (`ExamsService.create`),
  which selects up to 50 questions by filter and tracks a graded attempt.
  A subject is "core" via `Subject.isCore` (access) / `Subject.category` (metering).
- **Considerations.** The read endpoint does **not** consume quota — only exam
  sessions meter. Access gating (can a Free user open this subject at all) uses
  `isCore`; metering bucket uses `category`. Explanations are re-joined per request
  so the 24h cache never serves stale AI text.
- **Wow factor.** Zero paywall on the content students need most — acquisition is
  frictionless, and serving stored questions costs effectively nothing.

### 3.2 Past Papers — Elective subjects

All non-core WAEC subjects (Physics, Chemistry, Biology, Economics, Geography,
Literature, the technical/vocational electives, languages, …).

| | Free | Plus | Pro |
|---|---|---|---|
| `past_papers_elective` | **10 / day** | Unlimited | Unlimited |

- **What it is.** The same real-exam practice, extended to every elective a student
  might sit.
- **How it's achieved.** Identical machinery to core; the split happens in
  `ExamsService.resolvePastPaperService(subjectIds)` — if **any** subject in the
  batch is `category = elective`, the session meters against
  `PAST_PAPERS_ELECTIVE`, else `PAST_PAPERS_CORE`. Mixed batches take the more
  restrictive bucket.
- **Considerations.** A Free student gets a genuine taste (10 elective sessions/day)
  before the wall — enough to feel value, calibrated to convert. `vocational`
  subjects meter as core here (a deliberate default).
- **Wow factor.** The **same code path** serves free and paid content; the only
  difference is which counter it decrements — packaging is pure configuration.

### 3.3 Level Tests

| | Free | Plus | Pro |
|---|---|---|---|
| `level_tests` (`requiresFormLevel`) | **20 / day** | 80 / day | Unlimited |

- **What it is.** AI-generated, **form-level** practice (Form 1/2/3), mapped to the
  syllabus — fresh questions targeted at exactly where the student is.
- **How it's achieved.** `POST /exams` with `mode=pm_test` →
  `ExamsService.createPmTestSession`. Questions are **not** past papers: they come
  from `pm_test_questions` (the "PassMaster/Bondzi Test" pool), **AI-generated in
  advance** by admins (`AdminPmTestService.generate` enqueues a
  `PM_TEST_GENERATION` job), **reviewed**, and promoted from `pending_review` to
  `active`. Session selection filters `status=active`, exam level,
  `form_level = user.formLevel`, optional subject/topic/difficulty,
  `ORDER BY RANDOM()`, default **20** questions.
- **Considerations.** Requires a form level — the policy carries
  `config.requiresFormLevel: true`, so **NOVDEC students are refused (403)** at the
  gate. Generation is offline and admin-reviewed, so students only ever see
  vetted, syllabus-grounded questions (never a raw model response). Timing is
  advisory (client-supplied `durationSeconds`, else untimed).
- **Wow factor.** Effectively **infinite, personalised practice** that never runs
  out of past papers — and because generation is grounded on the NaCCA curriculum
  (see [§4](#4-the-ai-generation-platform)), the questions map to real content
  standards and Depth-of-Knowledge levels.

### 3.4 Mock Exams

| | Free | Plus | Pro |
|---|---|---|---|
| `mock_exams` | **Disabled** | 5 / day | Unlimited |

- **What it is.** A full, timed exam-hall **simulation** — deliberately distinct
  from Past Papers and Level Tests.
- **How it's achieved.** `POST /exams` with `mode=mock_exam` →
  `ExamsService.createMockExamSession`, with hard-wired constants:
  **exactly 50 questions**, a **3-hour timer** (`durationSeconds = 10800`,
  "WASSCE Paper 1"), **single-subject** (rejects 0 or >1 subjectIds), **no
  filters** (rejects topic/year/paper filters), drawn `ORDER BY RANDOM()` from the
  **past-paper pool** for that subject. Client-supplied count/timer are ignored.
- **Considerations.** It has its **own** entitlement bucket, so a Free user tapping
  Mock gets a clean 403 (upsell) rather than silently burning an elective
  past-paper point. **The timer is client-enforced** — the server records
  `startedAt + durationSeconds` and returns them, but there is **no server-side
  auto-submit cron**; late answers are not rejected on elapsed time. (A known
  design choice / future hardening point.)
- **Wow factor.** One tap reproduces real exam pressure — fixed length, fixed
  clock, no cherry-picking topics — which is exactly what past-paper browsing can't
  give.

**Shared exam mechanics (all three modes).** One `Exam` entity, discriminated by
`mode` + `question_pool`. Answers: `POST /exams/:id/answers` grades pool-aware
(past-paper `options` vs `pm_test_options`), atomically bumps question stats, and
post-commit does SRS scheduling + XP + referral checks. Completion:
`POST /exams/:id/complete` scores `correct/total`, awards accuracy-scaled XP (+
perfect-score bonus), updates streaks and per-subject progress. Also `abandon`,
`result`, `resume`, `history`.

### 3.5 AI Explanations

| | Free | Plus | Pro |
|---|---|---|---|
| `ai_explanations` | **Disabled** | 20 / day | Unlimited |

- **What it is.** A per-question AI **walkthrough** — why the right answer is right,
  why each distractor is wrong, and (when it helps) a fresh worked example.
- **How it's achieved.** **Pre-generated in batches**, never on demand. Admins run
  `AdminExplanationsService.preview()` → `generate()`, which enqueues an
  `EXPLANATION_BULK` job; the worker calls the model, validates, and writes the
  markdown to `questions.explanation` (+ `explanationHtml`). Students **read** via
  `GET /explanations/:questionId`, which is **read-throttled** by the entitlement
  gate (quota consumed before the DB read). At read time
  `splitExplanationSections()` splits the stored blob on headings into
  `solution` (required) + `workedExample` (optional; `null` → the app hides the
  worked-example button).
- **Considerations.** Decoupling generation (batch, admin-paid, cost-capped) from
  reading (cheap, throttled) means students get **instant** explanations with no
  live model latency or per-read token cost — and the throttle protects the
  business, not the compute. The worked example is optional by prompt contract, so
  recall questions get a tight answer and computational ones get a second example.
- **Wow factor.** Explanations feel instant and unlimited-quality because the
  expensive work already happened offline behind validation and a co-sign cost
  gate.

### 3.6 AI Weakness Narratives

| | Free | Plus | Pro |
|---|---|---|---|
| `ai_weakness_narratives` | **Disabled** | 1 / day | Unlimited |

- **What it is.** A personalised, second-person narrative — *"here's why you keep
  losing marks on stoichiometry, and what to do about it"* — layered on top of a
  **free** statistical weakness detection.
- **How it's achieved.** Two layers. **(1) Free SQL detection** (`WeaknessService`,
  `GET /progress/weakness`): two raw aggregations over `exam_answers` — one for
  past-paper topics, one for syllabus (PM-test) topics — grouped by topic, requiring
  ≥3 samples, ordered by accuracy ascending, top 5. **No model call.** **(2) AI
  narrative** (`WeaknessNarrativeService.forUser`, `GET /progress/weakness/narrative`):
  same-day cached per `(user, day, scope)`; on zero signal returns a **canned
  bootstrap** (free, no charge); with signal, charges one quota point and calls the
  model (~3–5 sentences, `MAX_NARRATIVE_TOKENS = 700`).
- **Considerations.** The expensive AI only runs when there's real signal and only
  once per day/scope (cache-keyed, not per HTTP call). After a new exam submission,
  `invalidateBootstrapForToday()` lets a bootstrap card upgrade to a personalised
  one. **Design intent is "pinned to Bedrock"** (Haiku's fidelity on personalised
  text beats a local 8B at ~$0.0009/call); **in code** it calls
  `AiService.callBedrock()`, which honours `AI_PROVIDER` — so it is Bedrock in
  practice because Bedrock is the default provider, not because it's hard-pinned.
  (Worth tightening if you ever run `self_hosted`.)
- **Wow factor.** Students get a coach's read on their weak spots — but the platform
  only pays for AI when the free SQL layer has found something worth narrating.

### 3.7 AI Study Review (AI Insight)

| | Free | Plus | Pro |
|---|---|---|---|
| AI Study Review (own config table) | 0 | **10 / month** | **30 / month** |

- **What it is.** The flagship AI feature: a full, **6-section** study report —
  *Strengths · Where you're losing marks · Common mistake patterns · How to approach
  it · Your study plan · This week's focus* — plus a short teaser for the Home card.
- **How it's achieved.** `AiReviewService` (`POST /progress/ai-reviews`), built from
  the same `WeaknessService` SQL rollup via `buildAiReviewPrompt` (`MAX_TOKENS =
  1200`), validated by `validateAiReview` (a malformed/empty response is **not
  persisted and costs no quota**). **User-triggered only** — never a cron, never on
  read. Every review is stored in `ai_reviews` (content, summary, model, tokens,
  `cost_usd`); the row set **is** the quota ledger. History via
  `GET /progress/ai-reviews`; Home-card snapshot via `…/quota`.
- **Considerations.** Quotas live in their **own** admin-editable table
  `ai_review_config` (`plus_monthly_limit = 10`, `pro_monthly_limit = 30`), not the
  daily entitlement matrix — because this is a **monthly**, higher-value action.
  Usage = live COUNT of `personalised` rows since the start of the current **Accra
  month** (self-resetting, **no carry-forward**). Free is hard-403'd; over-limit is
  403 `AI_REVIEW_LIMIT_REACHED`. Zero-signal "bootstrap" reviews are free and
  excluded from the count. (Same Bedrock-in-practice nuance as §3.6.)
- **Wow factor.** A student can ask, on demand, "how am I actually doing?" and get a
  structured, personalised study plan grounded in their own answer history — with a
  permanent history they can revisit.

### 3.8 Post-exam AI Breakdown (deferred)

| | Free | Plus | Pro |
|---|---|---|---|
| `post_exam_ai_breakdown` | Disabled | Disabled | Disabled |

- **What it would be.** An AI summary of a whole finished exam — weakness areas +
  a suggested drill.
- **Status.** **Deferred / off.** The generation logic is fully written
  (`ExamsService.generateBreakdown`, `POST /exams/:id/breakdown`, cached to
  `exams.ai_breakdown`), but the feature is disabled purely via the entitlement
  matrix — `post_exam_ai_breakdown` is `enabled=false` on every tier, so the gate
  returns 403 today. **Turning it on is a one-row DB update, no deploy.** Leave
  disabled until Phase 2.

---

## 4. The AI generation platform

Everything AI-authored (Level Test questions, Explanations, Narratives, Reviews)
rides one platform designed around three problems: **provider flexibility**,
**cost safety**, and **content trust**.

### 4.1 Provider seam — swap Bedrock ↔ local by env

Two DI tokens decouple every consumer from the concrete provider
(`ai-generation.factory.ts`):

- `AI_GENERATION_CLIENT` — `bedrock` (default) → `BedrockClient`, `self_hosted` →
  `OllamaClient`. An unrecognised `AI_PROVIDER` logs a warning and falls back to
  Bedrock ("keep production alive over crashing on a typo").
- `AI_EMBEDDING_CLIENT` — resolved **independently** (`AI_EMBEDDING_PROVIDER`), so
  you can generate on Bedrock while embedding free on local Ollama.

**Models** (cross-region inference-profile IDs, `eu.` matching
`AWS_REGION=eu-central-1`): quality/explanations `eu.anthropic.claude-sonnet-4-5`,
fast/default `eu.anthropic.claude-haiku-4-5`, embeddings
`amazon.titan-embed-text-v2:0` (1024-dim, `normalize: true` → unit vectors for
cosine). Auth is IAM (no API keys).

**Bedrock quota engineering** (`bedrock.client.ts`): client-side **RPM pacing**
tuned to the granted cross-region Claude quota (`AI_BEDROCK_MAX_RPM`, default 10),
a **separate 480-RPM embedding pacer** (Titan's quota is far higher), real
**seconds-scale exponential backoff** on `ThrottlingException` (AWS's ms retries
are useless against a per-minute cap), and **30s request / 5s connect timeouts**
so a hung call never holds a BullMQ worker slot.

### 4.2 Generation pipeline — one BullMQ worker

`AiGenerationProcessor` (`src/jobs/ai-generation.processor.ts`) drains one queue
(`ai-generation`) and discriminates on the persisted `AiGenerationJob.jobType`:

- `PM_TEST_GENERATION` → `runPmTestJob`: per-subject/form/topic, splits the count
  by difficulty (`distributeByDifficulty`), round-robins topics, batches, and for
  each batch builds a prompt → `callBedrockWithBackoff` (3 attempts, 500/1000/2000ms)
  → validate → insert as `pending_review`.
- `EXPLANATION_BULK` → `runExplanationJob`: fetches questions in DB pages of 50,
  one model call per question, writes back to `questions.explanation`.

Progress (`completedItems`/`failedItems`/`actualCostUsd`) is persisted continuously
and streamed to admins over SSE.

### 4.3 Cost governance — layered and numeric

- **Pricing table** (`ai-cost.util.ts`): Haiku **$1 / $5**, Sonnet **$3 / $15** per
  1M in/out. `ollama:*` short-circuits to **$0**; geo-prefixes are stripped so
  inference-profile IDs price identically; **unknown models bill at the dynamic max**
  of the table so a future model never silently under-bills.
- **Daily budget guard** — global daily USD spend in Redis; throws
  `AiBudgetExceededException` past `AI_DAILY_BUDGET_USD` (**$50**). Plus a per-user
  **50 calls/day** limit. Enforced at **job start**.
- **Per-job runaway breaker** — aborts a job when running cost exceeds **1.5×** its
  pre-submit estimate (floor $0.10; absolute ceiling `AI_MAX_JOB_COST_USD × 1.5`,
  i.e. **$500 × 1.5**). Checked **after** each paid+validated item is persisted, so
  a billed call is never thrown away.
- **Two-admin co-sign** — jobs estimated over `AI_COSIGN_THRESHOLD_USD` (**$50**)
  are held `PENDING_APPROVAL` and require a **different** admin to approve
  (app check **and** a DB CHECK constraint).
- **Calibration** — `TOKEN_ESTIMATES` are deliberate upper bounds (they're the
  breaker's denominator); `calibrationReport()` reads P50/P95 actuals from
  `ai_usage_log` to retune.

### 4.4 Validation — protecting students from bad content

Every generated item is validated **before** it can reach a student; validators are
pure functions that never throw.

- **Questions** (`question.validator.ts`): exactly one correct option, non-empty
  stem, exactly 4 options (WAEC MCQ), no duplicate option text, and — crucially — if
  the model emitted a free-form answer field it must agree with the `isCorrect`
  flag. This keeps the **answer key correct at the wire** even when a weaker model
  drifts.
- **Explanations** (`explanation.validator.ts`): requires a `## Solution` section,
  optional `## Worked Example` after it, ≥180 chars (no one-liners), and rejects
  output that parrots the question stem verbatim.
- **Reject log** (`reject-log.service.ts`): raw record + weekly aggregate written in
  **one transaction** so counts never drift; transport failures (`bedrock_transport_error`)
  are logged distinctly from content rejections, so ops can tell "the model 500'd"
  from "the model produced garbage." A logging failure never kills the generation
  loop.

### 4.5 Instruction layer — grounded prompts

Prompts are built by **pure functions** (`src/modules/ai/instruction-layer/`) around
a shared **system shell** whose central rule is:

> **"Use ONLY the syllabus context provided in the user turn. Do not invent facts,
> formulae, historical dates, chemical constants, authors, or examples not derivable
> from that context."** Out-of-syllabus → return `{"error":"out_of_syllabus",…}` and
> stop.

A strong shell is what lets even a small model produce acceptable, on-syllabus
output. Question generation pins an exact JSON schema; explanations emit markdown
(mobile renders KaTeX/MathJax) with the Solution/Worked-Example contract.

### 4.6 RAG grounding — the pgvector path

The newest layer: generation and explanations are grounded on the **actual NaCCA
curriculum**, extracted from the official syllabus PDFs (see the separate
`syllabus-extraction` tool) and stored in Postgres.

- **Schema** — `syllabus_indicators.embedding vector(1024)` (pgvector) with an
  **HNSW cosine index** (`vector_cosine_ops`). The column is raw-SQL only (not
  TypeORM-mapped).
- **Ingest** — `SyllabusEmbeddingService.embedApproved()` embeds only
  **approved** indicators (the admin review gate), re-embedding when the model tag
  changes, in batches of 50.
- **Retrieval** — `SyllabusRetrievalService.retrieve()`: embed the query with the
  **same** model as ingest, metadata pre-filter (subject, form, `status=approved`),
  then nearest-neighbour `ORDER BY embedding <=> $1::vector LIMIT k`, returning
  cosine similarity + Depth-of-Knowledge tags.
- **Wiring** — the processor's `groundContext()` (top-6, per-`(subject,form,topic)`
  memoised) injects *"NaCCA syllabus indicators (ground strictly on these)"* into
  question prompts; `groundExplanation()` (top-4, gated by a cheap
  `hasEmbeddedIndicators` existence check) grounds explanations. **Best-effort by
  design:** any embed/retrieval miss falls back to legacy context — RAG never
  regresses generation for un-ingested subjects, and un-ingested subjects pay **zero**
  embed cost.

---

## 5. Wow factors

1. **The business model is a database table.** Tiers × services × caps live in
   `tier_services`; repackaging and pricing experiments are one admin `PATCH`, no
   deploy. Metering is race-proof (atomic upsert-then-check) and resets at **Accra
   midnight**.
2. **Free where it's cheap, metered where it costs.** Core past papers are
   unlimited on every tier; every AI token sits behind a quota. The same code path
   serves free and paid — only the counter differs.
3. **Instant, unlimited-quality explanations** because the expensive generation
   happens offline (batched, validated, cost-capped) and reads are cheap and
   throttled.
4. **AI that only pays when it has something to say** — the free SQL weakness layer
   decides when the paid narrative/review is worth generating; malformed responses
   are never persisted and never charged.
5. **A cost-governed AI factory:** dynamic-max fallback pricing, $50/day budget,
   $500 per-job cap, a **1.5× runaway breaker** that never discards billed work, and
   a **two-admin co-sign** (creator ≠ approver, DB-enforced) for expensive jobs.
6. **Wire-level content trust:** validators re-enforce every prompt rule (correct
   answer key, 4 unique options, cross-field agreement) so a weak model can't ship a
   wrong answer to a student; rejects land in a transactional log + weekly rollup.
7. **Syllabus-grounded generation** via pgvector HNSW RAG over the real NaCCA
   curriculum, so AI questions map to genuine content standards and DoK levels —
   with best-effort fallback that never regresses.
8. **Provider independence** — hot-swap Bedrock↔Ollama by env, with independent
   generation vs embedding providers and Bedrock quota pacing tuned to granted RPM.

---

## 6. Quick reference

### Entitlement matrix (seed defaults; admin-editable)

| Service | Free | Plus | Pro |
|---|---|---|---|
| `past_papers_core` | Unlimited | Unlimited | Unlimited |
| `past_papers_elective` | 10 / day | Unlimited | Unlimited |
| `level_tests` *(requiresFormLevel)* | 20 / day | 80 / day | Unlimited |
| `mock_exams` | Disabled | 5 / day | Unlimited |
| `ai_explanations` | Disabled | 20 / day | Unlimited |
| `ai_weakness_narratives` | Disabled | 1 / day | Unlimited |
| `post_exam_ai_breakdown` | Disabled | Disabled | Disabled |
| **AI Study Review** *(own table, monthly)* | 0 | 10 / month | 30 / month |

### Exam modes

| Mode | `mode` / `question_pool` | Source | Count | Timer | Meters |
|---|---|---|---|---|---|
| Past Paper | `past_paper` / `past_paper` | real WAEC questions | ≤50 (filtered) | client | core/elective |
| Level Test | `pm_test` / `pm_test` | AI-generated, reviewed | 20 (def.) | optional | `level_tests` |
| Mock Exam | `mock_exam` / `past_paper` | past-paper pool | **50** | **3h** | `mock_exams` |

### Key endpoints

| Area | Routes |
|---|---|
| Questions | `GET /questions/past-paper`, `/questions/years`, `/questions/:id` |
| Exams | `POST /exams`, `/exams/:id/answers`, `/exams/:id/complete`, `/exams/:id/abandon`, `/exams/resume`, `/exams/history` |
| Explanations | `GET /explanations/:questionId` |
| Weakness | `GET /progress/weakness`, `/progress/weakness/narrative` |
| AI Study Review | `POST /progress/ai-reviews`, `GET /progress/ai-reviews[/:id]`, `/progress/ai-reviews/quota` |
| Entitlements | `GET /me/entitlements`; admin `GET/PATCH /admin/entitlements/:tier/:service` |
| Post-exam breakdown | `POST /exams/:id/breakdown` *(disabled)* |

### AI config keys (`src/config/ai.config.ts`)

`AI_PROVIDER` (bedrock), `AI_DEFAULT_MODEL`/`AI_QUALITY_MODEL`, `AI_EMBEDDING_DIM`
(1024), `AI_DAILY_BUDGET_USD` (50), `AI_PER_USER_DAILY_LIMIT` (50),
`AI_MAX_JOB_COST_USD` (500), `AI_COSIGN_THRESHOLD_USD` (50),
`AI_MAX_ITEMS_PER_BATCH` (1000), `AI_BEDROCK_MAX_RPM` (10),
`AI_BEDROCK_EMBED_MAX_RPM` (480). AI-review limits are DB config (`ai_review_config`).

---

## 7. Known caveats & deferred work

- **Mock-exam timer is client-enforced.** The server stores `startedAt +
  durationSeconds` but has **no auto-submit cron**; late answers aren't rejected on
  elapsed time. Hardening (a scheduled expiry sweep) is a future item.
- **"Pinned to Bedrock" is intent, not enforcement.** Weakness Narratives, AI Study
  Review, and Post-exam Breakdown call `AiService.callBedrock()`, which honours
  `AI_PROVIDER`; they're Bedrock only because Bedrock is the default. To truly pin
  them, inject `BedrockClient` directly.
- **Post-exam AI Breakdown** is fully built but disabled via the entitlement matrix
  — enable per tier when Phase 2 starts.
- **Curriculum coverage** depends on the syllabus-extraction ingest (draft → approve
  → embed). Un-ingested subjects fall back to legacy topic context — correct, but
  not yet syllabus-grounded.
