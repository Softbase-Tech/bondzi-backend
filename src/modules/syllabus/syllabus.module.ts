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
import { SyllabusAdminController } from './syllabus-admin.controller';

/**
 * PART A — NaCCA curriculum hierarchy (knowledge spine).
 *
 * A1 registered the structured entities. A3.2 adds the ingestion
 * service that loads validated extractions into the hierarchy as
 * `draft`. Admin review, the extraction job, embeddings, and retrieval
 * slot into this module in later A-phases.
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
  ],
  controllers: [SyllabusAdminController],
  providers: [SyllabusIngestionService],
  exports: [TypeOrmModule, SyllabusIngestionService],
})
export class SyllabusModule {}
