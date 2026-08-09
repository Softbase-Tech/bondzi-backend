/**
 * Diagnostic: why does a "Start past paper" query return fewer questions
 * than expected?
 *
 * Replays the exact filter used by `ExamsService.create` for past-paper mode,
 * then breaks down the rows that *almost* match — but were dropped — by which
 * column took them out (status / wassec_paper / year / subject / exam_type).
 * Surfaces the gap between what's in the DB and what the exam screen sees.
 *
 * Run:
 *   npx ts-node -r tsconfig-paths/register src/scripts/diagnose-pastpaper-filter.ts \
 *     --subject=4115893f-9062-4485-a627-6d21f8be0188 \
 *     --year=2006 --paper=1 --exam=bece
 */
import 'dotenv/config';
import 'reflect-metadata';
import dataSource from '../../ormconfig';
import { Question } from '../modules/questions/entities/question.entity';
import { ExamType, QuestionStatus } from '../common/types/enums';

interface Args {
  subjectId: string;
  year: number;
  paper: number;
  examType: string;
}

function parseArgs(): Args {
  const out: Partial<Args> = {};
  for (const arg of process.argv.slice(2)) {
    const [k, v] = arg.replace(/^--/, '').split('=');
    if (k === 'subject') out.subjectId = v;
    if (k === 'year') out.year = parseInt(v, 10);
    if (k === 'paper') out.paper = parseInt(v, 10);
    if (k === 'exam') out.examType = v;
  }
  if (!out.subjectId || !out.year || !out.paper || !out.examType) {
    console.error(
      'Usage: --subject=<uuid> --year=<int> --paper=<1|2> --exam=<bece|wassce>',
    );
    process.exit(1);
  }
  return out as Args;
}

async function main() {
  const args = parseArgs();
  await dataSource.initialize();
  const repo = dataSource.getRepository(Question);

  console.log('\n=== Past-paper filter diagnosis ===');
  console.log('Filter:', args, '\n');

  // 1) The exact query the exam creator runs.
  const strict = await repo
    .createQueryBuilder('q')
    .where("q.status = 'active'")
    .andWhere('q.examType = :et', { et: args.examType })
    .andWhere('q.subjectId = :sid', { sid: args.subjectId })
    .andWhere('q.year = :year', { year: args.year })
    .andWhere('q.wassecPaper = :paper', { paper: args.paper })
    .getMany();

  console.log(`Strict match (what the exam returns): ${strict.length}`);

  // 2) Loose-by-subject — every question on this subject, regardless of
  //    paper / year / status / exam_type. Anything in the gap is a candidate
  //    that the strict filter excluded.
  const loose = await repo.find({
    where: { subjectId: args.subjectId },
    select: [
      'id',
      'examType',
      'year',
      'wassecPaper',
      'section',
      'status',
      'topicId',
      'createdAt',
    ],
    order: { createdAt: 'ASC' },
  });
  console.log(`Loose match (subject only):           ${loose.length}\n`);

  // 3) Bucket the loose set by the strict filter conditions to surface where
  //    the gap is. Rows that would pass each predicate are flagged.
  const buckets = new Map<string, number>();
  for (const q of loose) {
    // args.examType is a raw CLI string (bece|wassce). Both enums use the
    // string values directly, so cast through ExamType for a typed compare.
    const wantedExamType = args.examType as ExamType;
    const flags = [
      q.examType === wantedExamType
        ? `exam=${q.examType}`
        : `exam!=${q.examType}`,
      q.status === QuestionStatus.ACTIVE
        ? `status=active`
        : `status=${q.status}`,
      q.year === args.year ? `year=${q.year}` : `year=${q.year ?? 'NULL'}`,
      q.wassecPaper === args.paper
        ? `paper=${q.wassecPaper}`
        : `paper=${q.wassecPaper ?? 'NULL'}`,
    ];
    const key = flags.join(' | ');
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }

  console.log('Bucket breakdown (subject-scoped):');
  console.log('   count  | exam | status | year | paper');
  console.log('   -------+------+--------+------+------');
  for (const [k, n] of [...buckets.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(n).padStart(5)}  | ${k}`);
  }

  // 4) If the strict count is wrong, list the IDs and createdAt of the
  //    rows that *did* match — useful for spotting whether they came from
  //    one bulk import or multiple.
  console.log(`\nIDs that DID match the strict filter (${strict.length}):`);
  for (const q of strict) {
    console.log(
      `   ${q.id}  ${q.createdAt?.toISOString() ?? '?'}  section=${q.section ?? '-'}`,
    );
  }

  await dataSource.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
