import { ArrayMaxSize, ArrayUnique, IsArray, IsUUID } from 'class-validator';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';
import { UsersService } from './users.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdateEmailPreferencesDto } from './dto/update-email-preferences.dto';
import { ChangePasswordDto } from '../auth/dto/change-password.dto';

class SetSubjectsDto {
  /**
   * Subjects the user wants to actively study. An empty array means
   * "no preference, show me everything" (the home tab renders every
   * subject in that case). The service validates that every ID belongs
   * to the user's current exam type — cross-level smuggling is
   * rejected at the boundary.
   */
  @IsArray()
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  subjectIds!: string[];
}

@ApiTags('users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  @ApiOperation({
    summary: 'Full profile, current subscription, and per-subject progress.',
  })
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.users.getMe(user.id);
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update displayable profile fields.' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.users.updateProfile(user.id, dto);
  }

  @Patch('me/email-preferences')
  @ApiOperation({ summary: 'Update engagement email preferences.' })
  updateEmailPreferences(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateEmailPreferencesDto,
  ) {
    return this.users.updateEmailPreferences(user.id, dto);
  }

  @Patch('me/password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Change password after verifying current.' })
  async changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
  ) {
    await this.users.changePassword(user.id, dto);
  }

  @Delete('me')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Soft-delete account. PII anonymised by scheduled job after 30 days.',
  })
  async softDelete(@CurrentUser() user: AuthenticatedUser) {
    await this.users.softDelete(user.id);
  }

  @Get('me/progress')
  progress(@CurrentUser() user: AuthenticatedUser) {
    return this.users.getProgress(user.id);
  }

  @Get('me/stats')
  stats(@CurrentUser() user: AuthenticatedUser) {
    return this.users.getStats(user.id);
  }

  @Get('me/subjects')
  @ApiOperation({
    summary:
      "List the subject IDs the user has actively selected. Empty array = no preference (home tab renders every subject for the user's exam type).",
  })
  async getSubjects(@CurrentUser() user: AuthenticatedUser) {
    const subjectIds = await this.users.getSelectedSubjectIds(user.id);
    return { subjectIds };
  }

  @Put('me/subjects')
  @ApiOperation({
    summary:
      "Replace the user's subject selection. Soft-filter only — the backend doesn't enforce this on question / exam queries; mobile uses it to personalise the home tab and the practice grid.",
  })
  async setSubjects(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: SetSubjectsDto,
  ) {
    return this.users.setSelectedSubjects(user.id, body.subjectIds);
  }
}
