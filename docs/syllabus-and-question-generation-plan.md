# Syllabus Ingestion + Syllabus‑Grounded Question Generation — Implementation Plan

> Status: **DRAFT for review** · Scope: `edt/backend` (primary), `edt/admin` (tooling) · Author: engineering
> Companion features that consume this: AI Study Review, AI Explanation generation, Level‑Test / Quiz / Mock‑Exam generation.

---

## 0. Context & goal

Today the platform has **no ingested syllabus**. The only syllabus surface is the `syllabus_topics` table (`title` + nullable `description`), and "grounding" is a single string of `syllabus_topics.description` injected into the generation prompt (`QuestionGenerationPromptArgs.syllabusContext`, assembled in `AiGenerationProcessor.runPmTestJob`). There are **no embeddings, no retrieval, no vector search** anywhere in the codebase.

The source curriculum is the **NaCCA standards‑based Curriculum for Secondary Education (SHS 1–3)** — one document **per subject** (~560 pages each). It is rigidly templated and coded, which makes structured extraction tractable.

**Goal:** make the syllabus the *spine* of the platform — a structured, coded, human‑verified, embedded knowledge base that every AI feature retrieves from. Then rebuild question generation (Level Test / Quiz / Mock) so the AI generates items grounded in **(a) the exact syllabus indicator**, **(b) real sample past‑paper questions**, and **(c) the WAEC exam format + marking guidance**, each with a full worked solution + worked example.

### Two married spines (NaCCA + WAEC)
The platform grounds on **two complementary sources**, cross‑mapped to each other:
- **NaCCA (knowledge spine)** — the standards‑based curriculum: *what* is taught. Strands → indicators, worked examples, DoK‑tagged assessment items, competencies. This is the depth‑of‑content source.
- **WAEC (exam / marking spine)** — the examination syllabi + past papers + marking schemes + chief‑examiner reports: *how* students are examined and graded. Paper structure, question styles, mark allocation, marking rubrics, and measured candidate misconceptions.

Neither alone is sufficient: NaCCA teaches the content but isn't what students are graded on; WAEC defines the exam but not the teaching depth. **We marry them** — NaCCA indicators are the primary key; each maps to WAEC exam topics so generation/explanation can pull *knowledge* from NaCCA and *exam form + marking* from WAEC (see §A10).

### Guiding principles
1. **Structure is the source of truth; embeddings are a derived index.** The PDF is used *once* (ingestion); it is never queried at request time.
2. **The Learning Indicator is the atomic unit.** Questions, explanations, and reviews all reference an indicator by its NaCCA **code**.
3. **Reuse the existing job/cost/validator plumbing** (`AiGenerationJob` + BullMQ `ai-generation` queue + `AiGenerationProcessor` + `validateQuestionBatch`). Do not build a parallel pipeline.
4. **Provider‑agnostic.** Embeddings go behind the same `AiGenerationClient` factory that already switches Bedrock/Ollama, so "free vs paid embeddings" is a config flip.
5. **Human‑in‑the‑loop.** Both syllabus extraction and generated questions land in a review queue before going live (mirrors the existing `PENDING_REVIEW` model for `pm_test_questions`).

---

# PART A — Syllabus ingestion & RAG

## A1. Data model (NaCCA hierarchy)

> **Verified against the source** (Additional Maths, pp.5, 23–41). The spine is:
> **Year (= form level) → Strand → Sub‑strand → { Learning Outcomes } + { Content Standard → Learning Indicators (+ worked examples) + Assessment items }**.
> The document has **two tables per sub‑strand**, joined by a shared `{strand}.{subStrand}.{n}` code prefix:
> - **Table A — overview** (`Learning Outcome | 21st‑C Competencies | GESI/SEL/Values`), codes `1.1.1.LO.1…`. Columns 2–3 are **near‑verbatim boilerplate repeated across every outcome** — generic metadata, **never groundable content**.
> - **Table B — content** (`Content Standards | Learning Indicators + Pedagogical Exemplars | Assessment`), codes `1.1.1.CS.1`, `1.1.1.LI.1`, `1.1.1.AS.1`. This is the gold: the **Learning Indicator** carries **worked Examples *with full Solutions*** (real LaTeX maths, Cayley tables), and the **Assessment** column carries **sample questions tagged by Depth‑of‑Knowledge level** (Level 1 Recall … Level 4 Extended reasoning).
>
> Code facets: `.LO.` outcome · `.CS.` content standard · `.LI.` **indicator (atomic unit)** · `.AS.` assessment. Math preserved as **LaTeX** (feeds the existing `$…$` KaTeX/SVG pipeline).

New tables (all with a `curriculum_version` stamp for future revisions):

