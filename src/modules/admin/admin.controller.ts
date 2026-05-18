import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeController, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';
import { UserRole } from '../../common/types/enums';
import { AdminService } from './admin.service';
import { AdminJobsService } from './admin-jobs.service';
import { AdminNotificationsService } from './admin-notifications.service';
import { PaymentsService } from '../payments/payments.service';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { BroadcastNotificationDto } from './dto/broadcast-notification.dto';

@ApiTags('admin')
@ApiExcludeController()
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly adminJobs: AdminJobsService,
    private readonly adminNotifications: AdminNotificationsService,
    private readonly payments: PaymentsService,
  ) {}

  @Get('dashboard')
  dashboard() {
    return this.admin.dashboard();
  }

  @Get('users')
  listUsers(@Query() p: PaginationDto) {
    return this.admin.listUsers(p);
  }

  @Get('users/:id')
  getUser(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.admin.getUser(id);
  }

  @Patch('users/:id/ban')
  banUser(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    return this.admin.banUser(admin.id, id, req.ip);
  }

  @Get('questions/flags')
  listFlags(@Query() p: PaginationDto) {
    return this.admin.listFlags(p);
  }

  @Post('questions/flags/:id/resolve')
  resolveFlag(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    return this.admin.resolveFlag(admin.id, id, req.ip);
  }

  @Get('ai/usage')
  aiUsage() {
    return this.admin.aiUsageBreakdown();
  }

  @Get('payments')
  listPayments() {
    return this.payments.listEvents(200);
  }

  @Get('financial-events')
  listFinancialEvents(
    @Query('limit') limit?: string,
    @Query('userId') userId?: string,
    @Query('eventType') eventType?: string,
    @Query('source') source?: string,
    @Query('since') since?: string,
  ) {
    const safeLimit = Math.min(
      Math.max(parseInt(limit ?? '100', 10) || 100, 1),
      500,
    );
    return this.payments.listFinancialEvents({
      limit: safeLimit,
      userId,
      eventType,
      source,
      since: since ? new Date(since) : undefined,
    });
  }

  @Get('subscriptions')
  listSubscriptions(@Query() p: PaginationDto) {
    return this.admin.listSubscriptions(p);
  }

  @Get('audit')
  listAudit(@Query() p: PaginationDto) {
    return this.admin.listAudit(p);
  }

  @Get('jobs')
  listJobs() {
    return this.adminJobs.list();
  }

  @Get('jobs/:queue/failed')
  failedJobs(@Param('queue') queue: string, @Query('limit') limit?: string) {
    return this.adminJobs.failed(queue, limit ? parseInt(limit, 10) : 50);
  }

  @Post('notifications')
  broadcastNotification(@Body() dto: BroadcastNotificationDto) {
    return this.adminNotifications.broadcast(dto);
  }
}
