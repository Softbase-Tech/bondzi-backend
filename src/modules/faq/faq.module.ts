import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FaqEntry } from './entities/faq-entry.entity';
import { FaqService } from './faq.service';
import { FaqController } from './faq.controller';
import { FaqAdminController } from './faq-admin.controller';

/**
 * FAQ knowledge base. Powers the "Common questions" list on the
 * mobile Help hub and the web (app.bondzi.online). Admin CRUD lives
 * under /admin/faq; public reads under /faq.
 */
@Module({
  imports: [TypeOrmModule.forFeature([FaqEntry])],
  controllers: [FaqController, FaqAdminController],
  providers: [FaqService],
  exports: [FaqService],
})
export class FaqModule {}
