import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PromptTemplate } from './entities/prompt-template.entity';

/**
 * Runtime bridge between the prompt_templates table and the
 * instruction-layer builders (remediation 1.2, second half).
 *
 * Contract: the DB owns the SYSTEM SHELL text per action; the user
 * turn (schema, <data> wrapping, retrieval blocks) stays code-owned —
 * it is structural and interpolated per request. When
 * `AI_PROMPT_TEMPLATES_ENABLED=true`, callers pass the active
 * template's content into the builders as `systemShellOverride` and
 * stamp its version onto ai_usage_log.prompt_version, so an admin can
 * hot-swap / roll back shell wording without a deploy AND segment
 * reject-rate telemetry by template version.
 *
 * When the flag is off (default), missing, or the DB read fails, the
 * caller falls back to the compiled shells — a bad template row can
 * degrade quality but can never take generation down.
 *
 * Known caveat (documented, accepted): the question-generation shell
 * is composed conditionally in code (EXPLANATION_TASK_RULES ride along
 * only when inline explanations are requested). A DB-served shell is
 * used as-is for both cases; keep the stored PM_TEST_GENERATION
 * template written for the with-explanations case, which is the
 * production default.
 */

export interface ActiveShell {
  shell: string;
  version: string;
}

const CACHE_TTL_MS = 60_000;

@Injectable()
export class PromptTemplateRuntimeService {
  private readonly logger = new Logger(PromptTemplateRuntimeService.name);
  private readonly cache = new Map<
    string,
    { value: ActiveShell | null; expiresAt: number }
  >();

  constructor(
    @InjectRepository(PromptTemplate)
    private readonly promptsRepo: Repository<PromptTemplate>,
  ) {}

  get enabled(): boolean {
    return process.env.AI_PROMPT_TEMPLATES_ENABLED === 'true';
  }

  /**
   * The active DB shell for a template name, or null when the flag is
   * off, no active row exists, or the read fails. 60s in-memory cache
   * so bulk jobs don't hammer the table per item.
   */
  async activeShell(name: string): Promise<ActiveShell | null> {
    if (!this.enabled) return null;

    const cached = this.cache.get(name);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    let value: ActiveShell | null = null;
    try {
      const row = await this.promptsRepo.findOne({
        where: { name, isActive: true },
      });
      if (row?.content?.trim()) {
        value = { shell: row.content, version: `${name}:${row.version}` };
      }
    } catch (err) {
      this.logger.warn(
        `[prompt-templates] load failed for ${name} — falling back to compiled shell: ${(err as Error).message}`,
      );
    }
    this.cache.set(name, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  }
}
