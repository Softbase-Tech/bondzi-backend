import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SyllabusStrand } from './entities/syllabus-strand.entity';
import { SyllabusSubStrand } from './entities/syllabus-sub-strand.entity';
import { SyllabusLearningOutcome } from './entities/syllabus-learning-outcome.entity';
import { SyllabusContentStandard } from './entities/syllabus-content-standard.entity';
import { SyllabusIndicator } from './entities/syllabus-indicator.entity';
import { SyllabusAssessmentItem } from './entities/syllabus-assessment-item.entity';
import { SyllabusPedagogyRef } from './entities/syllabus-pedagogy-ref.entity';
import { SyllabusIngestionService } from './syllabus-ingestion.service';
import { SyllabusEmbeddingService } from './syllabus-embedding.service';
import { SyllabusRetrievalService } from './syllabus-retrieval.service';
import { SyllabusReviewService } from './syllabus-review.service';
import { SyllabusAdminController } from './syllabus-admin.controller';
import { AiModule } from '../ai/ai.module';

/**
 * PART A — NaCCA curriculum hierarchy (knowledge spine).
 *
 * A1 registered the structured entities; A3 the ingestion service +
 * admin ingest. A5/A6 add embeddings (approved indicators → pgvector)
 * and hybrid retrieval (exported so generation/AI-review can ground on
 * the exact indicators).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      SyllabusStrand,
      SyllabusSubStrand,
      SyllabusLearningOutcome,
      SyllabusContentStandard,
      SyllabusIndicator,
      SyllabusAssessmentItem,
      SyllabusPedagogyRef,
    ]),
    AiModule,
  ],
  controllers: [SyllabusAdminController],
  providers: [
    SyllabusIngestionService,
    SyllabusEmbeddingService,
    SyllabusRetrievalService,
    SyllabusReviewService,
  ],
  exports: [TypeOrmModule, SyllabusIngestionService, SyllabusRetrievalService],
})
export class SyllabusModule {}
