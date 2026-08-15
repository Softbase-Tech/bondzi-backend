import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CreateMessageDto, CreateTicketDto } from './dto/create-ticket.dto';
import { SupportTicketsService } from './support-tickets.service';

/**
 * User-facing support endpoints. Every route is scoped to
 * `CurrentUser().id` inside the service — a student cannot see or
 * touch another student's ticket even if they know its uuid.
 */
@ApiTags('support')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('support/tickets')
export class SupportController {
  constructor(private readonly svc: SupportTicketsService) {}

  @Get()
  @ApiOperation({ summary: 'List the signed-in user’s support tickets.' })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.svc.listForUser(user.id);
  }

  @Post()
  @ApiOperation({
    summary: 'Open a new support ticket (feedback / wrong-question / etc.).',
  })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateTicketDto) {
    return this.svc.createForUser(user.id, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Fetch the message thread on one ticket.' })
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.svc.getForUser(user.id, id);
  }

  @Post(':id/messages')
  @ApiOperation({
    summary: 'Reply on an open ticket. 400 if the ticket is closed.',
  })
  reply(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CreateMessageDto,
  ) {
    return this.svc.replyAsUser(user.id, id, dto);
  }
}
