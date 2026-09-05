import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AdminService } from './admin.service';
import { User } from '../users/entities/user.entity';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { Exam } from '../exams/entities/exam.entity';
import { ExamAnswer } from '../exams/entities/exam-answer.entity';
import { AiUsageLog } from '../ai/entities/ai-usage-log.entity';
import { QuestionFlag } from '../questions/entities/question-flag.entity';
import { Question } from '../questions/entities/question.entity';
import { AuditLog } from './entities/audit-log.entity';
import { XpTransaction } from '../xp-economy/entities/xp-transaction.entity';
import { XpRedemption } from '../xp-economy/entities/xp-redemption.entity';
import { ReferralEvent } from '../referrals/entities/referral-event.entity';
import { PmTestQuestion } from '../pm-test/entities/pm-test-question.entity';
import { Winner } from '../leaderboard/entities/winner.entity';
import { AuthLoginEvent } from '../auth/entities/auth-login-event.entity';
import { UserRole } from '../../common/types/enums';

/**
 * `authAnalytics()` is a growth-reporting surface, and the property that
 * makes its numbers meaningful is invisible in the output: it counts
 * **students only**.
 *
 * That is easy to break by accident — a future edit adding a fifth
 * aggregate, or refactoring the builders, drops the filter and nothing
 * fails. The counts just quietly start including operators, and a handful
 * of staff signing into the console all day inflates the login bars
 * against a much larger student denominator. Nobody notices until the
 * numbers are used for a decision.
 *
 * So these tests assert on the query *shape* rather than on returned rows:
 * every builder must carry the `role = 'student'` predicate, and the two
 * that read `auth_login_events` (which has no role column of its own) must
 * reach it through a join to `users`.
 */

/** A chainable query-builder double that records every call made on it. */
interface RecordingQb {
  calls: { method: string; args: unknown[] }[];
  [key: string]: unknown;
}

function makeQb(rows: unknown[] = []): RecordingQb {
  const calls: { method: string; args: unknown[] }[] = [];
  const qb = { calls } as RecordingQb;
  for (const m of [
    'select',
    'addSelect',
    'where',
    'andWhere',
    'innerJoin',
    'leftJoin',
    'groupBy',
    'addGroupBy',
    'orderBy',
    'limit',
  ]) {
    qb[m] = jest.fn((...args: unknown[]) => {
      calls.push({ method: m, args });
      return qb;
    });
  }
  qb.getRawMany = jest.fn().mockResolvedValue(rows);
  qb.getRawOne = jest.fn().mockResolvedValue(null);
  return qb;
}

/** Every predicate string passed to where/andWhere, joined for matching. */
function predicates(qb: RecordingQb): string[] {
  return qb.calls
    .filter((c) => c.method === 'where' || c.method === 'andWhere')
    .map((c) => String(c.args[0]));
}

/** The parameter objects passed alongside those predicates. */
function params(qb: RecordingQb): Record<string, unknown> {
  return qb.calls
    .filter((c) => c.method === 'where' || c.method === 'andWhere')
    .reduce<
      Record<string, unknown>
    >((acc, c) => Object.assign(acc, (c.args[1] ?? {}) as object), {});
}

