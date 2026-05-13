import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserSubjectProgress } from './entities/user-subject-progress.entity';

@Module({
  imports: [TypeOrmModule.forFeature([UserSubjectProgress])],
  exports: [TypeOrmModule],
})
export class ProgressModule {}
