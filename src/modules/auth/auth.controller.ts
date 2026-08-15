import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { ExamType } from '../../common/types/enums';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { SendOtpDto, VerifyOtpDto } from './dto/otp.dto';
import { RefreshDto } from './dto/refresh.dto';
import { ForgotPasswordDto, ResetPasswordDto } from './dto/email-auth.dto';
import { GoogleSignInDto } from './dto/google.dto';

const DEVICE_ID_HEADER = 'x-device-id';
const DEVICE_NAME_HEADER = 'x-device-name';

/**
 * Spec §2.2: "Extract X-Device-ID header from request (client generates UUID
 * on install, persists in SecureStorage)." The mobile app sends it as a
 * header; we also accept it in the request body for local dev / Swagger.
 * Header takes precedence so a client can't accidentally pass a stale body
 * value after rotating the SecureStorage fingerprint.
 */
function pickDeviceId(req: Request, bodyValue?: string): string {
  const header = req.headers[DEVICE_ID_HEADER];
  const headerStr = Array.isArray(header) ? header[0] : header;
  const resolved = (headerStr && headerStr.trim()) || bodyValue;
  if (!resolved) {
    throw new BadRequestException(
      'deviceId is required (send via X-Device-ID header or body).',
    );
  }
  return resolved;
}

function pickDeviceName(req: Request, bodyValue?: string): string | undefined {
  const header = req.headers[DEVICE_NAME_HEADER];
  const headerStr = Array.isArray(header) ? header[0] : header;
  return (headerStr && headerStr.trim()) || bodyValue;
}

class SendEmailOtpDto {
  @IsEmail()
  email!: string;

  /** Optional display name — used in the greeting line of the OTP email. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  recipientName?: string;
}

class UpdateExamTypeDto {
  @IsEnum(ExamType)
  examType!: ExamType;

  /**
   * Required when switching TO BECE / WASSCE; MUST be omitted (or null)
   * when switching TO NOVDEC — remedial students have no form. Mirrors
   * the register DTO's branching rule so the two flows can't drift.
   */
  @ValidateIf((o: UpdateExamTypeDto) => o.examType !== ExamType.NOVDEC)
  @IsInt()
  @Min(1)
  @Max(3)
  formLevel?: number | null;

  /**
   * Optional body override for the X-Device-ID header. The service
   * uses it to bind the rotated JWT pair (issued on examType change)
   * to the calling device's session. Clients that already send the
   * header can omit this; only here so curl/postman test flows work.
   */
  @IsOptional()
  @IsString()
  deviceId?: string;

