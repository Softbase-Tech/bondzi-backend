import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { IsInt, Max, Min } from 'class-validator';
import { Repository } from 'typeorm';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { EntitlementService } from '../../common/types/enums';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { inlineMathInMarkdown } from '../../common/utils/math.util';
import { splitExplanationSections } from './explanation-sections.util';
import { Question } from './entities/question.entity';
import { PmTestQuestion } from '../pm-test/entities/pm-test-question.entity';
import { ExamAnswer } from '../exams/entities/exam-answer.entity';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Vote body for POST /explanations/:id/vote. -1 = downvote, 0 = clear, 1 = up.
 * Stored only as aggregated counts on the question row today — the vote ledger
 * (`explanation_votes` table) is a future enhancement. For now we accept and
 * silently no-op so the mobile path doesn't 404.
 */
class ExplanationVoteDto {
  @IsInt()
  @Min(-1)
  @Max(1)
  vote!: -1 | 0 | 1;
}

/**
 * Public-facing explanations endpoint backing the mobile / web client. The
 * AI / human explanation text is stored INLINE on the question row (see
 * `Question.explanation`), so this controller does not need a separate
 * explanations table — it just reads the field and gates it on the user's
 * per-level entitlement.
 *
 * Why this lives in the questions module: explanations are a denormalised
 * column on `questions`, not a standalone aggregate. Splitting them into a
 * separate module would just create a circular dependency around the
 * Question repository.
 */
