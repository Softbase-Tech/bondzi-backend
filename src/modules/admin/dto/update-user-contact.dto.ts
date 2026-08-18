import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsPhoneNumber,
  ValidateIf,
} from 'class-validator';

/**
 * Admin-only patch of a user's contact details. Both fields are
 * independently optional so an admin can update the email OR the
 * phone in the same call, and both are nullable so an obviously-
 * wrong value can be *cleared* (send `null`) rather than left in
 * a broken state.
 *
 * Uniqueness is enforced at the service layer — the DB has UNIQUE
 * constraints on both columns (see migration 1750, users.email +
 * users.phone) but the service preemptively rejects duplicates
 * with a 400 so the admin sees "already in use" instead of an
 * opaque 500 from a Postgres 23505.
 */
export class UpdateUserContactDto {
  @ApiPropertyOptional({
    nullable: true,
    description:
      'New email address. Send null to clear. When updated, the user re-enters the "email unverified" state and must confirm the new address.',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsEmail()
  email?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'New phone number (Ghana format). Send null to clear. E.164 recommended, class-validator normalises through libphonenumber.',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsPhoneNumber('GH')
  phone?: string | null;
}
