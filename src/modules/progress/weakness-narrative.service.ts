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
  /**
   * `bootstrap` — the user doesn't have enough signal for a
   * personalised narrative, so this is a canned welcome string (no
   * Bedrock call, no entitlement charge). The Home card hides itself
   * on this mode; setup screens keep showing it because the student
   * asked explicitly.
   *
   * `personalised` — Bedrock-generated prose referencing the user's
   * weak topics.
   */
  mode: 'bootstrap' | 'personalised';
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
        mode: cached.mode,
        model: cached.model,
        cached: true,
        subjectScope: scope,
      };
    }

    // 2. Look up weakness signal FIRST — before touching entitlements
    //    or Bedrock. Zero-signal users get canned bootstrap prose:
    //    no Bedrock call, no entitlement charge, and the Home client
    //    hides the card because `mode === 'bootstrap'`. This also
    //    prevents the "stuck welcome" bug where a morning-open cached
    //    bootstrap prose used to serve for the rest of the day.
    const data = await this.weakness.forUser(userId, {
      subjectId: filters.subjectId,
    });
    const hasSignal =
      data.pastPaperWeakTopics.length > 0 || data.syllabusWeakTopics.length > 0;

    if (!hasSignal) {
      const row = this.narrativesRepo.create({
        userId,
        day,
        subjectScope: scope,
        narrative: BOOTSTRAP_NARRATIVE,
        mode: 'bootstrap',
        model: 'canned',
      });
      await this.narrativesRepo.save(row);
      return {
        narrative: BOOTSTRAP_NARRATIVE,
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

    const prompt = this.buildPrompt(
      data.pastPaperWeakTopics,
      data.syllabusWeakTopics,
    );

    const model =
      this.config.get<string>('ai.defaultModel') ??
      'eu.anthropic.claude-haiku-4-5-20251001-v1:0';

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
      mode: 'personalised',
      model,
    });
    await this.narrativesRepo.save(row);
    return {
      narrative,
      generatedAt: row.generatedAt?.toISOString() ?? new Date().toISOString(),
      mode: 'personalised',
      model,
      cached: false,
      subjectScope: scope,
    };
  }

  /**
   * Drop bootstrap rows for today so the next call recomputes with
   * fresh signal. Called by ExamsService right after a submission
   * lands — the user may now have crossed the MIN_SAMPLES threshold
   * and we want the next Home visit to see the personalised narrative,
   * not the morning's cached "welcome" prose.
   *
   * Only deletes `mode = 'bootstrap'` rows — personalised rows stay
   * (they already cost a Bedrock call and shouldn't regenerate on
   * every exam finish, which would burn quota).
   */
  async invalidateBootstrapForToday(userId: string): Promise<void> {
    const day = accraDateIso();
    await this.narrativesRepo.delete({ userId, day, mode: 'bootstrap' });
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

}

/**
 * Canned bootstrap prose. Served instead of a Bedrock call whenever
 * the user has no weak-topic signal (< MIN_SAMPLES per topic in every
 * pool). Same shape as a personalised narrative so the UI doesn't
 * branch on structure — just on `mode`.
 */
const BOOTSTRAP_NARRATIVE =
  `Welcome — you're set up and ready. We haven't seen enough of your practice yet to spot where you're strongest or where you're getting stuck. Pick the subject you feel least confident in and try 10–20 questions there; once we see a few topics in a row, today's insight will call out exactly what to work on.`;

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
