import { Test } from '@nestjs/testing';
import { SubjectsController } from './subjects.controller';
import { SubjectsService } from './subjects.service';
import { ExamType } from '../../common/types/enums';

/**
 * SubjectsController list() normalises an arbitrary query string into the
 * ExamType enum. An unknown / missing examType must collapse to `undefined`
 * (combined cache), NOT pass through as a raw string — otherwise the service
 * cache key contains user input and breaks isolation.
 */

describe('SubjectsController', () => {
  let controller: SubjectsController;
  let subjects: jest.Mocked<SubjectsService>;

  beforeEach(async () => {
    subjects = {
      listActive: jest.fn(),
      getById: jest.fn(),
      getTopics: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      createTopic: jest.fn(),
    } as unknown as jest.Mocked<SubjectsService>;
    const moduleRef = await Test.createTestingModule({
      controllers: [SubjectsController],
      providers: [{ provide: SubjectsService, useValue: subjects }],
    }).compile();
    controller = moduleRef.get(SubjectsController);
  });

  it('list normalises ?examType=bece to ExamType.BECE', () => {
    controller.list('bece');
    expect(subjects.listActive).toHaveBeenCalledWith(ExamType.BECE);
  });

  it('list normalises ?examType=wassce to ExamType.WASSCE', () => {
    controller.list('wassce');
    expect(subjects.listActive).toHaveBeenCalledWith(ExamType.WASSCE);
  });

  it('list collapses an unknown examType to undefined (combined cache)', () => {
    controller.list('alien');
    expect(subjects.listActive).toHaveBeenCalledWith(undefined);
  });

  it('list collapses a missing examType to undefined', () => {
    controller.list();
    expect(subjects.listActive).toHaveBeenCalledWith(undefined);
  });

  it('createTopic forwards (subjectId, dto)', () => {
    controller.createTopic('s-1', { title: 't' } as never);
    expect(subjects.createTopic).toHaveBeenCalledWith('s-1', { title: 't' });
  });
});
