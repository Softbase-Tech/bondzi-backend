# Bondzi AI — Premium Quality Implementation Plan

> **Status:** authoritative implementation plan for the AI platform. Extends and
> supersedes the scope of `ai-quality-remediation-plan.md` — that document's
> item numbers (0.1–3.x) are referenced here unchanged and remain the spec for
> the generation pipeline; this document adds the corrections found in review,
> the Knowledge Layer doctrine, and the four student-facing features the
> remediation plan did not cover.
>
> Grounded in: the fable + codex reviews, the remediation plan, and a verified
> read of `src/modules/ai/`, `src/modules/progress/`, `src/modules/exams/`,
> `src/modules/questions/`, `src/jobs/ai-generation.processor.ts`, the config
> and migration layers, and the extraction assets at
> `../docs/learning_materials/` and `../syllabus-extraction/`.

---

## 1. The doctrine — one grounding contract for the whole platform

Every AI feature on Bondzi answers to the same three-source contract:

| Source | Role | Authority |
|---|---|---|
| **Syllabus** (`syllabus_topics` → `syllabus_indicators`) | **The guideline** — what we want the student to achieve. Defines *scope* and *coverage*: which outcomes a question batch must span, which topic a weakness maps to, which outcome an explanation serves. | Never quoted as content. Never the fact source. Its statements select and organize; they do not teach. |
| **Learning materials** (`learning_material_chunks`, extracted from the MoE 2025 Learner Materials) | **The knowledge target** — the exact facts, formulae, worked methods, and framing the student must understand. The factual ground truth for stems, keys, explanations, and every "go read this" recommendation. | Facts must trace here. `KEY_IDEAS` chunks: zero deviation. The verifier cites chunks. Strict-mode subjects refuse on unbacked claims. |
| **Past questions** (`questions` verified corpus) | **The style guide** — question framing, register, stem length, distractor plausibility, education level. Voice, not content. | Never copied. Never a fact source. Explanation exemplars demonstrate voice only, never format (remediation 1.7). |

**The product loop this enables** — the reason the Knowledge Layer is shared
infrastructure and not a question-generation detail:

```
   Level Test / Practice  ──►  Weakness Detector maps misses to INDICATORS
            ▲                                 │
            │                                 ▼
   re-test on the same          recommends the exact learning_material_chunks
   indicators (targeted            for those indicators ("Read: Binomial
   generation request)             Expansion — Key Ideas, p.14")
            ▲                                 │
            │                                 ▼
   Post-Exam Review closes      student reads → AI Explanations teach the
   the session with the same       method in the textbook's own voice
   indicator→chunk citations
```

Every feature reads the same joins. The spine already exists in the schema:
`questions.syllabus_indicator_id` and `pm_test_questions.syllabus_indicator_id`
(migration 2170, backfilled by 2220 + `syllabus-topic-sync.service.ts`) — it is
simply **unused by every student-facing feature today** (verified: the
weakness/review/breakdown prompts inject only topic titles and raw counts).

---

## 2. Verified current state — the honest baseline

The remediation plan accurately covers columns 1–2 below. Columns 3–6 were
mapped in this review and are **not covered by any existing plan**; they are in
materially worse shape than the generation pipeline.

| | Question gen (bulk) | Explanation (bulk) | Explanation (on-demand) | Weakness Detector | AI Insights & Review | Post-Exam Review |
|---|---|---|---|---|---|---|
| Where | `ai-generation.processor.ts:480-699` | `:765-933` | `questions/explanations.controller.ts:69-158` | `progress/weakness-narrative.service.ts` | `progress/ai-review.service.ts` | `exams.service.ts:992-1075` |
| System shell | ✅ (contradicted by user turn) | ✅ (JSON/markdown conflict) | n/a (pure DB read) | inline 6-rule shell | ✅ proper | ❌ **none — bare model** |
| Grounding | polluted indicator prose | "strictly on these" (contradiction) | n/a | ❌ topic titles + counts only | ❌ same | ❌ truncated stems only, topics never resolved |
| Output validation | structural validator | structural validator | n/a | ❌ non-empty check | ✅ 6-section validator | ❌ non-empty check |
| Answer-key verification | ❌ deferred | ❌ trusts `Correct answer: B` | n/a | n/a | n/a | n/a |
| Model config | `resolveModelId` (admin choice) | same | n/a | reads **nonexistent** `ai.defaultModel` → hardcoded literal | same | same |
| Telemetry | ✅ | ✅ | `cache_hit` never set | ❌ **every usage-log insert fails** (enum) | ❌ same | ❌ same |
| Budget guard | ✅ job-level | ✅ | n/a | ❌ none | ❌ none | ❌ none |
| DPA pinning | n/a | n/a | n/a | **documented, not implemented** | not even documented | documented, not implemented |
| Live in prod | ✅ | ✅ | ✅ (burns quota on 404s) | ✅ | ✅ | ❌ **dormant** — entitlement disabled for every tier |

