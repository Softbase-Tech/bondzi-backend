import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
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
import { AccountType } from '../../common/types/enums';
import { Question } from './entities/question.entity';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';

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
  constructor(
    @InjectRepository(Question)
    private readonly questions: Repository<Question>,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  @Get(':questionId')
  @ApiOperation({
    summary:
      'Fetch the inline AI / human explanation for a question. Gated by per-level Plus/Pro entitlement.',
  })
  async get(
    @Param('questionId', new ParseUUIDPipe()) questionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
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
    // Entitlement gate: Plus or Pro on the user's CURRENT level.
    // Matches the convention used elsewhere in the codebase
    // (questions.controller.list/pastPaper/adaptive). The reason we use
    // the user's level rather than the question's: NOVDEC users share
    // the WASSCE question pool but pay for NOVDEC. Gating on the
    // question's exam_type would lock a NOVDEC Plus holder out of every
    // shared question.
    const ok = await this.subscriptions.hasEntitlement(
      user.id,
      user.examType,
      AccountType.PLUS,
    );
    if (!ok) {
      throw new ForbiddenException(
        'Upgrade to Plus or Pro on this level to unlock AI explanations.',
      );
    }
    return {
      questionId: question.id,
      // Mobile schema accepts `source` as a free string and normalises
      // via `s.startsWith('ai')`. Existing rows are AI-generated.
      source: question.explanationModel ? 'ai' : 'human',
      content: question.explanation,
      contentHtml: question.explanationHtml,
      generatedAt:
        question.explanationGeneratedAt?.toISOString() ?? null,
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
    @Body() _body: ExplanationVoteDto,
    @CurrentUser() _user: AuthenticatedUser,
  ): Promise<{ ok: true }> {
    // Existence check so the client gets a 404 for unknown questions
    // (the mobile shows a toast on error). The actual vote write lands
    // when the explanation_votes table is added.
    const exists = await this.questions.exists({
      where: { id: questionId },
    });
    if (!exists) throw new NotFoundException('Question not found');
    return { ok: true };
  }
}
