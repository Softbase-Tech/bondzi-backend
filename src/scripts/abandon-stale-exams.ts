/**
 * Mark every IN_PROGRESS exam as ABANDONED. Useful after importing more
 * questions for a paper — the existing in-progress exams have a frozen
 * `question_ids` snapshot that was captured before the import, so they'd
 * keep showing the old (smaller) total even though the DB now has more.
 *
 * Run:
 *   npx ts-node -r tsconfig-paths/register src/scripts/abandon-stale-exams.ts
 *   # or scope to one user:
 *   npx ts-node -r tsconfig-paths/register src/scripts/abandon-stale-exams.ts \
 *     --user=<userId>
 *   # dry-run (lists targets without writing):
 *   npx ts-node -r tsconfig-paths/register src/scripts/abandon-stale-exams.ts \
 *     --dry-run
 */
import 'dotenv/config';
import 'reflect-metadata';
import dataSource from '../../ormconfig';
import { Exam } from '../modules/exams/entities/exam.entity';
import { ExamStatus } from '../common/types/enums';

interface Args {
  userId?: string;
  dryRun: boolean;
}

function parseArgs(): Args {
  const out: Args = { dryRun: false };
  for (const arg of process.argv.slice(2)) {
    const [k, v] = arg.replace(/^--/, '').split('=');
    if (k === 'user' && v) out.userId = v;
    if (k === 'dry-run') out.dryRun = true;
  }
  return out;
}

async function main() {
  const args = parseArgs();
  await dataSource.initialize();
  const repo = dataSource.getRepository(Exam);

  const where = args.userId
    ? { userId: args.userId, status: ExamStatus.IN_PROGRESS }
    : { status: ExamStatus.IN_PROGRESS };

  const targets = await repo.find({
    where,
    order: { startedAt: 'DESC' },
  });

  console.log(
    `\nFound ${targets.length} in-progress exam${targets.length === 1 ? '' : 's'}${args.userId ? ` for user ${args.userId}` : ''}.\n`,
  );

  for (const exam of targets) {
    console.log(
      `  ${exam.id}  user=${exam.userId}  ${exam.mode}  questions=${exam.questionIds.length}  startedAt=${exam.startedAt.toISOString()}`,
    );
  }

  if (args.dryRun || targets.length === 0) {
    console.log(`\n${args.dryRun ? '[dry-run]' : 'Nothing to do'} — no rows changed.`);
    await dataSource.destroy();
    return;
  }

  const now = new Date();
  await repo
    .createQueryBuilder()
    .update(Exam)
    .set({ status: ExamStatus.ABANDONED, completedAt: now })
    .whereInIds(targets.map((e) => e.id))
    .execute();

  console.log(`\n✓ Marked ${targets.length} exam${targets.length === 1 ? '' : 's'} as ABANDONED.`);
  await dataSource.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
