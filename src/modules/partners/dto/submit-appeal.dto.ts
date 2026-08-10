import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Partner-facing appeal submission. `attachments` is a URL array
 * so the client can upload evidence (screenshots, MoMo statements)
 * to whatever storage they've already got wired — we just record
 * references. Empty is fine.
 */
export class SubmitAppealDto {
  @ApiProperty({ description: 'Free-form explanation, 50–2000 chars.' })
  @IsString()
  @MinLength(50)
  @MaxLength(2000)
  body!: string;

  @ApiPropertyOptional({
    description: 'Optional evidence URLs (screenshots, statements).',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsUrl({}, { each: true })
  attachments?: string[];
}