```
subjects                          (exists)
 └ syllabus_strands                per subject + form_level   code('1'),   title
    └ syllabus_sub_strands                                     code('1.1'), title
       ├ syllabus_learning_outcomes   (Table A)               code('1.1.1.LO.1'), statement
       └ syllabus_content_standards   (Table B)               code('1.1.1.CS.1'), statement
            └ syllabus_indicators   ← ATOMIC UNIT             code('1.1.1.LI.1')
                 · statement            "Explain binary operations and apply…"
                 · worked_content       worked Examples + Solutions (LaTeX)  ← GROUNDABLE
                 · form_level, sort_order, curriculum_version
                 · source_ref           {subjectPdfId, pageFrom, pageTo}
                 · embedding            vector(N)   ← derived, pgvector
                 · status               'draft' | 'approved'
                 └ syllabus_assessment_items                   code('1.1.1.AS.1')
                      · dok_level         1..4  (Recall … Extended reasoning)
                      · question          text (LaTeX)   ← curriculum-native exemplar
                      · solution          text (LaTeX, if given)
```

Plus one small shared, **deduped** reference table (NOT embedded):
```
syllabus_pedagogy_refs   · competencies text · gesi_sel_values text · scope('subject'|'global')
```
The competencies/GESI/SEL/values blocks repeat almost identically across outcomes — store once, reference by id, keep out of the retrieval corpus.

Design notes:
- **Atomic unit = Learning Indicator (`LI`)** — confirmed. It links up to its **Content Standard (`CS`)** and down to **Assessment items (`AS`)**; Learning Outcomes (`LO`) attach to the same `{strand}.{subStrand}.{n}` group.
- **Two joins to resolve at extraction:** Table A (LO) ↔ Table B (CS/LI/AS) via the shared code prefix.
- **Codes are natural keys**, verbatim. Downstream FKs reference by `id`; provenance is the code.
- **`worked_content` + `assessment_items` are first‑class groundable assets** — they, not the boilerplate, are what feed explanation + question generation (see Part B). Boilerplate → the deduped ref table; teaching logistics → optional non‑embedded `pedagogy_notes`.
- Keep the existing **`syllabus_topics`** table as a coarse grouping / backward‑compat layer. Add a nullable **`syllabus_indicator_id`** FK on both `pm_test_questions` and `questions` (see A7).

**Corpus is smaller than the page count implies:** ~4 strands × ~2 sub‑strands × 3 years × a handful of content standards/indicators ⇒ on the order of **hundreds of embeddable indicators per subject**, most pages being boilerplate + repeated pedagogy. QA is very tractable.

New migration(s), numbered from the current tail (latest is `2150000000000-Faq`, so **start at `2160000000000`**): `2160000000000-SyllabusHierarchy.ts` (tables + `CREATE EXTENSION IF NOT EXISTS vector` + indexes), `2170000000000-QuestionSyllabusLink.ts` (add `syllabus_indicator_id` FKs). Use `gen_random_uuid()` for PKs (the convention across all 64 existing migrations). ⚠️ **`CREATE EXTENSION vector` has no precedent in this codebase — see the pgvector prerequisite in "Prerequisites & risks" before writing this migration.**

## A1b. Migrating the existing `syllabus_topics` (title / description)

**State of play (verified):** `syllabus_topics` is **created but never seeded** (no INSERT in any migration) and no syllabus has been loaded — so it is **effectively empty**. Its only consumers are: the FK `pm_test_questions.syllabus_topic_id`, a selection filter in `exams.service` (`createPmTestSession`), the PM‑Test generate DTO, and the single grounding hook `ai-generation.processor.ts:378` (`topicRow.description ?? title` → `syllabusContext`).

**Decision: don't strip, don't just widen the two fields — load the new hierarchy first, then deprecate.**
- *Widening `title/description`* would recreate the exact limitation we're escaping (it can't hold CS/LI/AS, worked examples, assessment items, DoK, WAEC map). ✗
- *Dropping it now* breaks a live FK + code paths for no benefit. ✗
- Empty table ⇒ **nothing to preserve** ⇒ clean, staged replacement. ✓

**Staged migration:**
1. **Add** the new NaCCA + WAEC hierarchy tables (A1/A10) and `syllabus_indicator_id` (nullable FK) on both `pm_test_questions` and `questions`. Old `syllabus_topic_id` stays, now **nullable + deprecated**.
2. **Ingest** content into the new tables (nothing lands in `syllabus_topics`).
3. **Repoint the two live consumers:**
   - *Grounding* — `ai-generation.processor.ts` reads the **indicator** (`worked_content` + assessment items) via `GenerationContextService`, not `syllabus_topics.description`.
   - *Selection* — `createPmTestSession` filters by `syllabus_indicator_id` (keep `syllabus_topic_id` working during transition).
4. **(Optional shim)** if any UI still lists "topics," auto‑populate `syllabus_topics` as a *denormalized view* of a chosen grouping level (e.g. one row per Content Standard, `title = code + statement`) so nothing 404s mid‑migration. Purely derived — never hand‑edited.
5. **Cleanup migration (later):** once all reads use indicators, drop `syllabus_topic_id` and the `syllabus_topics` table.