@ApiTags('explanations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('explanations')
export class ExplanationsController {
  private readonly logger = new Logger(ExplanationsController.name);

  constructor(
    @InjectRepository(Question)
    private readonly questions: Repository<Question>,
    @InjectRepository(PmTestQuestion)
    private readonly pmTestQuestions: Repository<PmTestQuestion>,
    @InjectRepository(ExamAnswer)
    private readonly examAnswers: Repository<ExamAnswer>,
    private readonly entitlements: EntitlementsService,
  ) {}

  @Get(':questionId')
  @ApiOperation({
    summary:
      'Fetch the inline AI / human explanation for a question. Gated by the AI_EXPLANATIONS entitlement — Free=disabled (403), Plus=20/day (429 on 21st), Pro=unlimited. The quota point is consumed only on a successful fetch. Optional ?examId= marks the exam answer as explanation-viewed.',
  })
  async get(
    @Param('questionId', new ParseUUIDPipe()) questionId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query('examId') examId?: string,
  ) {
    // Question ids can point at either the past-paper `questions` table or
    // the AI-generated `pm_test_questions` table — same UUID namespace,
    // different homes. Try past-paper first, fall back to pm-test on
    // miss. Without this branching every Level Test wrong answer showed
    // "Could not load explanation." in the app, since the pm-test row
    // came back null → 404 → mobile fallback string.
    let source: {
      id: string;
      explanation: string | null;
      explanationHtml: string | null;
      explanationModel: string | null;
      explanationGeneratedAt: Date | null;
    } | null = await this.questions.findOne({
      where: { id: questionId },
      select: [
        'id',
        'explanation',
        'explanationHtml',
        'explanationModel',
        'explanationGeneratedAt',
      ],
    });

    if (!source) {
      const pm = await this.pmTestQuestions.findOne({
        where: { id: questionId },
        select: ['id', 'explanation'],
      });
      if (pm) {
        // `pm_test_questions` doesn't carry the html/model/generatedAt
        // columns — those live on the past-paper `questions` table. The
        // explanation itself is generated inline at AI generation time,
        // so we synthesise the envelope from what pm_test does store.
        source = {
          id: pm.id,
          explanation: pm.explanation,
          explanationHtml: null,
          explanationModel: 'ai',
          explanationGeneratedAt: null,
        };
      }
    }

    if (!source) throw new NotFoundException('Question not found');
    if (!source.explanation) {
      // Quota fairness (remediation C-zero #5): metering happens AFTER
      // this check, so a missing explanation no longer burns one of a
      // Plus student's 20 daily points. The old @RequiresService guard
      // consumed the point before the DB read — 404s and repeat views
      // both charged.
      throw new NotFoundException(
        'No explanation has been generated for this question yet.',
      );
    }
    // Consume-after-success: the content exists, so charge the quota
    // point now (403 for Free, 429 for Plus at cap — same semantics as
    // the old guard, minus the charge-on-failure).
    await this.entitlements.assertAndConsume(
      user.id,
      EntitlementService.AI_EXPLANATIONS,
    );

    // Explanation-viewed instrumentation (premium plan §3.2): when the
    // client passes the exam context, flip the dead
    // exam_answers.explanation_viewed flag — ownership-checked via the
    // exam row so one student can't mark another's answers.
    if (examId && UUID_RE.test(examId)) {
      try {
        await this.examAnswers.query(
          `update "exam_answers" a
              set "explanation_viewed" = true
            from "exams" e
           where a."exam_id" = e."id"
             and a."exam_id" = $1
             and a."question_id" = $2
             and e."user_id" = $3`,
          [examId, questionId, user.id],
        );
      } catch (err) {
        // Telemetry, never a failure path for the student.
        this.logger.warn(
          `[explanation-viewed] update failed exam=${examId} q=${questionId}: ${(err as Error).message}`,
        );
      }
    }

    // Split into the concise solution + the optional worked example so the
    // client can render them on separate surfaces (inline card vs. sheet)
    // and hide the worked-example affordance when there isn't one.
    const sections = splitExplanationSections(source.explanation);
    return {
      questionId: source.id,
      // Mobile schema accepts `source` as a free string and normalises
      // via `s.startsWith('ai')`. Existing rows are AI-generated.
      source: source.explanationModel ? 'ai' : 'human',
      // Inline any `$...$` LaTeX to SVG data-URIs BEFORE returning —
      // the mobile MathMarkdown renderer only handles the SVG shape,
      // not raw LaTeX. `toStudentQuestion` runs the same treatment on
      // question-embedded explanations (question.serializer.ts); the
      // standalone endpoint was forgetting to do it, so explanations
      // fetched via GET /explanations/:id rendered as literal
      // `\frac{}` / `\times` / `$...$` text.
      //
      // `content` is the full blob (kept for backward compatibility with
      // clients that render it whole); `solution` / `workedExample` are the
      // split view the current mobile app consumes.
      content: inlineMathInMarkdown(source.explanation),
      solution: inlineMathInMarkdown(sections.solution),
      workedExample: sections.workedExample
        ? inlineMathInMarkdown(sections.workedExample)
        : null,
      contentHtml: source.explanationHtml,
      generatedAt: source.explanationGeneratedAt?.toISOString() ?? null,
    };
  }

  @Post(':questionId/vote')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Record an up/down vote on an explanation. Stored as no-op today — vote ledger is a future enhancement.',
  })
  async vote(
    @Param('questionId', new ParseUUIDPipe()) questionId: string,
    @Body() body: ExplanationVoteDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ ok: true }> {
    // Existence check so the client gets a 404 for unknown questions
    // (the mobile shows a toast on error). Question ids can point at
    // either the past-paper or the pm-test table — try past-paper
    // first, fall back to pm-test on miss.
    const exists =
      (await this.questions.exists({ where: { id: questionId } })) ||
      (await this.pmTestQuestions.exists({ where: { id: questionId } }));
    if (!exists) throw new NotFoundException('Question not found');
    // Log the vote attempt so we have a paper trail until the ledger
    // table lands. The @Body() and @CurrentUser() decorators remain so
    // class-validator runs (the DTO enforces vote ∈ {-1, 0, 1}) and the
    // JWT guard hydrates the user — both important for the future
    // ledger insert.
    this.logger.log(
      `[explanation-vote] user=${user.id} question=${questionId} vote=${body.vote}`,
    );
    return { ok: true };
  }
}