**Verified platform defects behind that table** (all confirmed in code, all new
relative to the remediation plan):

1. **Broken telemetry for four actions.** `ai_usage_log_action_enum` was
   created with 5 values (`InitialSchemaV2.ts:77`) and no migration ever adds
   `weakness_narrative`, `post_exam_breakdown`, `ai_review`, `embedding`,
   `syllabus_extraction` (values that exist in the TS enum, `enums.ts:305`).
   With `synchronize: false`, every insert for those actions throws and is
   swallowed by `ai.service.ts:297`'s try/catch. **Cost, latency, and token
   telemetry for all student-facing AI is silently zero**, and the admin AI
   monitor under-reports real spend.
2. **`ai.defaultModel` does not exist.** `ai.config.ts` registers
   `explanationModel` and `fastModel`; the three student-facing services read
   `config.get('ai.defaultModel')` and always fall back to the hardcoded
   literal `'eu.anthropic.claude-haiku-4-5-20251001-v1:0'` — env model config
   has no effect on them, and the `eu.` prefix breaks under a non-EU
   `AWS_REGION`.
3. **DPA pinning is fiction.** Three comment blocks (`ollama.client.ts:36`,
   `ai-generation.factory.ts:11`, `ai.service.ts:53`) assert weakness
   narratives and breakdowns "pin to BedrockClient directly." In code, all
   three features call `AiService.callBedrock`, which dispatches through the
   provider factory — **`AI_PROVIDER=self_hosted` silently routes student
   weakness data, personalised reviews, and exam-answer excerpts to the local
   model.** `AiReviewService` isn't mentioned in any pinning comment at all.
4. **No budget guard on student-facing calls.** `checkBudget()` is called only
   from the bulk processor. Narratives/reviews/breakdowns are bounded only by
   entitlement caps — a Pro user's unlimited weakness narratives bypass
   `AI_PER_USER_DAILY_LIMIT` and the global daily USD ceiling entirely.
