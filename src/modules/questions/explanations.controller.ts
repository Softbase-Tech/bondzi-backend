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
import { RequiresService } from '../entitlements/requires-service.decorator';
import { inlineMathInMarkdown } from '../../common/utils/math.util';
import { Question } from './entities/question.entity';

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
  ) {}

  @Get(':questionId')
  @RequiresService(EntitlementService.AI_EXPLANATIONS)
  @ApiOperation({
    summary:
      'Fetch the inline AI / human explanation for a question. Gated by the AI_EXPLANATIONS entitlement — Free=disabled (403), Plus=20/day (429 on 21st), Pro=unlimited.',
  })
  async get(@Param('questionId', new ParseUUIDPipe()) questionId: string) {
    const question = await this.questions.findOne({
      where: { id: questionId },
      select: [
        'id',
        'explanation',
        'explanationHtml',
        'explanationModel',
        'explanationGeneratedAt',
      ],
    });
    if (!question) throw new NotFoundException('Question not found');
    if (!question.explanation) {
      throw new NotFoundException(
        'No explanation has been generated for this question yet.',
      );
    }
    // @RequiresService(AI_EXPLANATIONS) has already run (and consumed one
    // quota point) by the time this handler executes — see
    // RequiresServiceGuard. If the user was Free-tier, we returned 403
    // before reading the DB; if they were Plus at the cap, 429; otherwise
    // we're through the gate with usedCount already bumped for the day.
    return {
      questionId: question.id,
      // Mobile schema accepts `source` as a free string and normalises
      // via `s.startsWith('ai')`. Existing rows are AI-generated.
      source: question.explanationModel ? 'ai' : 'human',
      // Inline any `$...$` LaTeX to SVG data-URIs BEFORE returning —
      // the mobile MathMarkdown renderer only handles the SVG shape,
      // not raw LaTeX. `toStudentQuestion` runs the same treatment on
      // question-embedded explanations (question.serializer.ts); the
      // standalone endpoint was forgetting to do it, so explanations
      // fetched via GET /explanations/:id rendered as literal
      // `\frac{}` / `\times` / `$...$` text.
      content: inlineMathInMarkdown(question.explanation),
      contentHtml: question.explanationHtml,
      generatedAt: question.explanationGeneratedAt?.toISOString() ?? null,
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
    // (the mobile shows a toast on error). The actual vote write lands
    // when the explanation_votes table is added.
    const exists = await this.questions.exists({
      where: { id: questionId },
    });
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