describe('AdminService.authAnalytics — student-only scoping', () => {
  let service: AdminService;
  let userQbs: RecordingQb[];
  let loginQbs: RecordingQb[];

  const empty = (): Record<string, unknown> => ({});

  beforeEach(async () => {
    userQbs = [];
    loginQbs = [];

    const usersRepo = {
      createQueryBuilder: jest.fn(() => {
        const qb = makeQb();
        userQbs.push(qb);
        return qb;
      }),
    };
    const loginEventsRepo = {
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(() => {
        const qb = makeQb();
        loginQbs.push(qb);
        return qb;
      }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AdminService,
        { provide: getRepositoryToken(User), useValue: usersRepo },
        { provide: getRepositoryToken(Subscription), useValue: empty() },
        { provide: getRepositoryToken(Exam), useValue: empty() },
        { provide: getRepositoryToken(ExamAnswer), useValue: empty() },
        { provide: getRepositoryToken(AiUsageLog), useValue: empty() },
        { provide: getRepositoryToken(QuestionFlag), useValue: empty() },
        { provide: getRepositoryToken(Question), useValue: empty() },
        { provide: getRepositoryToken(AuditLog), useValue: empty() },
        { provide: getRepositoryToken(XpTransaction), useValue: empty() },
        { provide: getRepositoryToken(XpRedemption), useValue: empty() },
        { provide: getRepositoryToken(ReferralEvent), useValue: empty() },
        { provide: getRepositoryToken(PmTestQuestion), useValue: empty() },
        { provide: getRepositoryToken(Winner), useValue: empty() },
        {
          provide: getRepositoryToken(AuthLoginEvent),
          useValue: loginEventsRepo,
        },
      ],
    }).compile();
    service = moduleRef.get(AdminService);
  });

  it('runs exactly four aggregates: two over users, two over login events', async () => {
    await service.authAnalytics();
    expect(userQbs).toHaveLength(2);
    expect(loginQbs).toHaveLength(2);
  });

  it('scopes BOTH signup aggregates to role=student', async () => {
    await service.authAnalytics();
    for (const qb of userQbs) {
      expect(predicates(qb).join(' | ')).toContain('u.role = :role');
      expect(params(qb).role).toBe(UserRole.STUDENT);
    }
  });

  it('keeps the 30-day window on the last-30d signup aggregate', async () => {
    await service.authAnalytics();
    // First builder is all-time (role filter only); second adds the window.
    expect(predicates(userQbs[0])).toEqual(['u.role = :role']);
    expect(predicates(userQbs[1])).toEqual([
      'u.created_at >= :start',
      'u.role = :role',
    ]);
    expect(params(userQbs[1]).start).toBeInstanceOf(Date);
  });

  it('reaches role through a join to users on BOTH login aggregates', async () => {
    await service.authAnalytics();
    for (const qb of loginQbs) {
      const joins = qb.calls.filter((c) => c.method === 'innerJoin');
      expect(joins).toHaveLength(1);
      // Joined to the User entity, aliased `u`, on the FK.
      expect(joins[0].args[0]).toBe(User);
      expect(joins[0].args[1]).toBe('u');
      expect(String(joins[0].args[2])).toContain('u.id = e.user_id');

      expect(predicates(qb).join(' | ')).toContain('u.role = :role');
      expect(params(qb).role).toBe(UserRole.STUDENT);
    }
  });

  it('an operator role is never what the aggregates ask for', async () => {
    await service.authAnalytics();
    const allParams = [...userQbs, ...loginQbs].map((qb) => params(qb).role);
    for (const role of allParams) {
      expect(role).not.toBe(UserRole.ADMIN);
      expect(role).not.toBe(UserRole.SUPERADMIN);
      expect(role).not.toBe(UserRole.TEACHER);
    }
  });

  it('still surfaces the null-platform bucket and parses counts as ints', async () => {
    // Null platform is a real bucket (legacy clients that predate the
    // X-Platform header) — it must survive the role filter, not be
    // swallowed by it.
    userQbs = [];
    loginQbs = [];
    const usersRepo = {
      createQueryBuilder: jest.fn(() => {
        const qb = makeQb([
          { platform: 'web', count: '12' },
          { platform: null, count: '3' },
        ]);
        userQbs.push(qb);
        return qb;
      }),
    };
    const loginEventsRepo = {
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(() => {
        const qb = makeQb([
          { platform: 'android', event_type: 'login', count: '7' },
        ]);
        loginQbs.push(qb);
        return qb;
      }),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        AdminService,
        { provide: getRepositoryToken(User), useValue: usersRepo },
        { provide: getRepositoryToken(Subscription), useValue: empty() },
        { provide: getRepositoryToken(Exam), useValue: empty() },
        { provide: getRepositoryToken(ExamAnswer), useValue: empty() },
        { provide: getRepositoryToken(AiUsageLog), useValue: empty() },
        { provide: getRepositoryToken(QuestionFlag), useValue: empty() },
        { provide: getRepositoryToken(Question), useValue: empty() },
        { provide: getRepositoryToken(AuditLog), useValue: empty() },
        { provide: getRepositoryToken(XpTransaction), useValue: empty() },
        { provide: getRepositoryToken(XpRedemption), useValue: empty() },
        { provide: getRepositoryToken(ReferralEvent), useValue: empty() },
        { provide: getRepositoryToken(PmTestQuestion), useValue: empty() },
        { provide: getRepositoryToken(Winner), useValue: empty() },
        {
          provide: getRepositoryToken(AuthLoginEvent),
          useValue: loginEventsRepo,
        },
      ],
    }).compile();
    const svc = moduleRef.get(AdminService);

    const out = await svc.authAnalytics();
    expect(out.signups.byPlatformAllTime).toEqual([
      { platform: 'web', count: 12 },
      { platform: null, count: 3 },
    ]);
    expect(out.logins.byPlatformLast30d).toEqual([
      { platform: 'android', eventType: 'login', count: 7 },
    ]);
  });
});