Net: the old `title/description` fields are **abandoned in place, then removed** — not updated, not the load target. All real content goes into the new structured tables from day one.

## A2. Storage map — S3 + Postgres + pgvector

| Artifact | Store | Role | Queried at request time? |
|---|---|---|---|
| Original subject **PDF** | **S3** (`syllabus/{subject}/{version}.pdf`) | Archived source; re‑extraction, audit, provenance links | ❌ never |
| Extracted **hierarchy + indicator text** | **Postgres** (A1 tables) | Source of truth; editable in admin | ✅ returned by retrieval |
| **Embedding vectors** | **Postgres `vector` column** (pgvector) | The searchable index | ✅ this is what's searched |

`pgvector` is a Postgres extension — **no new datastore**. The PDF in S3 is a cold archive; retrieval only ever touches Postgres. ⚠️ **Infra prerequisite:** no migration in this codebase has ever run `CREATE EXTENSION`, so pgvector availability is unverified. On managed Postgres (RDS/Aurora) the extension must be on the provider's allow‑list, the engine version must support it, and the DB role needs `CREATE` on the extension. Confirm this **before** Phase 1 (see "Prerequisites & risks"). If pgvector is unavailable, the fallback is an external vector store or the Postgres full‑text path (`to_tsvector`) as an interim — but that loses semantic retrieval.

## A3. Ingestion pipeline (offline, one‑time per subject/version)

```
PDF (S3)
 → [1 segment]  split by LOGICAL UNIT (sub-strand / learning-outcome span), NOT by page
 → [2 extract]  Claude (vision if scanned) → structured JSON (schema = A1 hierarchy)
 → [3 validate] JSON-schema validate + confidence flags
 → [4 QA]       admin review screen: approve / edit each indicator   (status: draft→approved)
 → [5 load]     upsert rows into the hierarchy tables + dedupe boilerplate → pedagogy_refs
 → [6 embed]    batch job: embed (statement + content) per approved indicator → pgvector
 → [7 version]  stamp curriculum_version; keep prior versions intact
```

- **Segment by logical unit, not by page.** The source's table cells **span multiple pages** (a single outcome's competency/values cell runs across 3–4 pages). Feed the model a whole sub‑strand / learning‑outcome span at once so it can reassemble spanned cells; page‑by‑page extraction would shred rows.
- **Strip boilerplate at extraction.** Extract the Learning Outcome + indicators + subject **content** only; send the 21st‑Century‑Skills and GESI/SEL/Values columns to a **deduped `pedagogy_refs`** table (store once), never into the embeddable corpus. This removes the majority of the page volume from the RAG index.
- **Two‑tier extraction.** First a **skeleton pass** (strands → sub‑strands → learning‑outcome codes only — compact, high‑accuracy, fast to review), then a **content pass** (indicators + groundable knowledge per outcome). Reviewing the small skeleton first catches structural errors cheaply.
- **Reuse the job system.** Add `AiJobType.SYLLABUS_EXTRACTION`. Extraction runs as an `AiGenerationJob` on the existing BullMQ `ai-generation` queue via a new branch in `AiGenerationProcessor` (`runSyllabusExtractionJob`). Cost gates (`AI_MAX_JOB_COST_USD`), budget check, and usage logging come for free.
- **Extraction cost is trivial** (tens of dollars across all subjects, one‑time). The real cost is **human QA time**, which scales with *indicators* (~150–400/subject), not pages — so **prioritise core subjects** (Core Maths, English, Integrated Science) and ship incrementally.

### Extraction output schema (target for step 2 — matches confirmed codes, pp.37/41)
```jsonc
{
  "formLevel": 1,                              // YEAR ONE
  "strand": { "code": "1", "title": "Modelling with Algebra" },
  "subStrand": { "code": "1.1", "title": "Number and Algebraic Patterns" },
  "learningOutcomes": [                         // Table A
    { "code": "1.1.1.LO.1", "statement": "Solve problems involving properties of binary operations." }
  ],
  "contentStandards": [{                        // Table B
    "code": "1.1.1.CS.1",
    "statement": "Demonstrate knowledge and understanding of binary operations, sets and binomial theorem…",
    "indicators": [{
      "code": "1.1.1.LI.1",
      "statement": "Explain binary operations and apply that knowledge in solving related problems.",
      "workedContent": "Example: operation * on ℝ, $a*b = a + b - 2ab$. Solution: …",   // LaTeX preserved
      "assessmentItems": [
        { "code": "1.1.1.AS.1", "dokLevel": 1, "question": "$p*q = 2p+q-2pq$. Find $3*(-2)$…", "solution": "" },
        { "code": "1.1.1.AS.1", "dokLevel": 4, "question": "Six shirts, two trousers…" }
      ],
      "confidence": 0.95
    }]
  }],
  // Boilerplate captured ONCE, not embedded — routed to pedagogy_refs:
  "pedagogyRef": { "competencies": "Communication: …", "gesiSelValues": "GESI: …" }
}
```
> Confirmed against pp.37 & 41: the indicator (`LI`) is the atomic unit, carries worked examples with solutions, and owns DoK‑tagged assessment items. Extraction must (a) join Table A ↔ Table B by code prefix and (b) preserve maths as LaTeX.