  @IsOptional()
  @IsString()
  deviceName?: string;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
  ) {}

  /**
   * Public availability check used by the mobile register / profile-edit
   * "is this handle free?" hint. Format rules also validated here so the
   * server is the single source of truth — an obviously-invalid input
   * (`abc`, `with space`) gets an explanatory `reason` without us
   * inventing a JWT-bearing endpoint just for the typed-as-you-go UI.
   */
  @Public()
  @Get('username/available')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Check whether a username is free. Returns { available, reason?, message? }.',
  })
  async checkUsername(@Query('q') q?: string) {
    return this.users.checkUsernameAvailability(q ?? '');
  }

  @Public()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Register a new student account (email or phone).' })
  register(@Body() dto: RegisterDto, @Req() req: Request) {
    const deviceId = pickDeviceId(req, dto.deviceId);
    return this.auth.register(
      { ...dto, deviceId, deviceName: pickDeviceName(req, dto.deviceName) },
      {
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      },
    );
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 15 * 60_000 } })
  @ApiOperation({ summary: 'Password login — accepts email OR phone.' })
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.auth.login(
      { email: dto.email, phone: dto.phone },
      dto.password,
      {
        ip: req.ip,
        deviceId: pickDeviceId(req, dto.deviceId),
        deviceName: pickDeviceName(req, dto.deviceName),
      },
    );
  }

  @Public()
  @Post('otp/send')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 3, ttl: 10 * 60_000 } })
  @ApiOperation({ summary: 'Send SMS OTP to a phone number.' })
  sendOtp(@Body() dto: SendOtpDto) {
    return this.auth.sendOtp(dto.phone);
  }

  @Public()
  @Post('otp/verify')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 10 * 60_000 } })
  @ApiOperation({ summary: 'Verify SMS OTP and return token pair.' })
  verifyOtp(@Body() dto: VerifyOtpDto, @Req() req: Request) {
    return this.auth.verifyOtp(dto.phone, dto.code, {
      ip: req.ip,
      deviceId: pickDeviceId(req, dto.deviceId),
      deviceName: pickDeviceName(req, dto.deviceName),
    });
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 15 * 60_000 } })
  @ApiOperation({ summary: 'Request a password-reset email.' })
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.auth.forgotPassword({
      email: dto.email,
      phone: dto.phone,
    });
  }

  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 15 * 60_000 } })
  @ApiOperation({
    summary:
      'Set a new password using a 6-digit OTP code (delivered by email or SMS depending on which identifier forgot-password was called with).',
  })
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.auth.resetPassword({
      email: dto.email,
      phone: dto.phone,
      otp: dto.otp,
      password: dto.password,
    });
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Post('email/verify')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 10 * 60_000 } })
  @ApiOperation({
    summary:
      "Verify the caller's email via the 6-digit OTP code that was sent by /email/verify-request. Replaces the legacy `?token=` link.",
  })
  verifyEmailCode(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { code?: string },
  ) {
    const code = (body.code ?? '').trim();
    if (!/^\d{6}$/.test(code)) {
      throw new BadRequestException('code must be a 6-digit number');
    }
    return this.auth.verifyEmailCode(user.id, code);
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Post('email/verify-request')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 3, ttl: 10 * 60_000 } })
  @ApiOperation({
    summary:
      "Send a 6-digit OTP code to the caller's email address for verification. The code is entered on the mobile via POST /auth/email/verify.",
  })
  requestEmailVerification(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.requestEmailVerification(user.id);
  }

  /**
   * Pre-registration email OTP. Public — there's no account yet. The
   * returned `expiresInSeconds` lets the mobile show a count-down /
   * resend cooldown matching the server's window. Anti-enumeration:
   * we always return 200 with the same payload even when the email
   * is already registered, so callers can't probe for existing
   * accounts (the user would get a "this email is already
   * registered" error on the subsequent /auth/register call
   * instead).
   *
   * Throttled aggressively at the controller level on top of the
   * per-email bucket inside OtpService (3/10 min).
   */
  @Public()
  @Post('email/otp/send')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 10 * 60_000 } })
  @ApiOperation({
    summary: 'Send a 6-digit email OTP for pre-registration verification.',
  })
  sendEmailOtp(@Body() dto: SendEmailOtpDto) {
    return this.auth.sendEmailOtp(dto.email, dto.recipientName);
  }

  @Public()
  @Post('google')
  @HttpCode(HttpStatus.OK)
  // Google ID-token verification hits Google's JWKS endpoint per call —
  // CPU + outbound; cap so a bot can't pin the worker on dud tokens.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Sign in with a Google ID token.' })
  google(@Body() dto: GoogleSignInDto, @Req() req: Request) {
    return this.auth.googleSignIn(dto.idToken, {
      ip: req.ip,
      deviceId: pickDeviceId(req, dto.deviceId),
      deviceName: pickDeviceName(req, dto.deviceName),
      examType: dto.examType,
      formLevel: dto.formLevel,
      referralCode: dto.referralCode,
    });
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  // Refresh tokens live 30d. Without a throttle, a leaked refresh token
  // can be rotated at machine speed (and stuffed credential-style
  // against any user). 30/min is plenty for legit clients that refresh
  // ~once per access-token-window.
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Exchange a refresh token for a new pair (rotates).',
  })
  refresh(@Body() dto: RefreshDto, @Req() req: Request) {
    return this.auth.refresh(dto.refreshToken, { ip: req.ip });
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    const authHeader = req.headers.authorization ?? '';
    const [, token] = authHeader.split(' ');
    let exp: number | undefined;
    if (token) {
      try {
        const payload = JSON.parse(
          Buffer.from(token.split('.')[1], 'base64').toString('utf8'),
        ) as { exp?: number };
        exp = payload.exp;
      } catch {
        /* ignore */
      }
    }
    // Under per-device enforcement, `logout` closes only THIS device's
    // session. `user.did` comes from the access token's `did` claim
    // (see AuthenticatedUser). Legacy tokens without a `did` fall
    // through to a full sign-out (safer default than a no-op).
    await this.auth.logout(user.id, user.jti, exp, user.did);
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke all device sessions for this user.' })
  async logoutAll(@CurrentUser() user: AuthenticatedUser) {
    await this.auth.logoutAll(user.id);
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Get('me')
  @ApiOperation({
    summary: 'Return the authenticated user profile + current subscription.',
  })
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.getMe(user.id);
  }

  @Public()
  @Get('referral/check')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Validate a referral code — called during registration before submit.',
  })
  async checkReferral(@Query('code') code?: string) {
    // Normalise: trim, upper-case, and strip any legacy formatting
    // (leading "PM-", internal dashes, or stray whitespace). This
    // keeps old flyers / screenshots that show the pre-migration
    // `PM-XXXX-YYY` shape usable without forcing the student to
    // guess which characters count.
    const trimmed = (code ?? '')
      .trim()
      .toUpperCase()
      .replace(/^PM-/, '')
      .replace(/-/g, '');
    if (!trimmed) return { valid: false };
    return this.auth.checkReferralCode(trimmed);
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Patch('me/exam-type')
  // Anti-leaderboard-farming: a SHS student could otherwise flip BECE ↔
  // WASSCE to dominate a less-competitive board, then flip back. Audit
  // trail is the real defense (see AuthService.updateExamType) but a
  // hard throttle blunts the abuse window further. 3 changes per hour
  // is comfortably above any legitimate use.
  @Throttle({ default: { limit: 3, ttl: 60 * 60_000 } })
  @ApiOperation({
    summary:
      "Change the user's exam type + form level. schoolLevel is derived.",
  })
  updateExamType(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateExamTypeDto,
    @Req() req: Request,
  ) {
    // Pull the deviceId off the standard header (same path used by
    // login/register) so the rotated session is bound to the device
    // making this call. The service rotates the JWT pair only when
    // the examType actually changes; otherwise tokens=null and the
    // client keeps its current tokens.
    const deviceId = (() => {
      try {
        return pickDeviceId(req, body.deviceId);
      } catch {
        // Server-side admin tools / future flows may invoke this
        // without a device — fall back to no-rotation so the user's
        // examType still updates. The cache invalidation still fires
        // server-side, so the staleness window is bounded by the
        // JWT TTL only.
        return null;
      }
    })();
    return this.auth.updateExamType(
      user.id,
      body.examType,
      body.formLevel ?? null,
      deviceId
        ? {
            deviceId,
            ip: req.ip,
            deviceName: pickDeviceName(req, body.deviceName),
            // The current request's JWT jti + exp let the service
            // revoke the pre-rotation access token immediately — so
            // any cached copy of it (in-flight retries, background
            // sync, push handlers that woke just before the rotation)
            // is invalidated by the JwtStrategy on its next use,
            // closing the up-to-15-min staleness window the JWT TTL
            // would otherwise leave open.
            currentJti: user.jti,
            currentExp: user.exp,
          }
        : null,
    );
  }
}
