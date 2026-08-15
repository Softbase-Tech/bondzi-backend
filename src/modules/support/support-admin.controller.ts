import {
  Body,
  Controller,
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
import { PaginationDto } from '../../common/dto/pagination.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '../../common/types/enums';
import { CloseTicketDto, CreateMessageDto } from './dto/create-ticket.dto';
import { SupportTicketsService } from './support-tickets.service';

/**
 * Admin support routes under `/admin/support/tickets`.
 *
 * Read: paginated queue with filter/search + per-ticket detail.
 * Write: reply, and close-with-reason. Close is the only status
 * transition — a re-open action is intentionally missing; the
 * student can open a new ticket referencing the closed one and ops
 * has that trail in `relatedTicketNumber`.
 */
@ApiTags('admin/support')
@ApiExcludeController()
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
@Controller('admin/support/tickets')
export class SupportAdminController {
  constructor(private readonly svc: SupportTicketsService) {}

  @Get()
  @ApiOperation({ summary: 'Support queue for triage.' })
  list(
    @Query() p: PaginationDto,
    @Query('status') status?: 'open' | 'closed',
    @Query('category')
    category?: 'feedback' | 'wrong_question' | 'payment' | 'general',
    @Query('search') search?: string,
  ) {
    return this.svc.listForAdmin({
      status,
      category,
      search,
      page: p.page ?? 1,
      limit: p.limit ?? 25,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Ticket detail with the full message thread.' })
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.svc.getForAdmin(id);
  }

  @Post(':id/messages')
  @ApiOperation({
    summary: 'Reply on an open ticket. 400 if the ticket is already closed.',
  })
  reply(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CreateMessageDto,
  ) {
    return this.svc.replyAsAdmin(user.id, id, dto);
  }

  @Patch(':id/close')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Close a ticket (records who + optional reason).' })
  close(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CloseTicketDto,
  ) {
    return this.svc.closeAsAdmin(user.id, id, dto);
  }
}