## A4. Admin tooling — Syllabus ingestion & review

New admin area `admin/syllabus`:
- **Upload / version** a subject PDF (→ S3), trigger an extraction job.
- **Job progress** (reuse the existing `AiGenerationJob` progress UI patterns).
- **Review queue**: tree view (strand → indicator), approve/edit each `draft` indicator, bulk‑approve a sub‑strand. `approved` indicators become eligible for embedding + generation.
- **Coverage view**: per subject/form, how many indicators, how many have ≥N linked questions (feeds B6).
- Query keys + types mirror existing admin patterns (`QK.*`, `types/api.ts`), role‑guarded `ADMIN/SUPERADMIN`.

## A5. Embeddings behind the provider abstraction

Add an embeddings seam alongside the existing generation seam:
- Extend `AiGenerationClient` interface with `embed(params: { texts: string[]; modelId: string }): Promise<number[][]>`.
- Implement in `BedrockClient` (Titan / Cohere via the `eu.` inference path) **and** `OllamaClient` (`bge-m3` / `nomic-embed-text`, **$0**).
- Add `AiService.embed(texts, opts)` that logs usage + provider tag (like `callBedrock`).
- Config: `AI_EMBEDDING_PROVIDER` (default follows `AI_PROVIDER`), `AI_EMBEDDING_MODEL`, `AI_EMBEDDING_DIM`.
- ⚠️ **Provider independence:** the current factory resolves **one** `AI_GENERATION_CLIENT` at boot from `AI_PROVIDER`. If embeddings may use a *different* provider than generation (e.g. generate on Bedrock, embed on Ollama), a single injected client can't serve both — add a **separate `AI_EMBEDDING_CLIENT` provider token** resolved from `AI_EMBEDDING_PROVIDER`. If you constrain embeddings to the same provider as generation, the existing single client suffices. Decide this explicitly.
- ⚠️ **Dimension is baked into the column** (`vector(N)`), so `AI_EMBEDDING_DIM` must match the chosen model (Titan v2 = 1024, `bge-m3` = 1024, `nomic-embed-text` = 768). Switching to a model with a *different* dimension is a **schema change** (ALTER column), not just a re‑embed — store `embedding_model` + `dim` on the row so a mismatch is detectable and pick the dim deliberately up front.

**Cost reality:** embeddings are ~1000× cheaper than generation (embedding an entire subject ≈ a fraction of a cent; a query embedding ≈ negligible). So the choice is **reliability**, not price:
- **Ollama (free)** if that endpoint is production‑grade and reliably up (retrieval embeds the query on *every* request).
- **Bedrock Titan** (effectively free, always‑on) to avoid making retrieval depend on a self‑hosted box.

**Hard rule:** the embedding model must be identical at ingest time and query time. Switching models ⇒ re‑embed everything (a background job). Store `embedding_model` + `dim` on the row so a mismatch is detectable.

## A6. Retrieval service (hybrid search)

New `SyllabusRetrievalService.retrieve({ subjectId, examType, formLevel, queryText, k })`:
1. Embed `queryText` (short — a question stem, a weak‑topic label, a generation target).
2. **Metadata filter first** (subject + exam type + form), then **vector search** within that slice:
   ```sql
   SELECT id, code, statement, content
   FROM syllabus_indicators
   WHERE subject_id = :sid AND form_level = :form AND status = 'approved'
   ORDER BY embedding <=> :queryVector
   LIMIT :k;
   ```
3. Optional **keyword rerank** using the existing Postgres full‑text path (`to_tsvector`, cf. `idx_questions_fts`) for exact‑term matches.

Index: `USING hnsw (embedding vector_cosine_ops)`. Returns indicator rows (text + code) for prompt injection.

## A7. Past‑paper → indicator mapping (the RAG bridge)

Past‑paper `questions` have `topic_id` (past‑paper topics) but **no** link to `syllabus_indicators`. Backfill via embeddings:
1. Embed each past‑paper question stem.
2. For each, retrieve nearest approved indicators (filtered by subject/exam type).
3. Write a **suggested** `syllabus_indicator_id` (+ confidence) — **admin confirms** in a lightweight mapping queue.
This turns the existing bank into first‑class citizens of the spine (needed so past papers can serve as grounding samples in Part B, and so reviews can cite indicators for past‑paper misses).

## A8. Versioning, refresh, ops
- `curriculum_version` on every row; a new curriculum edition is a new version, old questions keep their old links.
- Re‑embed job triggered by: indicator `content` edit, or model/dim change.
- Embeddings are **derived** — a rebuild is always possible from the approved structured rows.
- Backups: structured rows are in the normal Postgres backup; PDFs in S3 with versioning enabled.

