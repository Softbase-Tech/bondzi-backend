import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';
import { AccountType, ExamType } from '../../../common/types/enums';

/**
 * Grant: admin manually attaches a Plus or Pro entitlement to a user on
 * a given level. Used for influencers, beta testers, refund-compensation
 * goodwill, support resolution, etc.
 *
 * Plus (account=plus) is lifetime — `expiresAt` MUST be omitted.
 * Pro  (account=pro)  is time-bounded — `expiresAt` MUST be provided.
 *
 * `reason` is required so the audit trail is meaningful — "why did the
 * user end up with Pro for free?" is a question we should always be
 * able to answer from `audit_log`.
 */
export class GrantEntitlementDto {
  @ApiProperty({ format: 'uuid', description: 'Target user.' })
  @IsUUID()
  userId!: string;

  @ApiProperty({
    enum: AccountType,
    description: 'Account type to grant. `free` is never a manual grant.',
  })
  @IsEnum(AccountType)
  account!: AccountType.PLUS | AccountType.PRO;

  @ApiProperty({
    enum: ExamType,
    description: 'Level the entitlement applies to.',
  })
  @IsEnum(ExamType)
  level!: ExamType;

  @ApiPropertyOptional({
    description:
      'Required for Pro grants (ISO timestamp); MUST be omitted for Plus (lifetime). The service rejects mismatched combinations.',
  })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @ApiProperty({
    minLength: 4,
    description:
      'Why this grant is being made (audit trail). Keep it short — "Beta tester", "Refund goodwill #12345", "Sponsor request — Asantewaa High".',
  })
  @IsString()
  @Length(4, 500)
  reason!: string;
}

/**
 * Revoke: removes an active Plus or Pro entitlement. Two modes:
 *
 *   - `refund=false` (default): flips status to CANCELLED. The user
 *     loses access immediately, no refund is implied.
 *   - `refund=true`: flips status to REFUNDED. Use ONLY when a refund
 *     was already issued out-of-band (manual Paystack refund, bank
 *     reversal, manager-discretion comp). This does NOT call Paystack —
 *     the refund must have been processed before invoking this.
 */
export class RevokeEntitlementDto {
  @ApiProperty({ format: 'uuid', description: 'Target user.' })
  @IsUUID()
  userId!: string;

  @ApiProperty({
    enum: ExamType,
    description: 'Level whose entitlement is being revoked.',
  })
  @IsEnum(ExamType)
  level!: ExamType;

  @ApiPropertyOptional({
    default: false,
    description:
      'When true, marks the row REFUNDED instead of CANCELLED. Use only when a refund was actually issued out-of-band.',
  })
  @IsOptional()
  @IsBoolean()
  refund?: boolean;

  @ApiProperty({
    minLength: 4,
    description:
      'Audit reason. "Abuse", "Charge dispute won", "User requested refund — comped".',
  })
  @IsString()
  @Length(4, 500)
  reason!: string;
}
