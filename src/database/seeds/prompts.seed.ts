import { DataSource } from 'typeorm';
import { PromptTemplate } from '../../modules/ai/entities/prompt-template.entity';
import {
  SYSTEM_SHELL_EXPLANATION,
  SYSTEM_SHELL_QUESTION_GENERATION,
} from '../../modules/ai/instruction-layer/system-shell';
import {
  QUESTION_GENERATION_SCHEMA,
  QUESTION_GENERATION_PROMPT_VERSION,
} from '../../modules/ai/instruction-layer/question-generation.prompt';
import {
  EXPLANATION_OUTPUT_CONTRACT,
  EXPLANATION_PROMPT_VERSION as EXPLANATION_RUNTIME_VERSION,
} from '../../modules/ai/instruction-layer/explanation.prompt';

/**
 * Prompt templates — seeded into prompt_templates.
 *
 * Remediation 1.2: each row's `content` is EXACTLY the system shell
 * the generation call runs with. When AI_PROMPT_TEMPLATES_ENABLED=true
 * the runtime (PromptTemplateRuntimeService) serves the active row's
 * content to the builders in place of the compiled shell — an admin
 * can hot-swap or roll back shell wording without a deploy, and
 * ai_usage_log.prompt_version records `<name>:<version>` so reject
 * rates segment by template. With the flag off, these rows are the
 * dashboard's source of truth for "what will the next run use?".
 *
 * The USER TURN (JSON schema, <data> wrapping, retrieval blocks, the
 * explanation output contract) stays code-owned — it is structural.
 * `QUESTION_GENERATION_SCHEMA` and `EXPLANATION_OUTPUT_CONTRACT` are
 * referenced here so a seed re-run fails to compile if the contracts
 * move, keeping this file honest.
 */
void QUESTION_GENERATION_SCHEMA;
void EXPLANATION_OUTPUT_CONTRACT;

export const EXPLANATION_PROMPT_NAME = 'EXPLANATION';
export const EXPLANATION_PROMPT_VERSION = EXPLANATION_RUNTIME_VERSION;
export const EXPLANATION_PROMPT_CURRENT = SYSTEM_SHELL_EXPLANATION;

export const PM_TEST_PROMPT_NAME = 'PM_TEST_GENERATION';
export const PM_TEST_PROMPT_VERSION = QUESTION_GENERATION_PROMPT_VERSION;
export const PM_TEST_PROMPT_CURRENT = SYSTEM_SHELL_QUESTION_GENERATION;

export const HINT_PROMPT_NAME = 'HINT';
export const HINT_PROMPT_VERSION = 'v1';

export const HINT_PROMPT_V1 = `You are helping a Ghanaian secondary school student who is stuck on a question.
Give ONE small nudge — not the full answer.

SUBJECT: {subject}
QUESTION: {questionBody}

Respond with a single sentence under 40 words pointing the student toward the
right approach without revealing the answer.`;

export async function seedPrompts(ds: DataSource): Promise<void> {
  const repo = ds.getRepository(PromptTemplate);
  const templates: Partial<PromptTemplate>[] = [
    {
      name: EXPLANATION_PROMPT_NAME,
      version: EXPLANATION_PROMPT_VERSION,
      content: EXPLANATION_PROMPT_CURRENT,
      isActive: true,
    },
    {
      name: PM_TEST_PROMPT_NAME,
      version: PM_TEST_PROMPT_VERSION,
      content: PM_TEST_PROMPT_CURRENT,
      isActive: true,
    },
    {
      name: HINT_PROMPT_NAME,
      version: HINT_PROMPT_VERSION,
      content: HINT_PROMPT_V1,
      isActive: true,
    },
  ];
  for (const t of templates) {
    const existing = await repo.findOne({
      where: { name: t.name, version: t.version },
    });
    if (existing) {
      await repo.update(existing.id, { content: t.content, isActive: true });
    } else {
      // Deactivate older active row for this name first
      await repo.update({ name: t.name, isActive: true }, { isActive: false });
      await repo.insert(repo.create(t));
    }
  }
}
