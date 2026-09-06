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
  HttpCode,
  HttpStatus,
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
import {
  BillingLogProcessStatus,
  NotificationChannel,
  PaymentAttemptStatus,
  UserRole,
} from '../../common/types/enums';
import { AdminService } from './admin.service';
import { AdminJobsService } from './admin-jobs.service';
import { AdminNotificationsService } from './admin-notifications.service';
import { PaymentsService } from '../payments/payments.service';
import { PaymentAttemptsService } from '../payments/payment-attempts.service';
import { PaymentReconcileService } from '../payments/payment-reconcile.service';
import { BillingLogService } from '../payments/billing-log.service';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { BroadcastNotificationDto } from './dto/broadcast-notification.dto';
import { SendUserPushDto } from './dto/send-user-push.dto';
import { ReconcilePaymentDto } from './dto/reconcile-payment.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { UpdateUserContactDto } from './dto/update-user-contact.dto';

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
    private readonly paymentAttempts: PaymentAttemptsService,
    private readonly paymentReconcile: PaymentReconcileService,
    private readonly billingLog: BillingLogService,
  ) {}

  @Get('dashboard')
  dashboard() {
    return this.admin.dashboard();
  }

  @Get('users')
  listUsers(@Query() p: ListUsersQueryDto) {
    return this.admin.listUsers(p);
  }

  @Get('users/:id')
  getUser(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.admin.getUser(id);
  }

  @Get('users/:id/exams')
  listUserExams(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() p: PaginationDto,
  ) {
    return this.admin.listUserExams(id, p.page ?? 1, p.limit ?? 20);
  }

  @Get('users/:id/exams/:examId')
  getUserExam(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('examId', new ParseUUIDPipe()) examId: string,
  ) {
    return this.admin.getUserExam(id, examId);
  }

  @Patch('users/:id/ban')
  banUser(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    return this.admin.banUser(admin.id, id, req.ip);
  }

  @Patch('users/:id/contact')
  updateUserContact(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateUserContactDto,
    @Req() req: Request,
  ) {
    return this.admin.updateUserContact(admin.id, id, dto, req.ip);
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

  /**
   * Auth analytics — signups + login events broken down by platform.
   *
   * Data sources:
   *   • `users.signup_platform` (all-time + last-30d) — where each
   *     account was born.
   *   • `auth_login_events` (last 30d) — one row per real sign-in,
   *     sliced by platform × event type + a daily series.
   */
  @Get('analytics/auth')
  authAnalytics() {
    return this.admin.authAnalytics();
  }

  /**
   * Paginated payment_attempts feed — every checkout we initiated,
   * regardless of outcome. Replaces the legacy /admin/payments view
   * over raw payment_events, which conflated webhook deliveries with
   * checkout attempts and produced unreadable noise.
   *
   * Filter by status (pending / paid / failed / refunded / abandoned)
   * to drill into specific operational concerns — e.g. refund triage,
   * or "any abandoned in the last hour?".
   */
  @Get('payments')
  listPayments(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('status') status?: PaymentAttemptStatus,
    @Query('alarm') alarm?: 'duplicate_plus',
  ) {
    // `?alarm=duplicate_plus` surfaces every payment_attempt the
    // system flagged for refund (user was charged for Plus on a
    // level they already owned). The system never silently absorbs
    // a duplicate Plus charge — it flags and the operator refunds in
    // the Paystack dashboard.
    return this.paymentAttempts.listAll({
      limit: limit ? parseInt(limit, 10) : 50,
      offset: offset ? parseInt(offset, 10) : 0,
      status,
      alarm: alarm === 'duplicate_plus' ? 'duplicate_plus' : undefined,
    });
  }

  /**
   * Reconcile a Paystack transaction that has money at the provider
   * but no record here (popup channel-switch retries, missed
   * webhooks). Verifies server-to-server, synthesises the missing
   * payment_attempt at catalogue price, then drives the normal verify
   * → activation path so MRR / audit / receipt all stay truthful.
   */
  @Post('payments/reconcile')
  @HttpCode(HttpStatus.OK)
  reconcilePayment(
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: ReconcilePaymentDto,
  ) {
    return this.paymentReconcile.reconcile(admin.id, dto);
  }

  /**
   * Append-only raw-payload sink for webhooks. The
   * `process_status='no_matching_payment'` filter is the canonical
   * security view — every alarmed event lives there.
   */
  @Get('billing-log')
  listBillingLog(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('processStatus') processStatus?: BillingLogProcessStatus,
  ) {
    return this.billingLog.listAll({
      limit: limit ? parseInt(limit, 10) : 50,
      offset: offset ? parseInt(offset, 10) : 0,
      processStatus,
    });
  }

  /**
   * Legacy raw webhook-events view. Kept under a dedicated URL for the
   * one operational case it still serves — debugging webhook
   * signatures and Paystack idempotency. Most operators now want
   * /admin/payments or /admin/billing-log instead.
   */
  @Get('payment-events')
  listPaymentEvents() {
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

  /**
   * Send a push to ONE user. Body carries title + body + optional
   * deep link; the actor admin id is stamped server-side so the
   * /admin/notifications log can attribute the row.
   */
  @Post('notifications/user/:userId/push')
  sendPushToUser(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: SendUserPushDto,
  ) {
    return this.adminNotifications.sendToUser(admin.id, userId, dto);
  }

  /**
   * Paginated read of every notification ever sent. Used by the
   * /admin/notifications log viewer. Filters: channel, type
   * (`data.type`), userId. Rows are auto-pruned after 90 days
   * (NotificationRetentionJob) so unbounded reads are safe.
   */
  @Get('notifications')
  listNotifications(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('userId') userId?: string,
    @Query('channel') channel?: NotificationChannel,
    @Query('type') type?: string,
  ) {
    return this.adminNotifications.listAll({
      limit: limit ? parseInt(limit, 10) : 50,
      offset: offset ? parseInt(offset, 10) : 0,
      userId,
      channel,
      type,
    });
  }
}
