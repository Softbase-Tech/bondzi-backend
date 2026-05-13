import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  MaxLength,
} from 'class-validator';

export class CreateStimulusDto {
  @ApiPropertyOptional({
    description: 'Short label shown in the admin picker.',
    maxLength: 120,
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;

  @ApiProperty({
    description:
      'Markdown body. May contain `$...$` LaTeX math; tables are GFM pipe syntax.',
  })
  @IsString()
  @IsNotEmpty()
  @Length(1, 8000)
  body!: string;

  @ApiPropertyOptional({ description: 'Optional standalone image URL.' })
  @IsOptional()
  @IsUrl({ require_tld: false })
  imageUrl?: string;
}

export class UpdateStimulusDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 8000)
  body?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({ require_tld: false })
  imageUrl?: string;
}
