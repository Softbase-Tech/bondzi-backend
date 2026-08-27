import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  StudentRecommendation,
  WeaknessNarrative,
} from './entities/weakness-narrative.entity';
import { StudentSignalService } from './student-signal.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { AiService } from '../ai/ai.service';
import { RejectLogService } from '../ai/reject-log.service';
import { AiAction, EntitlementService } from '../../common/types/enums';
import { accraDateIso } from '../../common/utils/timezone.util';
import {
  buildWeaknessNarrativePrompt,
  envelopeContextFromSignal,
  SYSTEM_SHELL_WEAKNESS_NARRATIVE,
  validateNarrativeEnvelope,
  WEAKNESS_NARRATIVE_PROMPT_VERSION,
} from './weakness-narrative.prompt';

export interface WeaknessNarrativeResponse {
  narrative: string;
  /** Tappable actions the app renders as deep links (premium §6.3). */
  recommendations: StudentRecommendation[];
  generatedAt: string;
  /**
   * `bootstrap` — the user doesn't have enough signal for a
   * personalised narrative, so this is a canned welcome string (no
   * Bedrock call, no entitlement charge). The Home card hides itself
   * on this mode; setup screens keep showing it because the student
   * asked explicitly.
   *
   * `personalised` — Bedrock-generated prose referencing the user's
   * weak topics, grounded on the StudentSignal bundle.
   */
  mode: 'bootstrap' | 'personalised';
  model: string;
  cached: boolean;
  subjectScope: string;
}

/**
 * Weakness Detector v2 (premium plan §6.3). Grounded on the shared
 * StudentSignal bundle (weak/strong topics WITH syllabus ids, trend,
 * recent mistakes, Knowledge-Layer reading citations), validated
 * before persist, reject-logged on drift — the feature previously ran
 * with topic titles + raw counts only, no validator, and no telemetry.
 *
 * DPA: AiAction.WEAKNESS_NARRATIVE is in AiService's
 * STUDENT_DATA_ACTIONS set, so this call is pinned to Bedrock in code
 * regardless of AI_PROVIDER.
 *
 * Persistence semantics
 *   The composite PK on (user_id, day, subject_scope) makes today's
 *   narrative single-writer per scope. A same-day repeat request
 *   returns the cached row WITHOUT touching entitlements — one
 *   AI_WEAKNESS_NARRATIVES point per unique (day, scope), not per
 *   HTTP call. Submitting an exam invalidates today's rows (both
 *   modes) so the next view reflects the new attempt.
 */
@Injectable()
export class WeaknessNarrativeService {
  private readonly logger = new Logger(WeaknessNarrativeService.name);
  private static readonly MAX_NARRATIVE_TOKENS = 900;
  private static readonly ALL_SCOPE = 'all';

  constructor(
    @InjectRepository(WeaknessNarrative)
    private readonly narrativesRepo: Repository<WeaknessNarrative>,
    private readonly signals: StudentSignalService,
    private readonly entitlements: EntitlementsService,
    private readonly ai: AiService,
    private readonly rejectLog: RejectLogService,
    private readonly config: ConfigService,
  ) {}

