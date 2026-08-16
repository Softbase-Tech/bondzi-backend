import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SLUG_MESSAGE =
  'slug must be kebab-case (lowercase letters, digits, hyphens)';

/**
 * Body for `PATCH /admin/faq/:id`. Every field is optional at the DTO
 * layer; the service enforces that a PATCH doesn't zero out required
 * columns. Slug edits are allowed but strongly discouraged — the
 * mobile deep-links to this value.
 */
export class UpsertFaqDto {
  @ApiPropertyOptional({
    description:
      'Stable slug used by the mobile deep link /help/faq/:slug. ' +
      'Editing an existing slug breaks any share link in the wild.',
    example: 'how-do-i-earn-and-spend-xp',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Matches(SLUG_PATTERN, { message: SLUG_MESSAGE })
  slug?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  question?: string;

  @ApiPropertyOptional({
    description: 'Markdown body of the answer. Rendered on the detail screen.',
  })
  @IsOptional()
  @IsString()
  @MinLength(10)
  @MaxLength(8000)
  answerMarkdown?: string;

  @ApiPropertyOptional({
    description:
      'Lower renders higher in the list. Non-unique — ties fall back to createdAt.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/**
 * `POST /admin/faq` — all identity fields required. Written
 * standalone rather than extending UpsertFaqDto so TS's
 * `useDefineForClassFields` doesn't complain about redeclarations.
 */
export class CreateFaqDto {
  @ApiProperty({
    description:
      'Stable slug used by the mobile deep link /help/faq/:slug.',
    example: 'why-is-a-subject-locked',
  })
  @IsString()
  @MaxLength(120)
  @Matches(SLUG_PATTERN, { message: SLUG_MESSAGE })
  slug!: string;

  @ApiProperty()
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  question!: string;

  @ApiProperty({ description: 'Markdown body of the answer.' })
  @IsString()
  @MinLength(10)
  @MaxLength(8000)
  answerMarkdown!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
