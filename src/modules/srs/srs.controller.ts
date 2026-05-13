import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';
import { SrsService } from './srs.service';
import { ReviewDto } from './dto/review.dto';

@ApiTags('srs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('srs')
export class SrsController {
  constructor(private readonly srs: SrsService) {}

  @Get('due')
  @ApiOperation({ summary: 'Questions due for review today.' })
  due(
    @CurrentUser() user: AuthenticatedUser,
    @Query('subjectId') subjectId?: string,
  ) {
    return this.srs.getDue(user.id, subjectId);
  }

  @Post(':questionId/review')
  @ApiOperation({ summary: 'Submit an SRS review. quality 0-5.' })
  review(
    @CurrentUser() user: AuthenticatedUser,
    @Param('questionId', new ParseUUIDPipe()) questionId: string,
    @Body() dto: ReviewDto,
  ) {
    return this.srs.review(user.id, questionId, dto.quality);
  }

  @Get('stats')
  stats(@CurrentUser() user: AuthenticatedUser) {
    return this.srs.stats(user.id);
  }
}
