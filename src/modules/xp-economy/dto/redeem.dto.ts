import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

export class RedeemDto {
  @ApiProperty({
    example: 'month_1',
    description: 'tier_key from xp_redemption_config',
  })
  @IsString()
  @Matches(/^[a-z0-9_]+$/)
  tierKey!: string;
}
