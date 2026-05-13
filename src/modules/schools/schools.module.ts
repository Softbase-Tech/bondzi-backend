import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { School } from './entities/school.entity';
import { SchoolMember } from './entities/school-member.entity';

/**
 * Phase 2 module — tables exist from the initial migration so B2B licensing
 * can ship as a code-only change when the first school contract closes.
 */
@Module({
  imports: [TypeOrmModule.forFeature([School, SchoolMember])],
  exports: [TypeOrmModule],
})
export class SchoolsModule {}
