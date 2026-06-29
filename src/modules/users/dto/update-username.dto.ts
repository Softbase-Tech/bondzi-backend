import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import {
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  USERNAME_REGEX,
} from '../username.rules';

/**
 * Body for PATCH /users/me/username. Format-only validation lives in
 * decorators; reserved-word check, uniqueness, and the 90-day cooldown
 * are all enforced by UsersService.updateUsername so the client gets
 * one BadRequestException with a clear `message` regardless of which
 * gate trips.
 */
export class UpdateUsernameDto {
  @ApiProperty({
    description:
      'Public handle. Letters and digits only, 6-24 chars. Case-insensitive uniqueness.',
    minLength: USERNAME_MIN_LENGTH,
    maxLength: USERNAME_MAX_LENGTH,
    example: 'ekowmensah',
  })
  @IsString()
  @MinLength(USERNAME_MIN_LENGTH)
  @MaxLength(USERNAME_MAX_LENGTH)
  @Matches(USERNAME_REGEX, {
    message: 'username must be letters and numbers only (no spaces or symbols)',
  })
  username!: string;
}
