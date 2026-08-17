import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';

/**
 * Body for POST /admin/syllabus/ingest — one subject's extracted sub-strands
 * (the array the pdfplumber tool writes to out/<subject>.json). Each element
 * is a raw ExtractedSubStrand object; it is schema-validated per item inside
 * the service, so the DTO only enforces the envelope.
 */
export class IngestSyllabusDto {
  @IsUUID('4')
  subjectId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  curriculumVersion?: string;

  @IsArray()
  @ArrayMaxSize(1000)
  subStrands!: unknown[];
}
