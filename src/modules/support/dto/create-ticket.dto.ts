import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

/**
 * Sanity caps on attachment metadata. The URL comes from the
 * attachment-upload endpoint (/support/attachments) — either the raw
 * path returned by the endpoint (starts with `/support/attachments/`)
 * or a fully-qualified https:// URL to the same. We accept both so
 * the client doesn't need to know the API origin.
 *
 * The service does NOT re-validate the file itself here; it trusts
 * the URL the caller received from the upload endpoint.
 */
export class AttachmentDto {
  @ApiProperty({
    description:
      'Either a relative /support/attachments/{uuid} path or a full https URL to it.',
  })
  @IsString()
  @MaxLength(500)
  @Matches(/^(https?:\/\/[^\s]+|\/support\/attachments\/[a-f0-9-]{36})$/i, {
    message: 'url must be a /support/attachments/{uuid} path or an https URL',
  })
  url!: string;

  @ApiProperty({ example: 'image/png' })
  @IsString()
  @MaxLength(80)
  mime!: string;

  @ApiProperty({ example: 245678 })
  @IsInt()
  sizeBytes!: number;

  @ApiPropertyOptional({ example: 'screenshot.png' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  originalFilename?: string;
}

export class CreateTicketDto {
  @ApiProperty({ enum: ['feedback', 'wrong_question', 'payment', 'general'] })
  @IsIn(['feedback', 'wrong_question', 'payment', 'general'])
  category!: 'feedback' | 'wrong_question' | 'payment' | 'general';

  @ApiProperty({ minLength: 3, maxLength: 200 })
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  subject!: string;

  @ApiProperty({ minLength: 10, maxLength: 4000 })
  @IsString()
  @MinLength(10)
  @MaxLength(4000)
  body!: string;

  @ApiPropertyOptional({
    description:
      'When this ticket continues a prior closed one — the ticket number of the parent (BQ-YYMM-NNNN).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  relatedTicketNumber?: string;

  @ApiPropertyOptional({
    description:
      'Free-form structured context: for wrong_question, `{questionId, examId?, subjectId?, snapshotUrl?}`; for payment, `{orderId?, plan?}`.',
  })
  @IsOptional()
  @IsObject()
  context?: Record<string, unknown>;

  @ApiPropertyOptional({ maxLength: 3, type: [AttachmentDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => AttachmentDto)
  attachments?: AttachmentDto[];
}

export class CreateMessageDto {
  @ApiProperty({ minLength: 1, maxLength: 4000 })
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body!: string;

  @ApiPropertyOptional({ maxLength: 3, type: [AttachmentDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => AttachmentDto)
  attachments?: AttachmentDto[];
}

export class CloseTicketDto {
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
