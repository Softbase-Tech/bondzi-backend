import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SyllabusStrand } from './entities/syllabus-strand.entity';
import { SyllabusSubStrand } from './entities/syllabus-sub-strand.entity';
import { SyllabusLearningOutcome } from './entities/syllabus-learning-outcome.entity';
import { SyllabusContentStandard } from './entities/syllabus-content-standard.entity';
import { SyllabusIndicator } from './entities/syllabus-indicator.entity';
import { SyllabusAssessmentItem } from './entities/syllabus-assessment-item.entity';
import { SyllabusPedagogyRef } from './entities/syllabus-pedagogy-ref.entity';

/**
 * PART A / A1 — NaCCA curriculum hierarchy (knowledge spine).
 *
 * This first slice registers only the structured entities so their
 * repositories are available and `autoLoadEntities` picks up the
 * tables. Ingestion, admin review, embeddings, and retrieval services
 * arrive in later A-phases and slot into this module.
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
  exports: [TypeOrmModule],
})
export class SyllabusModule {}
