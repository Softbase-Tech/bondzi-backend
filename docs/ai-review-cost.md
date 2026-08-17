# AI Review — cost per review

Backed out from the actual generate path (`ai-review.service.ts`), the
prompt template (`ai-review.prompt.ts`), and current AWS Bedrock EU
pricing for the model in use.

## Facts on the ground

| Item                   | Value                                          | Source                                  |
| ---------------------- | ---------------------------------------------- | --------------------------------------- |
| Model                  | `eu.anthropic.claude-haiku-4-5-20251001-v1:0`  | `ai-review.service.ts:122`              |
| Region                 | EU (Frankfurt / Ireland)                       | Model ARN prefix                        |
| Output cap             | `MAX_TOKENS = 1200`                            | `ai-review.service.ts:45`               |
| Plus monthly quota     | 10 personalised reviews                        | `ai-review-config.entity.ts:26`         |
| Pro monthly quota      | 30 personalised reviews                        | `ai-review-config.entity.ts:29`         |
| Bootstrap reviews      | Zero cost                                      | Canned string, no Bedrock call          |
| Rejected responses     | Cost paid, quota not consumed                  | `ai-review.service.ts:131-139`          |

## Bedrock pricing — Claude Haiku 4.5 (EU)

| Direction | Price per 1M tokens | Per 1K tokens |
| --------- | ------------------- | ------------- |
| Input     | $1.00               | $0.001        |
| Output    | $5.00               | $0.005        |

## Token accounting per review

**Input side** (system + user prompt):

- System shell (`SYSTEM_SHELL_AI_REVIEW`): **~500 tokens** fixed.
  Six-section instruction block with formatting rules.
- User prompt (weakness rollup): scales with the student's practice
  history.
  - Bullet-line format: `- {topic} ({subject}): {correct}/{answered}
    correct` ≈ 15–18 tokens per topic.
  - Backend supplies up to N past-paper weak topics + N syllabus
    weak topics; typical N = 6–12 topics per pool = 12–24 lines.
  - Framing text ≈ 40 tokens.
  - **Typical: 300–650 tokens.** Cold-start student with 5 topics:
    ~200. Power user with 20+ topics: ~800.

**Output side** (model response, capped at 1200):

- Target length in the prompt: "roughly 250–500 words" ≈
  **350–700 tokens**.
- Cap: 1200 tokens (hit only if the model overruns the "500 words"
  guidance).

## Per-review cost (USD)

| Scenario                                     | Input tokens | Output tokens | Input cost | Output cost | **Total**   |
| -------------------------------------------- | ------------ | ------------- | ---------- | ----------- | ----------- |
| Light (cold-start student, terse review)     | 600          | 350           | $0.0006    | $0.00175    | **$0.0024** |
| **Typical (median student)**                 | **1,000**    | **500**       | **$0.0010**| **$0.0025** | **$0.0035** |
| Heavy (20+ topics, verbose response)         | 1,400        | 800           | $0.0014    | $0.0040     | **$0.0054** |
| Worst case (output hits cap)                 | 1,400        | 1,200         | $0.0014    | $0.0060     | **$0.0074** |

**Median ≈ $0.0035 USD per personalised review.** In pesewas at
GHS/USD ~15: **~5.3 GHp per review**. Worst realistic case ~11 GHp.

## Per-user monthly cost at full quota consumption

Assumes students actually generate all their allowed reviews (upper
bound):

| Tier | Monthly quota | Median cost | Worst case | GHS at 15:1     |
| ---- | ------------- | ----------- | ---------- | --------------- |
| Plus | 10            | $0.035      | $0.074     | ₵0.52 – ₵1.11   |
| Pro  | 30            | $0.105      | $0.222     | ₵1.58 – ₵3.33   |

## At scale

Assumes tier mix ~70% Plus / 30% Pro (typical freemium split), 60%
quota consumption (most students don't burn every allowance):

| Active paid users | Reviews/month | Median monthly cost | Worst case |
| ----------------- | ------------- | ------------------- | ---------- |
| 100               | ~840          | **$2.94**           | **$6.22**  |
| 1,000             | ~8,400        | **$29.40**          | **$62.16** |
| 10,000            | ~84,000       | **$294**            | **$622**   |
| 50,000            | ~420,000      | **$1,470**          | **$3,111** |

Roughly **3 US cents per paid user per month** at median.

## Hidden costs worth naming

1. **Rejected responses charge full input+output but don't decrement
   quota.** From `ai-review.service.ts:131-139`: a malformed AI
   response throws a 400 to the user telling them "this attempt was
   not counted". True from the user's perspective — but Bedrock
   already invoiced us. Users can retry; each retry is another
   full-cost call. If validator rejection rate is 5% and users retry
   once, add ~5% to totals.

2. **Bootstrap reviews are genuinely free.** `mode='bootstrap'`
   returns `BOOTSTRAP_REVIEW` canned content with no Bedrock call.
   Not a cost centre.

3. **Prompt caching not enabled.** Bedrock supports prompt caching
   (50% discount on repeated system prompts). The 500-token
   `SYSTEM_SHELL_AI_REVIEW` is identical for every call — caching
   would drop input cost ~40%. Worth wiring in `callBedrock` once
   volume justifies it.

## How to validate against reality

The `ai_reviews` table already stamps `cost_usd`, `input_tokens`,
`output_tokens` per row (`ai-review.service.ts:149-151`). Query for
actuals:

```sql
SELECT
  DATE_TRUNC('day', created_at) AS day,
  COUNT(*) FILTER (WHERE mode = 'personalised') AS personalised,
  COUNT(*) FILTER (WHERE mode = 'bootstrap') AS bootstrap,
  ROUND(AVG(cost_usd::numeric) FILTER (WHERE mode = 'personalised'), 5) AS avg_cost,
  ROUND(MAX(cost_usd::numeric), 5) AS max_cost,
  ROUND(SUM(cost_usd::numeric), 4) AS total_cost_usd,
  ROUND(AVG(input_tokens)  FILTER (WHERE mode = 'personalised')) AS avg_in_tokens,
  ROUND(AVG(output_tokens) FILTER (WHERE mode = 'personalised')) AS avg_out_tokens
FROM ai_reviews
WHERE created_at > NOW() - INTERVAL '30 days'
GROUP BY 1
ORDER BY 1 DESC;
```

If actual `avg_cost` diverges materially from the $0.0035 median
above, the deltas point at either different-than-expected token
counts or a pricing tier change on Bedrock.

## Cost-control levers, if the total ever bites

- **Prompt caching in `callBedrock`** — cheapest win, ~40% off input
  cost for identical system prompts.
- **Trim `MAX_TOKENS` to 900** — the prompt targets 250–500 words
  (~700 tokens); 1200 is 40% headroom the model rarely needs. Would
  cap the outlier tail without changing typical output.
- **Consider Claude Haiku 3.5 for non-Pro tiers** — output at $4/M
  vs $5/M is 20% cheaper. Slight quality drop; probably fine for
  Plus. Kept as a fallback.
- **Reject responses server-side more strictly** to force retries
  → not desirable, adds cost per retry.
- **Cache the last review** if the student's weakness signal hasn't
  materially changed — return the previous one instead of
  re-generating. Adds complexity, saves a real chunk on power users.