5. **On-demand explanations burn quota on failure.** The `@RequiresService`
   guard consumes the metered unit before the DB read
   (`explanations.controller.ts:70`), so a 404 ("no explanation generated
   yet") and a repeat view both charge the student.
6. **`AiReviewFull.content` skips `inlineMathInMarkdown`**
   (`ai-review.serializer.ts:40-45`) — any `$…$` emitted by a review reaches
   the mobile renderer as raw LaTeX, while the explanations controller inlines
   it correctly.
7. **Post-Exam Review is dead in production** — `POST_EXAM_AI_BREAKDOWN` is
   `enabled: false` for free, plus, *and* pro in the entitlement seed
   (`1960000000000-EntitlementMatrix.ts:163,215,265`); every call 403s.
8. **Three near-duplicate weakness→prose prompts** (narrative, review,
   breakdown) format the same rollup three different ways, none grounded, one
   with no system shell — an obvious consolidation target (§6.2).

---

## 3. Corrections to the remediation plan (adopt it, with these fixes)

The remediation plan is confirmed accurate against the codebase (paths,
line refs, the stale `EXPLANATION_PROMPT_V3` "maximum 150 words" seed, the
extraction scaffolding at `../syllabus-extraction/` with `map.json` +
`out/*.json`). Adopt it as written **except**:

- **R1 — Missing: the explanation-path key guard.** Remediation 0.1 verifies
  keys for *newly generated* questions. The bulk explanation job and the
  admin pm-test regen still hand `Correct answer: B` to the model as truth
  for *existing* questions (imported past papers with OCR'd keys — the
  highest-risk corpus). Restore the fable-review fix as a Phase 0 item:
  the explanation prompt instructs *"First solve the question independently.
  If your answer disagrees with the provided key, return
  `{"error":"key_mismatch","detail":"<your answer + reason>"}` instead of an
  explanation."* New reject reason `key_mismatch`; hits route the question to
  `PENDING_REVIEW`/admin queue. This audits the legacy corpus for free as the
  explanation backfill runs. Also pass the correct option **text** into the
  prompt alongside the label (codex finding) — it removes a whole class of
  label-misalignment errors and is required by 0.7/0.8 anyway.
- **R2 — Embedding model.** 0.9 says "bge-large or e5-large — same model we
  use for weakness clustering." No weakness clustering exists, and the
  platform's embedding path is `AiService.embed` → Titan Text Embeddings V2
  (Bedrock, `AI_EMBEDDING_DIM=1024`) or `bge-m3` (Ollama), with the model
  recorded per row exactly as `syllabus_indicators.embedding_model` does.
  **Use that existing path** — one embedder platform-wide, matching the
  `vector(1024)` column, ingest-time model == query-time model, zero new
  dependencies.
- **R3 — Coverage facts.** `form-2/` = 52 PDFs, `form-1/` = 9 (arriving),
  `form-3/` = 0. The 0.9 rollout order stands; Form 1 subjects can enter the
  pilot queue sooner than the plan assumed.
- **R4 — Blueprint per item (codex).** Fold a lightweight blueprint into the
  generation user turn rather than a separate system: per batch, the prompt
  states outcome (indicator statement, cleaned), cognitive skill target
  (mapped from DoK — see remediation Phase 3 rubric), and a **distractor
  strategy line**: "each distractor must embody a distinct, named student
  misconception; write the misconception in the explanation's why-wrong
  lines." The validator's per-distractor coverage check (1.5) then has
  something real to check against.
- **R5 — Validator addition.** 1.5's list plus: labels must be exactly
  `A,B,C,D` in order (codex noted it's unchecked; the shuffle in 0.7 makes
  server-side labels authoritative anyway).
- **R6 — `ALTER TYPE` caveat for every enum migration in this plan.**
  `ADD VALUE` cannot run inside a transaction block (55P04) — follow the
  pattern already documented in `1900000000000-PaymentsAndBillingLog.ts:191`.

Everything else in the remediation plan — sequencing, guardrails,
"what NOT to do" — stands as written.

---

## 4. Workstream A — the Knowledge Layer (shared foundation)

*This is remediation 0.9/0.9b/1.1 (ingestion, schema, retrieval bundle,
deviation policy, anchored/strict modes, cleanup migration) adopted verbatim
with corrections R2/R3 — read those sections there; not restated. What follows
is only what's **new**: the layer is platform infrastructure, so its retrieval
API must serve five consumers, not one.*

### A1. One retrieval service, five consumers

`KnowledgeRetrievalService` (extension of `SyllabusRetrievalService`) exposes
two shapes:

```ts
// Shape 1 — generation-time bundle (remediation Layer 1, unchanged):
retrieveForGeneration({ subjectId, formLevel, strandCode, indicatorId,
                        difficulty }): GenerationBundle
//   { keyIdeas, introduction, examplePairs[2-3], activity?, indicatorStatements }
//   ~2,500-token ceiling, diversity budget, 7-day cache.

// Shape 2 — remediation bundle (NEW — powers weakness/review/post-exam):
retrieveForRemediation({ indicatorIds: string[], maxChunksPerIndicator = 2 }):
  RemediationRef[]
//   [{ indicatorId, topicTitle, chunks: [{ id, sectionTitle, chunkType,
//      sourcePdfPage }] }]
//   Metadata only (ids + titles + pages), NOT chunk bodies — student-facing
//   features cite and deep-link reading material; they don't paste textbook
//   pages into prompts. Cheap, cacheable, and the app renders the link.
```

Shape 2 is what turns "you're weak in Vectors" into "Read *Vectors and
Scalars — Key Ideas* (p. 41), then retry 5 questions" — the difference between
a horoscope and a study plan.

### A2. Chunk linkage completes the spine

At ingest, after chunks land, run the linkage pass:
`learning_material_chunks (subject_id, form_level, strand_code,
sub_strand_code)` ⇄ `syllabus_topics` (via `source_content_standard_id` chain)
⇄ `syllabus_indicators` ⇄ `questions.syllabus_indicator_id`. Persist the
resolved `syllabus_topic_id` on each chunk row (nullable FK, backfilled) so
Shape 2 is one indexed join, not a code-matching dance per request.

### A3. Coverage telemetry

`retrieval_empty` (remediation) plus a nightly gauge per subject:
`% of active indicators with ≥1 linked chunk`. Surfaces in the admin AI
monitor and (already specced) the ops reporting `curriculum_chunks_indexed`
metric. Generation quality claims are only as good as this number.

---

## 5. Workstream B — generation pipeline (Level Test questions + explanations)

*Adopt remediation Phases 0–3 in full (0.1–0.9b, 1.1–1.8, 2.1–2.3, Phase 3),
plus corrections R1/R4/R5 from §3. For the doctrine mapping:*

| Doctrine source | In question generation | In explanation generation |
|---|---|---|
| Syllabus (guideline) | selects the indicator set a batch must cover; the cleaned statement is the blueprint's "outcome" line | names the outcome the explanation serves; scope guard |
| Learning materials (knowledge) | `KEY_IDEAS` = untouchable facts; `EXAMPLE+SOLUTION` pairs anchor method + difficulty ladder; verifier must cite a chunk | `## Solution` mirrors the textbook's step density; `## Worked Example` is a *novel* problem in the textbook's method; facts trace to chunks |
| Past questions (style) | stem register, length, distractor plausibility — voice only | explanation voice only, never format (1.7) |

Two additions beyond the remediation plan:

- **B1. Explanation key guard (R1)** — Phase 0, alongside 0.1. Files:
  `explanation.prompt.ts` (guard instruction + correct-option text in the user
  turn), `explanation.validator.ts` (`key_mismatch` refusal passthrough),
  `ai-generation.processor.ts` + `admin-pm-test.service.ts` (route mismatches
  to review, don't overwrite the existing explanation), reject-log enum.
- **B2. On-demand lazy generation (optional, Phase 2+).** Today the on-demand
  path 404s when no explanation exists. Once B1 + the verifier are live, a
  lazy-generate fallback (generate → validate → key-check → persist → serve;
  ~8s cold path behind a spinner) is safe to enable per-subject. Gate behind
  `AI_LAZY_EXPLANATIONS_ENABLED`; until then, fix the quota burn (§6.1.5) so
  404s at least stop charging students.

---

## 6. Workstream C — student-facing features (the uncovered 60% of the platform)

### 6.1 C-zero: platform fixes that precede everything (Phase 0, ~2 days total)

| # | Fix | Files |
|---|---|---|
| 1 | **Enum migration** `2250000000000-AiUsageActionsEnum`: `ALTER TYPE "ai_usage_log_action_enum" ADD VALUE IF NOT EXISTS` × (`weakness_narrative`, `post_exam_breakdown`, `ai_review`, `embedding`, `syllabus_extraction`) — outside a transaction per R6. Restores all student-facing cost telemetry. **Do this first; every other decision here is currently made blind on cost.** | new migration |
| 2 | **Model config**: add `defaultModel` to `ai.config.ts` (env `AI_DEFAULT_MODEL`, validated), or repoint the three services at `explanationModel`; derive the region prefix from `AWS_REGION` instead of hardcoding `eu.`. | `ai.config.ts`, `validation.schema.ts`, 3 services |
| 3 | **Enforce DPA pinning in code**: `const STUDENT_DATA_ACTIONS = new Set([WEAKNESS_NARRATIVE, AI_REVIEW, POST_EXAM_BREAKDOWN, CHAT_TUTOR])`; `AiService.callBedrock` routes those to the injected `BedrockClient` unconditionally, regardless of `AI_PROVIDER`. Update the three stale comments and add `ai_review` to them. Unit test: `AI_PROVIDER=self_hosted` + weakness action ⇒ Bedrock client invoked. | `ai.service.ts`, `ai.module.ts` |
| 4 | **Budget guard**: `callBedrock` invokes `checkBudget(userId)` for any call carrying a `userId` — per-user daily call cap + global daily USD ceiling now cover narratives/reviews/breakdowns. | `ai.service.ts` |
| 5 | **On-demand quota fairness**: consume the `ai_explanations` unit *after* a successful read (move metering into the handler; the entitlements service already exposes the primitive — the guard's decrement-on-cap-hit shows refunds exist), and pass `cacheHit: true` to usage logging on repeat views of the same question, finally animating the dead `ai_usage_log.cache_hit` column. | `explanations.controller.ts`, `entitlements` |
| 6 | **Math inlining** in `ai-review.serializer.ts` — apply `inlineMathInMarkdown` to `content` exactly as `explanations.controller.ts:150` does. | 1 file |
| 7 | **Product decision — Post-Exam Review entitlement.** The feature is fully built and 100% dormant. Recommendation: enable for Pro (it is the natural "end of exam" wow moment); keep free/plus off until C4 lands so the first impression is the grounded version. | entitlement seed / admin matrix |

### 6.2 Shared signal layer: `StudentSignalService`

One service replaces the three divergent inline data-assemblies. Produces a
single typed, injection-safe (`<data>`-wrapped, remediation 1.8) bundle:

```ts
interface StudentSignal {
  scope: { subjectId?: string; examId?: string };   // feature decides
  weakTopics: Array<{                                // extends WeaknessService
    syllabusTopicId: string; title: string; subjectName: string;
    correct: number; answered: number; accuracyPct: number;
    indicatorIds: string[];                          // NEW — the spine
  }>;
  strongTopics: Array<same>;                         // NEW — reviews need both
  trend: Array<{ weekStart: string; accuracyPct: number; attempts: number }>; // NEW — 4 weeks, from exam_answers
  recentMistakes: Array<{                            // NEW — capped at 5
    stem160: string; chosen: string; correct: string;
    topicTitle: string; syllabusTopicId: string;
  }>;
  remediation: RemediationRef[];                     // NEW — Shape 2 retrieval on weak indicatorIds
  meta: { streakDays: number; mockExamsTaken: number; formLevel?: number };
}
```

Sources: existing `WeaknessService.forUser()` rollups (extended to carry
`syllabus_topic_id`/indicator ids — they already join the tables, they just
drop the ids), `exam_answers` for trend + mistakes, `KnowledgeRetrievalService`
Shape 2 for remediation refs. **PII rule:** the bundle carries no name, phone,
or email — user identity never enters a prompt.

### 6.3 Weakness Detector v2

- **Prompt:** proper `.prompt.ts` module (system + user split, matching the
  house pattern). System shell: encouraging Ghanaian tutor register, plain
  prose, no markdown, never invent topic names, **every recommendation must
  reference a `remediation` entry by its section title**, refusal shape on
  insufficient signal. User turn: the `<data>`-wrapped `StudentSignal`.
- **Output contract:** 3–5 sentences of narrative **plus** a structured tail
  the app consumes:
  ```json
  { "narrative": "…", "recommendations": [
      { "syllabusTopicId": "…", "action": "read",
        "chunkId": "…", "label": "Vectors and Scalars — Key Ideas (p. 41)" },
      { "syllabusTopicId": "…", "action": "practice", "count": 5 } ] }
  ```
  The app renders "Read now" / "Practice 5 questions" deep links — the study
  loop of §1 made tappable. (Storage: add `recommendations jsonb NULL` to
  `weakness_narratives`; narrative column unchanged.)
- **Validator:** new `weakness-narrative.validator.ts` — JSON shape, narrative
  length 200–700 chars, ≥2 weak topics named verbatim from the signal, every
  `chunkId` present in the supplied `remediation` refs (no invented reading),
  no banned meta-language. Rejects → `ai_generation_reject_log`
  (action: `weakness_narrative`) — drift becomes visible for the first time.
- **Regeneration:** keep the one-per-day-per-scope cache; extend the existing
  bootstrap invalidation to also invalidate the personalised row when a new
  exam is submitted in-scope (the narrative should never describe yesterday's
  weaknesses after today's exam).
- **Params:** temperature 0.4, maxTokens 900, Bedrock-pinned (6.1.3),
  budget-guarded (6.1.4).

### 6.4 AI Insights & Review v2

- **Signal:** full `StudentSignal` (trend + strong topics + mistakes +
  remediation) instead of today's bare weakness lines — this is what turns a
  restated weakness list into an *insight* ("accuracy in Core Maths rose 9
  points over 3 weeks; Physics is flat because you keep missing unit
  conversions — see mistakes 2 and 4").
- **Contract:** keep the 6-section structure and validator (it is the best
  validator in the codebase); add to the validator: every recommendation line
  cites a remediation section title present in the signal; run
  `inlineMathInMarkdown` at serialization (6.1.6).
- **Idempotency (cost):** hash the signal bundle; a `POST` whose hash matches
  the user's latest review returns that review with `cached: true` and spends
  no quota unit and no tokens — today identical signal regenerates a
  near-identical 1,200-token report at full cost, a pure leak given monthly
  quotas of 10/30.
- **Params:** temperature 0.5, maxTokens 1200 (unchanged), Bedrock-pinned,
  budget-guarded.

### 6.5 Post-Exam Review v2

The weakest feature today (no shell, no grounding, no validation, topics never
resolved, and dormant). Rebuild on the spine:

- **Data:** for the submitted exam, resolve every answer through
  `question_id → syllabus_indicator_id → syllabus_topic` (both pools; the
  two-branch join). Group correct/wrong by topic. Retrieval Shape 2 on the
  top-2 missed topics' indicators.
- **Prompt:** proper system shell (house pattern; the current bare
  `callBedrock` without `system:` is the only such call in the codebase) +
  `<data>`-wrapped exam summary: per-topic tallies with titles, the 3 most
  instructive wrong answers (stem + chosen vs correct), remediation refs.
- **Contract:** short markdown — `## What went well` / `## What to fix` /
  `## Your next step` (one concrete action citing a remediation section
  title + a re-test suggestion). Plus the same structured `recommendations`
  tail as 6.3, stored in a new `exams.ai_breakdown_recommendations jsonb`.
- **Validator:** new `post-exam-review.validator.ts` — three headings, length
  bounds, topics named verbatim, chunk citations from the supplied refs,
  reject-logged.
- **Re-enable** per 6.1.7. Cache stays first-generation-wins per exam.
- **Params:** temperature 0.4, maxTokens 900, Bedrock-pinned, budget-guarded.

### 6.6 Consolidation

6.3–6.5 share: `StudentSignalService`, the `<data>` wrapper, the
citation-required rule, the recommendations JSON shape, Bedrock pinning,
budget guard, reject logging. Extract the common prompt scaffolding into
`src/modules/ai/instruction-layer/student-facing.shell.ts` so the fourth
duplicate never gets written. The chat tutor, when it ships, inherits all of
this for free — including the DPA pin.

---

## 7. Workstream D — verification and evaluation (extends remediation Phase 2)

1. **Answer verifier with citation** — remediation 0.1 + Layer 3, unchanged.
2. **Explanation key guard** — B1 (§5).
3. **Golden set + nightly harness** — remediation 2.1, **extended**: fixture
   *personas* (synthetic `StudentSignal` bundles: the strong-but-careless
   student, the one-subject-collapse student, the 3-attempts-thin-signal
   student) replay through the weakness/review/post-exam prompts nightly, with
   LLM-as-judge scoring on: cites-only-supplied-chunks, names-real-topics,
   actionability, tone. Prompt changes to *any* of the five features gate on
   the harness delta, not vibes.
4. **Model benchmarking** — remediation 2.2, now covering all five actions
   (the student-facing three are on hardcoded Haiku today purely by accident
   of the dead config key — benchmark whether they *should* be).
5. **Human sampling** — remediation 2.3, plus the student-facing features:
   weekly 10-narrative random sample to the ops review view.
6. **Live item calibration (new).** Nightly job over `exam_answers`:
   per-question p-value (`times_correct/times_answered` already maintained)
   and point-biserial discrimination; auto-flag `p < 0.15` (too hard/wrong
   key?) or negative discrimination (good students miss it — classic bad-key
   signature) into the admin review queue, and write `irt_difficulty` (column
   exists, unused). This is the ground-truth feedback loop no prompt work can
   substitute for: **students grading our questions at scale.** Cross-feeds
   the reporting spec's `flag_rate` hallucination proxy.

---

## 8. Sequencing — integrated with the remediation plan's sprint table

| Sprint | Generation pipeline (remediation items) | Platform + features (this doc) |
|---|---|---|
| 1 | 0.2, 0.3, 0.4, 0.6 + 0.9 kick-off | **6.1.1 enum migration (day 1 — restores cost visibility)**, 6.1.2 model config, 6.1.3 DPA pin, 6.1.4 budget guard |
| 2 | 0.1, 0.5, 0.8 + 0.9 pilot | **B1 explanation key guard**, 6.1.5 quota fairness, 6.1.6 math inlining, 6.1.7 entitlement decision |
| 3 | 0.7, 1.2, 1.4, 1.6, 1.7, 1.8 + 0.9 rollout | 6.2 `StudentSignalService` + A2 chunk linkage |
| 4–5 | 1.1 retrieval wire-up, 1.3, 1.5 | 6.3 Weakness v2, 6.5 Post-Exam v2 (they share 6.2; ship together), A1 Shape 2 |
| 6 | Phase 2 harness | 6.4 Review v2 + idempotency, D3 personas, D6 item calibration |
| 7+ | Phase 3 polish, coverage completion | D4/D5 ongoing; strict mode for humanities; B2 lazy explanations; chat tutor on the 6.6 scaffold |

Guardrails per PR: identical to the remediation plan (env flag, canary,
reject-log SLO, golden-set delta once 2.1/D3 land).

---

## 9. Success criteria — "premium" made measurable

| Signal | Target | Source |
|---|---|---|
| Answer-verifier agreement on published items | ≥ 98% (disagreements never publish) | verifier telemetry |
| `key_mismatch` rate on legacy corpus backfill | measured, then driven → 0 via review queue | reject log |
| Validator reject rate (question gen) | < 10% after Phase 0, < 5% after retrieval | reject log by reason |
| Truncation (`max_tokens_truncation`) | ~0 after 0.4 | reject log |
| Retrieval coverage | ≥ 90% of active indicators chunk-linked, per launched subject | A3 gauge |
| Citation compliance (weakness/review/post-exam) | 100% of recommendations cite supplied chunks | validators |
| Student-facing telemetry | 100% of calls logged with cost (vs ~0% today) | `ai_usage_log` post-6.1.1 |
| Item quality from live data | < 2% of active items flagged by p-value/discrimination per month | D6 job |
| Flag rate | < 5 / 1,000 answers served | `question_flags` |
| Cost per generated+verified item | tracked per model; verifier adds ≤ 15% | usage log |
| Golden-set score | never regresses on a merged PR | D3 harness |

## 10. What NOT to do

Inherited from the remediation plan (no heavy-RAG-first, no prompt-architecture
rewrite, no model switch on vibes) plus:

- **Don't paste textbook chunk bodies into student-facing prompts.** Shape 2
  passes titles/ids/pages; the app links to the material. Pasting pages
  inflates cost and invites verbatim-copy output.
- **Don't build a fourth bespoke student-data prompt.** Anything new that sees
  per-student data goes through `StudentSignalService` + the 6.6 shell, which
  means it inherits the DPA pin, budget guard, `<data>` wrapping, validation,
  and reject logging by construction.
- **Don't ship the chat tutor before Sprints 1–5 land.** It multiplies every
  defect above (unmetered cost, no grounding, DPA exposure) by conversation
  length. The 6.6 scaffold is its prerequisite, not an option.

---

## Appendix A — Implementation status (2026-08-23)

Implemented in this pass (build + lint clean; 98 suites / 804 tests green):

**Phase 0 / C-zero — all landed.** Grounding-contradiction fix (0.2), markdown
explanation shell + explanation-flavored grounding (0.3), content-aware token
budgets + `stop_reason` surfacing + `max_tokens_truncation` reject + 120s
Bedrock timeout (0.4), per-item salvage + one reflexion retry (0.5),
conditional explanation rules (0.6), server-side option shuffle (0.7),
quote-option-text contract + validator (0.8), blind answer verifier with
`verification_status` on pm_test rows (0.1), **explanation key-mismatch guard
(B1)** on the bulk job AND admin regen (mismatches route the question to
PENDING_REVIEW), enum/telemetry migration 2250, model-config repoint to
`ai.fastModel`, **DPA pin enforced in code** (`STUDENT_DATA_ACTIONS` →
BedrockClient), budget guard on user-carrying calls, per-action temperature
(1.4), prefill + prompt caching (1.3), quota fairness on on-demand
explanations + `explanation_viewed` write (`?examId=`), math inlining in the
review serializer, post-exam entitlement enabled for Pro (migration 2260),
injection-safe `<data>` wrapping (1.8), stem-only word ban (1.6), exemplar
format note (1.7), validator hardening (1.5: stem≤60, count handling,
difficulty-request-wins, option-ratio warn), difficulty rubric in shell,
seed templates re-synced to live contracts + `prompt_version` logging
(1.2 first half).

**Knowledge Layer (A / 0.9).** Migration 2270 (`learning_material_chunks`,
`pedagogy_notes` + statement cleanup on indicators AND learning outcomes,
`subjects.ai_retrieval_mode`), `KnowledgeRetrievalService` (Shape 1 + Shape 2
+ renderer), `LearningMaterialService` (ingest, topic-bridge resolution,
embed, admin CRUD, coverage gauge), admin endpoints under
`/admin/syllabus/learning-materials`, retrieval wired into question gen
(+ verifier) and explanation gen with `retrieval_empty` telemetry,
`extract_learning_material.py` + `push_learning_material.py` +
`learning_material_map.json` in `../syllabus-extraction/`. **Pilot extracted:**
Additional-Maths Y2 → 359 chunks (14 key-ideas, 14 introductions, 277
example+solution pairs, 51 activities) at
`../syllabus-extraction/out_lm/Additional-Mathematics-Y2.json`.

**Student-facing (C).** `StudentSignalService` (weak/strong topics with ids,
4-week trend, recent mistakes with chosen-vs-correct, Shape-2 reading refs,
fingerprint), shared `student-facing.shell.ts` + `narrative-envelope`
validator, Weakness Detector v2 (grounded prompt, JSON envelope with
validated `recommendations`, reject-logged, exam-submit invalidation of both
modes), AI Review v2 (full signal, trend/mistake/citation rules, signal-
fingerprint idempotency), Post-Exam Review v2 (topic resolution via the
two-branch join, reading citations for missed topics, proper shell,
envelope validation, `ai_breakdown_recommendations`). Migration 2280.

**Deviations from the plan text (deliberate):**
- Explanations quote option text WITHOUT the "(option B)" parenthetical the
  plan's 0.8 example showed — any letter reference goes stale under the 0.7
  shuffle, so the validator bans letters entirely.
- No new `AI_DEFAULT_MODEL` config key was needed: `ai.fastModel` already
  maps it; services were repointed instead.
- 2250/2270 run `ADD VALUE IF NOT EXISTS` inside the migration transaction —
  legal on Postgres 12+ (55P04 only bites when USING the value in the same
  transaction), matching the 1900 migration's precedent.

**Completed in the follow-up pass (2026-08-23, same day):**
- 1.2 second half — `PromptTemplateRuntimeService`: with
  `AI_PROMPT_TEMPLATES_ENABLED=true` the system shells are served from
  `prompt_templates` (60s cache, fail-open to compiled shells) and
  `ai_usage_log.prompt_version` records `<name>:<version>`. Seeds now
  store the raw shells. User turns stay code-owned (structural).
- Golden-set eval harness (§7.3) — `ai-eval.job.ts`, nightly 02:00 UTC
  on the worker, gated by `AI_EVAL_ENABLED` (default OFF — enabling
  nightly spend is deliberate): blind key-agreement probe, live-prompt
  explanation-contract probe (pass rate + reject-reason histogram),
  LLM-judge scoring of stored explanations. Results → `ai_eval_runs`
  (migration 2290) + ADMIN_ALERT_EMAIL summary. ~$0.02/night on Haiku.
- Item-calibration job (§7.6) — `item-calibration.job.ts`, weekly
  Sun 02:30 UTC, pure SQL ($0, on by default): p-value + point-biserial
  discrimination per question (≥30 answers), writes
  `questions.irt_difficulty` (logit), and pulls bad-key-shaped items
  (n≥50 AND (p<0.15 OR r<0)) to `pending_review` with an alert email.
- Strict-mode grounding check (§4 Layer 3) —
  `AnswerVerifierService.checkGrounding` (Haiku, temperature 0) runs on
  every generated item for subjects with `ai_retrieval_mode='strict'`
  when reference material was retrieved; unsupported facts reject the
  item with `retrieval_ungrounded_claim`. With no material retrieved,
  strict degrades to anchored rather than rejecting everything.
- Admin reviewer UI (admin repo) — `/admin/syllabus/materials`: subject/
  form/type filters + search, chunk table with type badges + embedded
  status, edit dialog (PATCH re-embeds), delete, per-subject coverage
  card; registered in the sidebar next to Syllabus review. Bonus: the
  PM-Test review page now shows the `verificationStatus` badge
  (agreed / key_mismatch / verifier_error).

**Stimulus-awareness pass (2026-08-25):** the AI pipeline previously had
zero awareness of `question_stimuli` (shared comprehension passages /
data tables — heavy in English and Biology). Fixed end-to-end:
explanation prompts and the answer verifier now receive the stimulus as
`<data type="stimulus">` (bulk job loads the relation; the eval job's
probes too); IMAGE-ONLY stimuli are skipped with the new
`stimulus_image_unsupported` reject reason instead of hallucinating or
false-tripping the key-mismatch guard; the exemplar picker excludes
stimulus-bearing questions (a stem referencing an invisible table is a
toxic style model); and generation gained a self-containment shell rule
plus the `references_missing_stimulus` validator reason — phantom
"According to the passage…" / "In the diagram below…" stems are
rejected (inline markdown tables in the stem remain allowed).

**Still open (small):**
- 0.9a admin-console generation batch-size default (frontend repo, one
  constant — raise ~5 → 8–10 now that salvage + budgets landed).
- Remaining textbook ingestion — run `extract_learning_material.py` +
  `push_learning_material.py` per PDF as books land (see the runbook in
  `../syllabus-extraction/README.md`).

## Appendix B — Runbook

1. `npm run migration:run` (or the deploy pipeline) — applies 2250–2280.
   2270's statement cleanup is idempotent.
2. `npm run seed:prompts` — refreshes the admin-visible templates.
3. Env: see `.env.example` — `AI_ANSWER_VERIFIER_ENABLED` (default on),
   `AI_BEDROCK_REQUEST_TIMEOUT_MS` (default 120000).
4. Pilot ingestion (needs a running API + admin JWT):
   `cd ../syllabus-extraction && .venv/bin/python push_learning_material.py
   --base-url <api> --token "$ADMIN_JWT"
   --file out_lm/Additional-Mathematics-Y2.json
   --subject-key Additional-Mathematics --replace --go`
   Then spot-check at `GET /admin/syllabus/learning-materials?subjectId=…`
   (a handful of OCR artefacts are expected — fix via `PATCH :id`, which
   re-embeds automatically) and check `GET …/coverage/:subjectId`.
5. Watch the reject log after the first generation batches: expect
   `retrieval_empty` on un-ingested subjects (informational),
   `verifier_key_mismatch` on caught bad keys, and the new explanation
   reasons (`key_mismatch`, `label_reference`, `missing_correct_answer_text`).
