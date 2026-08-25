import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * First-touch campaign attribution, supplied by the client at signup.
 *
 * Base class for every DTO that can create a user (`RegisterDto`,
 * `GoogleSignInDto`). It exists as a base class rather than six repeated
 * fields for one specific reason: the global pipe runs with
 * `forbidNonWhitelisted: true`, so a field that isn't declared on the
 * DTO doesn't get ignored — it makes the whole request 400. Every
 * signup entry point therefore has to declare the same set, and the
 * only safe way to guarantee that is inheritance.
 *
 * All fields are optional and untrusted. They come from a query string
 * the user can edit, so they are length-capped here and never used for
 * anything but reporting — no branching, no entitlement, no money.
 *
 * Naming follows UTM rather than the column names (`signup_*`) because
 * this is the vocabulary the client actually reads off the URL; the
 * mapping to columns happens once, server-side, in `AuthService`.
 */
export class SignupAttributionDto {
  @ApiPropertyOptional({
    description: 'utm_source — the platform the link was posted on.',
    example: 'facebook',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  utmSource?: string;

  @ApiPropertyOptional({
    description: 'utm_medium — the kind of placement.',
    example: 'group',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  utmMedium?: string;

  @ApiPropertyOptional({
    description: 'utm_campaign — the campaign batch.',
    example: 'aug26',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  utmCampaign?: string;

  @ApiPropertyOptional({
    description: 'utm_content — the individual creative/post code.',
    example: 'p02_novdec',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  utmContent?: string;

  @ApiPropertyOptional({
    description: 'utm_term — free slot, used for the group/audience code.',
    example: 'wassce_2026_gh',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  utmTerm?: string;

  @ApiPropertyOptional({
    description:
      'Raw referrer. `document.referrer` on web, or the raw Play Install ' +
      'Referrer string on Android. Longer cap because both can be full URLs.',
    example: 'https://m.facebook.com/',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  signupReferrer?: string;
}