## A9. Phasing (Part A)
- **A‑P1:** tables + migrations + S3 upload + extraction job + admin review (skeleton pass). Load 1 pilot subject (Additional Maths).
- **A‑P2:** content pass + embeddings + `SyllabusRetrievalService` + retrieval smoke tests.
- **A‑P3:** past‑paper→indicator mapping backfill + coverage dashboard; roll out remaining subjects by priority.

## A10. The WAEC exam & marking layer (second spine) + cross‑map

The NaCCA tables above are the *knowledge* spine. The **WAEC** spine captures how students are actually examined and graded. **Confirmed against the WAEC General Mathematics syllabus:** it explicitly states it is *"not a teaching syllabus"* and defers teaching to the national curriculum — direct source‑level validation of the NaCCA(teach) + WAEC(examine) marriage. WAEC supplies **three** structured things:

**(1) Exam blueprint** (front matter — confirmed values):
```
waec_exam_blueprints        per subject/exam: papers + rules, e.g.
                            Paper 1 = 50 MCQ, 1½h, 50 marks (common areas)
                            Paper 2 = 13 essays, Sections A(5 compulsory, 40 marks) + B(8, answer 5, 60 marks), 2½h
                            → drives Mock-exam assembly (B7) and per-paper question STYLE + mark weighting
```

**(2) Exam‑scoped syllabus hierarchy** (`Detailed Syllabus`: `TOPICS → CONTENTS → NOTES`) — a structured doc ingested like NaCCA (same job + review pipeline). The **Notes** column defines the **examinable boundary** ("scope of the questions which will be set") + worked examples (LaTeX):
```
waec_topics        code('A'), title('Number and Numeration')            ← aligns with existing `topics`
 └ waec_contents    code('A.a.i'), content, notes(scope + LaTeX examples), embedding(vector)
```
This **overlaps the existing `topics` table** (WAEC past‑paper topics) — reconcile: enrich/align `topics` with these WAEC contents+notes rather than duplicating. Past‑paper `questions` already carry `topic_id`, `year`, `wassce_paper`, `section`, so much of the exam structure is present.

**(3) Marking + misconceptions** (from past papers / chief‑examiner reports):
```
waec_marking_schemes        per past-paper question: mark-by-mark rubric ("award 1 mark for…"), LaTeX-aware
waec_examiner_notes         per WAEC topic: common candidate errors / misconceptions — MEASURED, not guessed
```

**The marriage — cross‑map:**
```
indicator_waec_topic_map    syllabus_indicator_id  ↔  waec topic_id   (many-to-many, confidence, admin-confirmed)
```
Built the same way as the past‑paper→indicator bridge (A7): embed indicator statements and WAEC topic/question text, suggest links, human‑confirm. NaCCA indicators are the **primary key of the platform**; the map lets any indicator pull its WAEC exam context (which paper, mark weighting, marking rubric, examiner‑flagged misconceptions), and lets any past‑paper question resolve to its NaCCA indicator.

**Where each spine feeds the AI:**
| Feature | NaCCA (knowledge) | WAEC (exam/marking) |
|---|---|---|
| Question generation | indicator content + worked examples + DoK level | question style per paper, mark allocation, sample past‑paper exemplars |
| Explanation / worked example | curriculum worked solutions + notation | **marking scheme** → teach "how each mark is earned"; examiner‑flagged pitfalls |
| AI Study Review | weak indicators + content to revise | **examiner‑note misconceptions** (measured) → precise "why you lose marks" |

Ingestion of the WAEC layer mirrors Part A (extract marking schemes / examiner reports via the same job + review pipeline). It can proceed **in parallel** with NaCCA ingestion since the two are joined by the cross‑map, not nested.

---

# PART B — Syllabus‑grounded question generation (Level Test / Quiz / Mock)

## B0. What changes vs today

Today (`AiGenerationProcessor.runPmTestJob` → `buildQuestionGenerationPrompt`): grounding = `syllabus_topics.description ?? title` — a single hand‑maintained string. The model has **no real curriculum content and no exemplar past‑paper questions** to imitate.

Target: for each generation target (a specific **indicator**), assemble a **retrieval‑augmented context** = the indicator's statement + content **+ a few real sample past‑paper questions** on the same indicator/subject, and instruct the model to author new WAEC‑style items **in that style, grounded in that content**, each with a full worked solution + a separate worked example.

## B1. RAG context assembly for generation

