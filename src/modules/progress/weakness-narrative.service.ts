import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WeaknessNarrative } from './entities/weakness-narrative.entity';
import {
  PastPaperWeakTopic,
  SyllabusWeakTopic,
  WeaknessService,
} from './weakness.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { AiService } from '../ai/ai.service';
import { AiAction, EntitlementService } from '../../common/types/enums';
import { accraDateIso } from '../../common/utils/timezone.util';

export interface WeaknessNarrativeResponse {
  narrative: string;
  generatedAt: string;
  model: string;
  cached: boolean;
  subjectScope: string;
}

/**
 * Generates a personalised prose narrative from the user's weakness
 * rollup (`WeaknessService`). Pinned to Bedrock per AiModule's
 * documented policy — for personalised student-facing text, Haiku's
 * fidelity is worth the ~$0.0009/call vs a local 8B model.
 *
 * Persistence semantics
 *   The composite PK on (user_id, day, subject_scope) makes today's
 *   narrative single-writer per scope. A same-day repeat request
 *   returns the cached row WITHOUT touching entitlements — one
 *   AI_WEAKNESS_NARRATIVES point per unique (day, scope), not per
 *   HTTP call.
 *
 *   `subject_scope` is either a subject uuid or the sentinel 'all'
 *   for cross-subject narratives. Kept as TEXT (not FK) so the PK
 *   stays composite — clean dedup beats the referential integrity
 *   check here because subjects are effectively immutable.
 */
@Injectable()
export class WeaknessNarrativeService {
  private readonly logger = new Logger(WeaknessNarrativeService.name);
  private static readonly MAX_NARRATIVE_TOKENS = 700;
  private static readonly ALL_SCOPE = 'all';

  constructor(
    @InjectRepository(WeaknessNarrative)
    private readonly narrativesRepo: Repository<WeaknessNarrative>,
    private readonly weakness: WeaknessService,
    private readonly entitlements: EntitlementsService,
    private readonly ai: AiService,
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
        generatedAt: cached.generatedAt.toISOString(),
        model: cached.model,
        cached: true,
        subjectScope: scope,
      };
    }

    // 2. First-of-day-for-this-scope → charge entitlement + generate.
    //    assertAndConsume throws 429/403 if the tier is out of quota
    //    or disabled — the caller (controller) surfaces those as-is.
    await this.entitlements.assertAndConsume(
      userId,
      EntitlementService.AI_WEAKNESS_NARRATIVES,
    );

    // 3. Pull the weakness data that will feed the prompt. If the user
    //    has no weakness signal at all yet, we still generate a
    //    narrative but pivot the prompt to "start-of-journey" framing
    //    so we don't emit an empty or awkward-looking response.
    const data = await this.weakness.forUser(userId, {
      subjectId: filters.subjectId,
    });
    const hasSignal =
      data.pastPaperWeakTopics.length > 0 || data.syllabusWeakTopics.length > 0;

    const prompt = hasSignal
      ? this.buildPrompt(data.pastPaperWeakTopics, data.syllabusWeakTopics)
      : this.buildBootstrapPrompt();

    const model =
      this.config.get<string>('ai.defaultModel') ??
      'anthropic.claude-haiku-4-5-20251001-v1:0';

    const result = await this.ai.callBedrock(prompt, model, {
      system: SYSTEM_SHELL_WEAKNESS_NARRATIVE,
      maxTokens: WeaknessNarrativeService.MAX_NARRATIVE_TOKENS,
      action: AiAction.WEAKNESS_NARRATIVE,
      userId,
    });

    const narrative = result.content.trim();
    if (!narrative) {
      // Empty result from the model — very rare, but if it happens we
      // do NOT persist (a cached empty string would soft-lock the user
      // out of narratives for the day since same-day cache reads win).
      throw new BadRequestException(
        'The AI returned an empty narrative; try again in a moment.',
      );
    }

    const row = this.narrativesRepo.create({
      userId,
      day,
      subjectScope: scope,
      narrative,
      model,
    });
    await this.narrativesRepo.save(row);
    return {
      narrative,
      generatedAt: row.generatedAt?.toISOString() ?? new Date().toISOString(),
      model,
      cached: false,
      subjectScope: scope,
    };
  }

  private buildPrompt(
    past: PastPaperWeakTopic[],
    syllabus: SyllabusWeakTopic[],
  ): string {
    const pastList = past
      .map(
        (t) =>
          `- ${t.title} (${t.correct}/${t.answered} correct, ${Math.round(t.accuracy * 100)}%)`,
      )
      .join('\n');
    const syllabusList = syllabus
      .map(
        (t) =>
          `- ${t.title} (${t.correct}/${t.answered} correct, ${Math.round(t.accuracy * 100)}%)`,
      )
      .join('\n');
    return [
      `You are analysing a Ghanaian secondary-school student's recent WASSCE/BECE practice results.`,
      pastList ? `\nPast-paper topics they struggle with:\n${pastList}` : '',
      syllabusList
        ? `\nSyllabus topics they struggle with:\n${syllabusList}`
        : '',
      `\nWrite a 3–5 sentence narrative directly to the student. Tone: warm, specific, honest — like a supportive tutor, NOT a coach reading from a script. Reference at least two of the topics by name. End with ONE concrete next step (e.g. "Start with ${past[0]?.title ?? syllabus[0]?.title ?? 'the weakest topic'} — 10 questions, mixed difficulty."). Do not use markdown or headings. Do not repeat the accuracy percentages back to them.`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private buildBootstrapPrompt(): string {
    return [
      `You are welcoming a Ghanaian secondary-school student who has just signed up for WASSCE/BECE practice but hasn't answered enough questions yet for us to spot patterns.`,
      `\nWrite a 3-sentence welcome directly to the student. Tone: warm, specific, honest. Point out that we need a little more practice history before we can pick specific weak spots. Suggest a concrete first action: "Try 20 questions in a subject you feel weakest on so we can start spotting patterns." No markdown, no headings.`,
    ].join('\n');
  }
}

/**
 * Weakness-narrative system-shell — kept inline rather than in the
 * instruction-layer/ directory because it's a single, narrow use-case
 * (~5 lines) and doesn't share structure with the question-generation
 * or explanation shells there.
 */
const SYSTEM_SHELL_WEAKNESS_NARRATIVE = [
  `You write short, personalised feedback narratives for Ghanaian secondary-school students preparing for WASSCE/BECE.`,
  `Rules:`,
  `1. Write in plain prose. Never use markdown, headings, or bullet points.`,
  `2. Address the student in the second person ("you").`,
  `3. Never invent topics that weren't in the user prompt.`,
  `4. Never repeat the raw accuracy percentages back — the student already saw them.`,
  `5. If the user prompt describes a bootstrap case (no data), do not fabricate weaknesses.`,
].join('\n');
