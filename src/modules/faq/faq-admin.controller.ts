import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '../../common/types/enums';
import { FaqService } from './faq.service';
import { CreateFaqDto, UpsertFaqDto } from './dto/upsert-faq.dto';

/**
 * Admin CRUD for the FAQ catalogue. Retiring an entry flips
 * `is_active=false` — never a hard delete, so a live deep link from
 * an old share degrades to a retired page rather than a 404.
 */
@ApiTags('admin-faq')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
@Controller('admin/faq')
export class FaqAdminController {
  constructor(private readonly svc: FaqService) {}

  @Get()
  @ApiOperation({
    summary: 'Every FAQ entry, active and retired, in sort order.',
  })
  list() {
    return this.svc.listAllForAdmin();
  }

  @Post()
  @ApiOperation({ summary: 'Create a new FAQ entry.' })
  create(@Body() dto: CreateFaqDto) {
    return this.svc.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update fields on an FAQ entry.' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpsertFaqDto,
  ) {
    return this.svc.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({
    summary:
      'Retire an FAQ entry (soft-delete — hides from public list, keeps the slug reachable so live deep links degrade cleanly).',
  })
  retire(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.retire(id);
  }
}