New `GenerationContextService.forIndicator({ indicatorId, examType, formLevel, difficulty })` returns:
- **Syllabus block:** the target indicator (`statement` + `worked_content`) + its parent content‑standard statement + 1–2 sibling indicators for scope boundaries (via A6). The `worked_content` gives the model the curriculum's own worked examples + solutions to ground rigor and notation on.
- **Curriculum exemplar block (available immediately — no mapping needed):** the indicator's own **`assessment_items`**, which the syllabus already supplies **tagged by DoK level**. These are the primary style/difficulty exemplars and exist from day one of ingestion.
- **Past‑paper exemplar block (added once A7 mapping exists):** `N` real sample past‑paper questions mapped to the same indicator, for WAEC‑exam authenticity. Imitate style/rigor; explicitly told **not to copy**.
- **WAEC exam/marking block (via the A10 cross‑map):** for the mapped WAEC topic — the target **paper** (objective vs theory), **mark allocation**, the **marking‑scheme rubric**, **examiner‑flagged misconceptions**, and the WAEC **Notes** (the *examinable scope boundary*). This shapes question format + mark weighting, keeps generation inside what WAEC will actually set (out‑of‑scope → refuse), and makes distractors map to *measured* candidate errors rather than invented ones.
- **Provenance:** the indicator `code` (+ mapped WAEC topic) stamped onto every generated question.

**DoK → difficulty mapping (curriculum‑native).** Use the syllabus's own Depth‑of‑Knowledge levels instead of arbitrary difficulty: **Level 1 (Recall) → easy, Level 2–3 → medium, Level 4 (Extended reasoning) → hard**. Generation targets a `(indicator, dokLevel)` pair, and the matching `assessment_items` become the difficulty‑calibrated exemplars for that level. This replaces the current free‑floating `DifficultyMixDto` percentages with something anchored to the curriculum.

Token budgeting: cap exemplars (2–4), truncate long stems, prefer *stem + correct answer + one distractor rationale* over full option text when space is tight (the job already sizes `maxTokens` per batch).

## B2. Prompt changes (`src/modules/ai/instruction-layer/`)

- Extend `QuestionGenerationPromptArgs`:
  ```ts
  syllabusContext: string;          // now = indicator statement + content (from A6)
  indicatorCode: string;            // provenance
  exemplars?: Array<{ stem: string; options: {label,body,isCorrect}[]; explanation?: string }>;
  requireWorkedExample: boolean;
  ```
- `buildQuestionGenerationPrompt` gains an **"Exemplar past‑paper questions (imitate style & rigor; DO NOT copy):"** block after the syllabus block.
- `system-shell.ts`: keep `GROUNDING_RULES` (ground on provided syllabus only; refuse with `{"error":"out_of_syllabus"}`), and strengthen `QUESTION_TASK_RULES` to require: exactly one correct option derivable from the stem, plausible distractors mapped to real misconceptions, and — when `requireWorkedExample` — an inline `explanation` containing a full worked solution **and** a separate worked example (reuse `EXPLANATION_TASK_RULES`).

## B3. Worked examples + explanations inline

- Generated `pm_test_questions.explanation` already stores an inline explanation. Extend generation so the explanation carries a **worked solution + worked example** conforming to the existing `explanation.validator.ts` contract (`## Solution` then `## Example`, ≥400 chars).
- For **past‑paper** questions, `questions.explanation_examples` (jsonb `WorkedExample[]`) already exists — the same worked‑example shape can be reused when we (separately) regenerate past‑paper explanations grounded on the newly mapped indicator.

## B4. Generation job flow (reuse, don't rebuild)

- Extend the **existing** `runPmTestJob` path: selection targets become **indicators** (not just `syllabusTopicIds`), context is built via `GenerationContextService`, output still validated by `validateQuestionBatch` before insert as `PENDING_REVIEW`.
- Stamp `pm_test_questions.syllabus_indicator_id` + keep `generation_batch_id = jobId` for provenance.
- **Close the co-sign gap:** PM‑Test generation currently skips the `AI_COSIGN_THRESHOLD_USD` gate (only explanations apply it). Since richer RAG context raises per‑job cost, wire `requiresCosign(estimate)` into the PM‑Test `generate` flow exactly as `admin-explanations.service.ts` does (hold `PENDING_APPROVAL`, second‑admin approve → enqueue). The DB CHECK enforcing approver ≠ creator already exists.
- All three cost layers still apply: `AI_MAX_ITEMS_PER_BATCH` (row cap — essential on the $0 Ollama path), `AI_MAX_JOB_COST_USD` (estimate cap), per‑job runaway breaker (`JOB_COST_CAP_MULTIPLIER`).

## B5. Validators (extend `validateQuestionBatch`)

Keep the existing MCQ contract (4 options, exactly one correct, no dup option text, refusal detection). Add, for syllabus‑grounded output:
- **Worked‑example presence** when required (delegate to `validateExplanation`).
- **Exemplar non‑copy** guard: reject if a generated stem is a near‑duplicate of an exemplar stem (normalised similarity) — the exemplars are style guides, not a copy source.
- **On‑indicator check** (best‑effort): the generated item should reference the target indicator's scope; low‑signal, so log rather than hard‑reject.
Rejects continue to flow to `RejectLogService` with `rawOutput` for playback in the admin reject viewer.

