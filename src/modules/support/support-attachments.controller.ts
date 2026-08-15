import {
  BadRequestException,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { InjectRepository } from '@nestjs/typeorm';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Repository } from 'typeorm';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { SupportTicketAttachmentEntity } from './entities/support-ticket-attachment.entity';

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB — matches the DB CHECK constraint
const ALLOWED_MIME = new Set<string>([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
]);

/**
 * POST /support/attachments  — multipart/form-data, field `file`. The
 * mobile/web pickers hit this to upload before submitting the ticket
 * form. Response `{id, url, mime, sizeBytes, originalFilename}` is
 * placed directly into the ticket-create / reply payload's
 * `attachments[]` array.
 *
 * GET  /support/attachments/:id  — streams the bytes with the stored
 * mime type. Auth model is CAPABILITY: whoever knows the UUID can
 * read the file. UUIDs are 128-bit, unguessable, and never leak
 * outside the ticket thread the file is attached to. Cheap for v1;
 * we tighten to signed URLs when we care about non-participants.
 */
@ApiTags('support')
@Controller('support/attachments')
export class SupportAttachmentsController {
  constructor(
    @InjectRepository(SupportTicketAttachmentEntity)
    private readonly repo: Repository<SupportTicketAttachmentEntity>,
  ) {}

  @Post()
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_BYTES, files: 1 },
    }),
  )
  async upload(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) {
      throw new BadRequestException('No file provided (field "file").');
    }
    if (!ALLOWED_MIME.has(file.mimetype)) {
      throw new BadRequestException(
        `Unsupported file type "${file.mimetype}". Allowed: PNG/JPG/WEBP/HEIC/PDF.`,
      );
    }
    if (file.size <= 0 || file.size > MAX_BYTES) {
      throw new BadRequestException(
        `File too large (max ${(MAX_BYTES / (1024 * 1024)).toFixed(0)} MB).`,
      );
    }
    const row = this.repo.create({
      userId: user.id,
      ticketId: null,
      messageId: null,
      mime: file.mimetype,
      sizeBytes: file.size,
      filename: sanitiseFilename(file.originalname),
      bytes: file.buffer,
    });
    const saved = await this.repo.save(row);
    return {
      id: saved.id,
      // Full API path — the ${apiPrefix} is applied by setGlobalPrefix,
      // so callers see this rooted at /api/v1/... which is what the
      // mobile + web http clients expect.
      url: `/support/attachments/${saved.id}`,
      mime: saved.mime,
      sizeBytes: saved.sizeBytes,
      originalFilename: saved.filename,
    };
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, max-age=3600')
  async download(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Attachment not found');
    res.setHeader('Content-Type', row.mime);
    res.setHeader('Content-Length', String(row.sizeBytes));
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${row.filename.replace(/[^\w.\- ]+/g, '_')}"`,
    );
    return new StreamableFile(row.bytes);
  }
}

/**
 * Belt-and-braces filename sanitiser. Multer already gives us the
 * unescaped `originalname` off the multipart header; anything can
 * live there. We keep the extension for the Content-Disposition
 * hint but strip path characters + control bytes.
 */
function sanitiseFilename(raw: string | undefined): string {
  const fallback = 'attachment';
  if (!raw) return fallback;
  // Windows/mac filenames sometimes come with backslashes; kill anything
  // that looks like a path separator or shell character.
  const cleaned = raw
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  return cleaned.length > 0 ? cleaned : fallback;
}