  async forUser(
    userId: string,
    filters: { subjectId?: string },
  ): Promise<WeaknessNarrativeResponse> {
    const scope = filters.subjectId ?? WeaknessNarrativeService.ALL_SCOPE;
    const day = accraDateIso();

    // 1. Same-day cache hit — no entitlement charge, no Bedrock call.
    const cached = await this.narrativesRepo.findOne({
      where: { userId, day, subjectScope: scope },
    });
    if (cached) {
      return {
        narrative: cached.narrative,
        recommendations: cached.recommendations ?? [],
        generatedAt: cached.generatedAt.toISOString(),
        mode: cached.mode,
        model: cached.model,
        cached: true,
        subjectScope: scope,
      };
    }

    // 2. Build the grounded signal FIRST — before touching entitlements
    //    or Bedrock. Zero-signal users get canned bootstrap prose:
    //    no Bedrock call, no entitlement charge, and the Home client
    //    hides the card because `mode === 'bootstrap'`.
    const signal = await this.signals.forUser(userId, {
      subjectId: filters.subjectId,
    });

    if (!signal.hasSignal) {
      const row = this.narrativesRepo.create({
        userId,
        day,
        subjectScope: scope,
        narrative: BOOTSTRAP_NARRATIVE,
        recommendations: null,
        mode: 'bootstrap',
        model: 'canned',
      });
      await this.narrativesRepo.save(row);
      return {
        narrative: BOOTSTRAP_NARRATIVE,
        recommendations: [],
        generatedAt: row.generatedAt?.toISOString() ?? new Date().toISOString(),
        mode: 'bootstrap',
        model: 'canned',
        cached: false,
        subjectScope: scope,
      };
    }

    // 3. Real signal → charge entitlement + hit Bedrock.
    //    assertAndConsume throws 429/403 if the tier is out of quota
    //    or disabled — the caller (controller) surfaces those as-is.
    await this.entitlements.assertAndConsume(
      userId,
      EntitlementService.AI_WEAKNESS_NARRATIVES,
    );

    const prompt = buildWeaknessNarrativePrompt(this.signals.render(signal));

    // `ai.fastModel` honors AI_DEFAULT_MODEL / AI_FAST_MODEL.
    const model =
      this.config.get<string>('ai.fastModel') ??
      'eu.anthropic.claude-haiku-4-5-20251001-v1:0';

    const result = await this.ai.callBedrock(prompt, model, {
      system: SYSTEM_SHELL_WEAKNESS_NARRATIVE,
      maxTokens: WeaknessNarrativeService.MAX_NARRATIVE_TOKENS,
      action: AiAction.WEAKNESS_NARRATIVE,
      userId,
      cacheSystemPrompt: true,
      promptVersion: WEAKNESS_NARRATIVE_PROMPT_VERSION,
      prefill: '{"narrative":"',
    });

    const validation = validateNarrativeEnvelope(
      result.content,
      envelopeContextFromSignal(signal),
    );
    if (!validation.ok) {
      // Drift is now visible: the reject lands in the same log the
      // generation pipeline uses (previously: raw save, no gate).
      this.logger.warn(
        `[weakness-narrative] rejected user=${userId} reason=${validation.reason} — ${validation.detail}`,
      );
      await this.recordRejectSafely(
        model,
        validation.reason,
        validation.detail,
        result.content,
      );
      // Nothing persisted → the same-day cache stays empty and the
      // student can simply retry.
      throw new BadRequestException(
        'The AI narrative came back malformed. Please try again in a moment.',
      );
    }

    const row = this.narrativesRepo.create({
      userId,
      day,
      subjectScope: scope,
      narrative: validation.value.narrative,
      recommendations: validation.value.recommendations,
      mode: 'personalised',
      model,
    });
    await this.narrativesRepo.save(row);
    return {
      narrative: validation.value.narrative,
      recommendations: validation.value.recommendations,
      generatedAt: row.generatedAt?.toISOString() ?? new Date().toISOString(),
      mode: 'personalised',
      model,
      cached: false,
      subjectScope: scope,
    };
  }

  /**
   * Drop today's rows so the next call recomputes with fresh signal.
   * Called by ExamsService right after a submission lands. v2 drops
   * BOTH modes (premium §6.3): a personalised narrative describing
   * yesterday's weaknesses must not survive today's exam. The regen
   * cost is bounded by the per-(day,scope) entitlement charge.
   */
  async invalidateForToday(userId: string): Promise<void> {
    const day = accraDateIso();
    await this.narrativesRepo.delete({ userId, day });
  }

  /** @deprecated v2 alias — kept so existing callers keep compiling. */
  async invalidateBootstrapForToday(userId: string): Promise<void> {
    await this.invalidateForToday(userId);
  }

  private async recordRejectSafely(
    model: string,
    reason: string,
    detail: string,
    rawOutput: string,
  ): Promise<void> {
    try {
      await this.rejectLog.record({
        jobId: null,
        action: 'weakness_narrative',
        provider: model.startsWith('ollama:') ? 'ollama' : 'bedrock',
        model,
        reason,
        detail,
        rawOutput,
      });
    } catch (err) {
      this.logger.warn(
        `[weakness-narrative] reject-log write failed: ${(err as Error).message}`,
      );
    }
  }
}

/**
 * Canned bootstrap prose. Served instead of a Bedrock call whenever
 * the user has no weak-topic signal (< MIN_SAMPLES per topic in every
 * pool). Same shape as a personalised narrative so the UI doesn't
 * branch on structure — just on `mode`.
 */
const BOOTSTRAP_NARRATIVE = `Welcome — you're set up and ready. We haven't seen enough of your practice yet to spot where you're strongest or where you're getting stuck. Pick the subject you feel least confident in and try 10–20 questions there; once we see a few topics in a row, today's insight will call out exactly what to work on.`;
