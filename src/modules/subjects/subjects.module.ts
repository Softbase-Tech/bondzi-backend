import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Subject } from './entities/subject.entity';
import { Topic } from './entities/topic.entity';
import { SyllabusTopic } from './entities/syllabus-topic.entity';
import { Question } from '../questions/entities/question.entity';
import { SubjectsController } from './subjects.controller';
import { SubjectsService } from './subjects.service';
import { SyllabusTopicsController } from './syllabus-topics.controller';
import { AdminSyllabusTopicsController } from './admin-syllabus-topics.controller';
import { SyllabusTopicsService } from './syllabus-topics.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Subject, Topic, SyllabusTopic, Question]),
  ],
  controllers: [
    SubjectsController,
    SyllabusTopicsController,
    AdminSyllabusTopicsController,
  ],
  providers: [SubjectsService, SyllabusTopicsService],
  exports: [SubjectsService, SyllabusTopicsService, TypeOrmModule],
})
export class SubjectsModule {}
