import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SrsCard } from './entities/srs-card.entity';
import { Question } from '../questions/entities/question.entity';
import { SrsController } from './srs.controller';
import { SrsService } from './srs.service';

@Module({
  imports: [TypeOrmModule.forFeature([SrsCard, Question])],
  controllers: [SrsController],
  providers: [SrsService],
  exports: [SrsService, TypeOrmModule],
})
export class SrsModule {}