## B6. Provenance & coverage
- Every generated question links to `syllabus_indicator_id` (+ `generation_batch_id`). 
- **Coverage dashboard** (admin): per subject/form, indicators with `< N` active questions → the generation backlog. Turns "generate 50k questions" into a *targeted* "fill the gaps" workflow.

## B7. Quiz / Mock / Level‑test assembly implications (`exams.service.ts`)

The generation change is upstream of assembly; selection logic mostly stays, with these upgrades:
- **Level Test (`PM_TEST`)** — can now select by **indicator** (add `syllabus_indicator_id` filter alongside the existing `syllabus_topic_id`/`form_level`), enabling precise "test me on this objective" sessions.
- **Quiz** — (if surfaced as its own mode) a short indicator‑scoped `PM_TEST`/`TOPIC_DRILL` variant; no new pool needed.
- **Mock Exam (`MOCK_EXAM`)** — upgrade from the current fixed‑50‑random to a **`waec_exam_blueprints`‑driven** assembly: replicate the real paper (e.g. Core Maths Paper 1 = 50 MCQ / 1½h / 50 marks; Paper 2 = Section A 5 compulsory + Section B answer‑5), with **topic weighting** from the blueprint and mark allocation surfaced to the student. Far more authentic than uniform random.
- Grading/pool flags (`QuestionPool.PM_TEST` vs `PAST_PAPER`) and entitlement metering (`LEVEL_TESTS`, `MOCK_EXAMS`) are unchanged.

## B8. Quality loop / evaluation
- Track per generated question: review approve/reject rate, in‑exam `times_answered`/`times_correct`, flag rate. Feed back into prompt tuning (which indicators/prompts yield bad items).
- Optional A/B: syllabus‑grounded vs legacy prompt → reviewer approval rate + student outcome lift.

## B9. Phasing (Part B)
- **B‑P1:** prompt + context assembly grounded on the indicator's **`worked_content` + curriculum `assessment_items` (DoK‑tagged)** — available immediately from ingestion, no mapping needed. Generate per `(indicator, dokLevel)`. Validate reviewer approval rate on the pilot subject.
- **B‑P2:** add **past‑paper exemplar** injection (needs A7 mapping) for WAEC authenticity + worked‑example enforcement.
- **B‑P3:** coverage‑driven generation backlog + co‑sign wiring + eval loop; roll out per subject.

---

# PART C — Cross‑cutting concerns

- **Config keys (new):** `AI_EMBEDDING_PROVIDER`, `AI_EMBEDDING_MODEL`, `AI_EMBEDDING_DIM`, `SYLLABUS_S3_BUCKET`, `SYLLABUS_EXTRACTION_MODEL`. Reuse existing `AI_*` cost/budget keys.
- **New enums:** `AiJobType.SYLLABUS_EXTRACTION`; `AiAction.SYLLABUS_EXTRACTION`, `AiAction.EMBEDDING`.
- **Hallucination guards:** generation grounds on provided syllabus only and refuses out‑of‑scope; retrieval results are validated to exist; generated items are human‑reviewed before `ACTIVE`.
- **Security/PII:** syllabus content is non‑sensitive public curriculum; S3 bucket private, signed URLs for admin download only.
- **Worker mode:** all new jobs run under the existing `WORKER_MODE` worker container + BullMQ, not in the web process.
- **Cost control:** embeddings negligible; generation governed by the existing three‑layer gate + co‑sign (now also on PM‑Test).

---

# Prerequisites & risks (verify before Phase 1)

Findings from an audit of this plan against the backend (all code claims below were **verified accurate**):

1. **pgvector availability — HARD BLOCKER to confirm.** No migration has ever run `CREATE EXTENSION`. Verify the deployment's Postgres supports + allows `vector` (engine version, RDS/Aurora allow‑list, role privileges) **before** committing to the vector approach. This gates §A2/§A5.
2. **Embedding provider + dimension** must be chosen up front (see §A5 warnings): decide whether embeddings share the generation provider or need a separate `AI_EMBEDDING_CLIENT`; pin `AI_EMBEDDING_DIM` to the model.
3. **Migration numbering** continues from **`2160000000000`** (current tail is `2150-Faq`; `2130-AiReviews`, `2140-Achievements`, `2150-Faq` already exist).

