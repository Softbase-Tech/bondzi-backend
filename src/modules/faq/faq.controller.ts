import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { FaqService } from './faq.service';

/**
 * Public FAQ endpoints, JWT-gated so retired entries never leak to
 * signed-out crawlers. Two routes:
 *
 *   GET  /faq         → published list, ordered.
 *   GET  /faq/:slug   → single entry by slug (active OR retired — a
 *                       live share link degrades to a retired page
 *                       rather than 404ing).
 */
@ApiTags('faq')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('faq')
export class FaqController {
  constructor(private readonly svc: FaqService) {}

  @Get()
  @ApiOperation({
    summary: 'Every published FAQ entry, in sort order.',
  })
  list() {
    return this.svc.listPublished();
  }

  @Get(':slug')
  @ApiOperation({
    summary:
      'Single FAQ entry by slug. Returns retired entries too so a ' +
      'live deep link from an old share degrades cleanly.',
  })
  bySlug(@Param('slug') slug: string) {
    return this.svc.getBySlug(slug);
  }
}
