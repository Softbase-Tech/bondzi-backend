import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExcludeController,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '../../common/types/enums';
import { CreateStimulusDto, UpdateStimulusDto } from './dto/stimulus.dto';
import { StimuliService } from './stimuli.service';

@ApiTags('admin-stimuli')
@ApiExcludeController()
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
@Controller('admin/stimuli')
export class StimuliAdminController {
  constructor(private readonly stimuli: StimuliService) {}

  @Get()
  @ApiOperation({
    summary:
      'List shared stimuli with usage counts. Optional ?search filter on title/body.',
  })
  list(@Query('search') search?: string, @Query('limit') limit?: string) {
    return this.stimuli.list({
      search,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get(':id')
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.stimuli.getById(id);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a stimulus (markdown body, optional title and image).',
  })
  create(
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: CreateStimulusDto,
  ) {
    return this.stimuli.create(admin.id, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateStimulusDto,
  ) {
    return this.stimuli.update(admin.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Delete a stimulus. Rejected with 409 if any questions still reference it.',
  })
  remove(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.stimuli.delete(admin.id, id);
  }
}