Verified‑accurate integration claims (no drift found):
- Co‑sign asymmetry is real: `admin-pm-test.service.ts:175` hardcodes `status: PENDING` (no co‑sign); only `admin-explanations.service.ts` applies `requiresCosign`/`PENDING_APPROVAL`. §B4's "wire co‑sign into PM‑Test" is valid.
- `MOCK_EXAM` today: single‑subject, fixed 50 Q, forced 3‑hour timer, past‑paper pool — the code even comments "WAEC‑style Paper 1". §B7's blueprint upgrade fits.
- `questions.explanation_examples` is `jsonb WorkedExample[]` (worked‑example reuse in §B3 is valid).
- Full‑text path exists: `idx_questions_fts` GIN + `to_tsvector('english', body)` (the §A6 keyword‑rerank complement is real).
- `DifficultyMixDto` exists on the PM‑Test generate DTO (§B1's DoK replacement target is real).
- `AiGenerationClient.invoke` + `AI_GENERATION_CLIENT` factory (`AI_PROVIDER` → bedrock/self_hosted) are exactly as §A5 assumes; adding `embed()` is a clean extension.
- `syllabus_topics` is unseeded/empty; only consumer of `.description` is `ai-generation.processor.ts:378` (§A1b migration holds).

# PART D — Recommended build sequence

1. **Foundation:** pgvector extension + A1 hierarchy tables + `syllabus_indicator_id` FKs (migrations).
2. **Provider embeddings:** `embed()` on the client interface + Bedrock/Ollama impls + `AiService.embed` + config.
3. **Ingestion:** S3 upload + `SYLLABUS_EXTRACTION` job + admin review (skeleton pass) → load **Additional Maths** pilot.
4. **Retrieval:** content pass + embed indicators + `SyllabusRetrievalService` + smoke tests.
5. **Generation P1:** rewire `runPmTestJob`/`buildQuestionGenerationPrompt` to use retrieved indicator content (syllabus‑only) + worked‑example enforcement; validate on pilot.
6. **Bridge:** past‑paper→indicator mapping backfill + admin confirm queue.
7. **Generation P2:** exemplar past‑paper injection + non‑copy validator.
8. **Assembly + coverage:** indicator‑scoped Level Test selection + coverage dashboard + co‑sign on PM‑Test.
9. **Scale:** roll out remaining subjects by priority; add eval loop.

---

# Open decisions (need product input)

1. ~~Curriculum vs assessment~~ **RESOLVED — marry both.** NaCCA is the knowledge spine (primary key); WAEC is the exam/marking spine; the `indicator_waec_topic_map` (§A10) joins them. Open sub‑question: source availability of WAEC **marking schemes** and **chief‑examiner reports** (do you have these digitally, per subject/year?) — they're the highest‑value part of the WAEC layer.
2. **Embedding host:** start on **Ollama (free)** — only if that endpoint is production‑reliable — or **Bedrock Titan** (pennies, always‑on)? The abstraction lets us switch with a re‑embed.
3. **Extraction model:** Claude Sonnet (higher fidelity, pricier) vs Haiku for the extraction pass — recommend Sonnet for extraction (accuracy matters once, cost is one‑time), Haiku for high‑volume question generation.
4. **Priority subject order** for ingestion + generation.
5. **Source format:** the review screenshots look like clean digital text (not scans), which favours a text/layout‑aware parse feeding Claude; confirm there are no scanned/image‑only pages that need vision.
6. **"Quiz" as a distinct mode?** or is it just a short indicator‑scoped Level Test?
7. ~~Interior content page needed~~ **RESOLVED** (pp.37, 41): the content table (`CS`/`LI`/`AS`) is confirmed — indicator is the atomic unit, carries worked examples + DoK‑tagged assessment items. Schema + extraction target updated accordingly. No PDF upload required.

---

## Appendix — key integration points (existing code)

- Generation seam: `src/modules/ai/instruction-layer/question-generation.prompt.ts` (`buildQuestionGenerationPrompt`, `QuestionGenerationPromptArgs.syllabusContext`), assembled in `src/jobs/ai-generation.processor.ts` (`runPmTestJob`).
- System shell / rules: `src/modules/ai/instruction-layer/system-shell.ts` (`SYSTEM_SHELL_QUESTION_GENERATION`, `GROUNDING_RULES`, `QUESTION_TASK_RULES`, `EXPLANATION_TASK_RULES`).
- Validators: `src/modules/ai/validation/question.validator.ts` (`validateQuestionBatch`), `explanation.validator.ts` (`validateExplanation`).
- Job system: `src/modules/admin-ai-gen/entities/ai-generation-job.entity.ts`, `src/modules/ai/ai.queues.ts` (`QUEUE_AI_GENERATION`), `src/jobs/ai-generation.processor.ts`, co‑sign in `src/modules/admin-ai-gen/admin-explanations.service.ts` (`requiresCosign`).
- Generation entrypoint / providers: `src/modules/ai/ai.service.ts` (`callBedrock`, `AiCallResult`), `src/modules/ai/clients/ai-generation.factory.ts` (`AI_GENERATION_CLIENT`), `ai-generation-client.interface.ts` (`invoke`).
- Entities to link: `pm-test-question.entity.ts` (`syllabus_topic_id`, `generation_batch_id`, `status`), `question.entity.ts` (`topic_id`, `explanation_examples`), `subjects/entities/syllabus-topic.entity.ts`.
- Exam assembly: `src/modules/exams/exams.service.ts` (`ExamMode`, `createPmTestSession`, `createMockExamSession`).
- Full‑text complement: `questions.service.ts` (`to_tsvector`, `idx_questions_fts`).
