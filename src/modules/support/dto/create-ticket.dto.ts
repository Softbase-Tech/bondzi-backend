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
  IsUrl,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

/**
 * Sanity caps on attachment metadata. The URL comes from an upload
 * flow the client already completed; the service does NOT reach out
 * to validate — it trusts the URL string. `sizeBytes` and `mime`
 * come from the client for display purposes.
 */
export class AttachmentDto {
  @ApiProperty()
  @IsUrl({ require_tld: true })
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
