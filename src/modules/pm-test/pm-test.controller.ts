import {
  Controller,
  Get,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RequiresSubscription } from '../../common/decorators/subscription.decorator';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { PmTestService } from './pm-test.service';

@ApiTags('pm-test')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@RequiresSubscription()
@Controller('pm-test')
export class PmTestController {
  constructor(private readonly pmTest: PmTestService) {}

  @Get('subjects')
  @ApiOperation({
    summary:
      "Subjects with active PM Test questions for current user's exam/form level.",
  })
  subjects(@CurrentUser() user: AuthenticatedUser) {
    return this.pmTest.listSubjectsForUser(user.id);
  }

  @Get('questions')
  @ApiOperation({ summary: 'Randomised PM Test questions for a subject.' })
  questions(
    @CurrentUser() user: AuthenticatedUser,
    @Query('subjectId', new ParseUUIDPipe()) subjectId: string,
    @Query('formLevel') formLevel?: string,
    @Query('limit') limit?: string,
  ) {
    return this.pmTest.listQuestions(user.id, {
      subjectId,
      formLevel: formLevel ? parseInt(formLevel, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get('stats')
  @ApiOperation({ summary: 'PM Test performance by subject.' })
  stats(@CurrentUser() user: AuthenticatedUser) {
    return this.pmTest.statsForUser(user.id);
  }
}
