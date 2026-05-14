import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { StimuliService } from './stimuli.service';
import { Question } from './entities/question.entity';
import { QuestionStimulus } from './entities/question-stimulus.entity';
import { AuditLog } from '../admin/entities/audit-log.entity';

/**
 *  - create / update sanitise the markdown body through markdownToHtml + the
 *    sanitiser; bodyHtml must be set so the mobile renderer has something to
 *    show without re-running the (heavy) KaTeX pipeline on every read.
 *  - delete refuses (409) when any question still references the stimulus.
 *  - assertExists throws 404 — used by the question DTO validator.
 *  - audit_log inserts are best-effort: a thrown audit save MUST NOT roll back
 *    the original create/update/delete.
 */

describe('StimuliService', () => {
  let service: StimuliService;
  let stimuliRepo: {
    createQueryBuilder: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    delete: jest.Mock;
  };
  let questionsRepo: { count: jest.Mock };
  let auditRepo: { create: jest.Mock; save: jest.Mock };

  beforeEach(async () => {
    stimuliRepo = {
      createQueryBuilder: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn((o: unknown) => ({ id: 's-1', ...(o as object) })),
      save: jest.fn(async (s: unknown) => s),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    questionsRepo = { count: jest.fn() };
    auditRepo = {
      create: jest.fn((o: unknown) => o),
      save: jest.fn(async (a: unknown) => a),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        StimuliService,
        {
          provide: getRepositoryToken(QuestionStimulus),
          useValue: stimuliRepo,
        },
        { provide: getRepositoryToken(Question), useValue: questionsRepo },
        { provide: getRepositoryToken(AuditLog), useValue: auditRepo },
      ],
    }).compile();
    service = moduleRef.get(StimuliService);
  });

  // ------------------------------- create -------------------------------

  it('create populates bodyHtml from the markdown body and writes an audit row', async () => {
    const out = await service.create('admin-1', {
      title: '  Passage  ',
      body: 'Hello $x^2$',
    } as never);
    expect(out.title).toBe('Passage'); // trimmed
    expect(out.body).toBe('Hello $x^2$');
    expect(typeof out.bodyHtml).toBe('string');
    expect((out.bodyHtml as string).length).toBeGreaterThan(0);
    expect(auditRepo.save).toHaveBeenCalled();
  });

  // ------------------------------- update -------------------------------

  it('update only re-renders bodyHtml when body changes', async () => {
    stimuliRepo.findOne.mockResolvedValueOnce({
      id: 's-1',
      title: 'old',
      body: 'old body',
      bodyHtml: '<p>old</p>',
      imageUrl: null,
    });
    const out = await service.update('admin-1', 's-1', {
      title: 'new title',
    } as never);
    // body untouched → bodyHtml stays as the original.
    expect(out.bodyHtml).toBe('<p>old</p>');
    expect(out.title).toBe('new title');
  });

  // ------------------------------- delete -------------------------------

  it('delete throws 409 when questions still reference the stimulus', async () => {
    stimuliRepo.findOne.mockResolvedValueOnce({ id: 's-1' });
    questionsRepo.count.mockResolvedValueOnce(3);
    await expect(service.delete('admin-1', 's-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(stimuliRepo.delete).not.toHaveBeenCalled();
  });

  it('delete succeeds when no questions reference the stimulus', async () => {
    stimuliRepo.findOne.mockResolvedValueOnce({ id: 's-1' });
    questionsRepo.count.mockResolvedValueOnce(0);
    expect(await service.delete('admin-1', 's-1')).toEqual({ deleted: true });
    expect(stimuliRepo.delete).toHaveBeenCalledWith('s-1');
  });

  // ----------------------------- assertExists -----------------------------

  it('assertExists throws 404 for an unknown id', async () => {
    stimuliRepo.findOne.mockResolvedValueOnce(null);
    await expect(service.assertExists('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('assertExists resolves silently when the row exists', async () => {
    stimuliRepo.findOne.mockResolvedValueOnce({ id: 's-1' });
    await expect(service.assertExists('s-1')).resolves.toBeUndefined();
  });

  // -------------------- audit best-effort -----------------------

  it('a thrown audit save does NOT block the primary write', async () => {
    auditRepo.save.mockRejectedValueOnce(new Error('audit table missing'));
    await expect(
      service.create('admin-1', { body: 'body' } as never),
    ).resolves.toBeDefined();
  });
});
