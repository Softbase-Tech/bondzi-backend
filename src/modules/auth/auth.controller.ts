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
import { IsEnum, IsInt, Max, Min } from 'class-validator';
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
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { SendOtpDto, VerifyOtpDto } from './dto/otp.dto';
import { RefreshDto } from './dto/refresh.dto';
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

class UpdateExamTypeDto {
  @IsEnum(ExamType)
  examType!: ExamType;

  @IsInt()
  @Min(1)
  @Max(3)
  formLevel!: number;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

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
  @ApiOperation({ summary: 'Email + password login.' })
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.auth.login(dto.email, dto.password, {
      ip: req.ip,
      deviceId: pickDeviceId(req, dto.deviceId),
      deviceName: pickDeviceName(req, dto.deviceName),
    });
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
    await this.auth.logout(user.id, user.jti, exp);
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
    const trimmed = (code ?? '').trim().toUpperCase();
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
  ) {
    return this.auth.updateExamType(user.id, body.examType, body.formLevel);
  }
}
