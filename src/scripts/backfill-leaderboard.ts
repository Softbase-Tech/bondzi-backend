/**
 * One-shot backfill: aggregate every `xp_transactions` row into the
 * `leaderboard_entries` table, bucketed by the week / month each tx
 * belongs to.
 *
 * Needed because the original gamification flow only wrote xp_transactions +
 * users.level_xp; nothing populated leaderboard_entries, so the public board
 * was always empty. New earns now go through a leaderboard upsert
 * (gamification.service.ts), but every earn that happened *before* this fix
 * needs catching up.
 *
 * Idempotent — safe to re-run. Computes period_start from the tx's
 * `created_at` (Mon-of-week / 1st-of-month) and groups in SQL so a single
 * pass replaces the leaderboard table from scratch.
 *
 * Run:
 *   npx ts-node -r tsconfig-paths/register src/scripts/backfill-leaderboard.ts
 *   # or scope to one user:
 *   npx ts-node -r tsconfig-paths/register src/scripts/backfill-leaderboard.ts \
 *     --user=<userId>
 */
import 'dotenv/config';
import 'reflect-metadata';
import dataSource from '../../ormconfig';

interface Args {
  userId?: string;
}

function parseArgs(): Args {
  const out: Args = {};
  for (const arg of process.argv.slice(2)) {
    const [k, v] = arg.replace(/^--/, '').split('=');
    if (k === 'user' && v) out.userId = v;
  }
  return out;
}

async function main() {
  const args = parseArgs();
  await dataSource.initialize();

  console.log('\n=== Backfilling leaderboard_entries from xp_transactions ===');
  if (args.userId) console.log(`Scoped to user: ${args.userId}`);

  const userFilter = args.userId ? `AND u.id = $1` : '';
  const params: unknown[] = args.userId ? [args.userId] : [];

  // Single SQL: group every xp_transactions row by user + period type +
  // period_start, sum the level_xp deltas, and upsert. Mirrors the runtime
  // increment semantics in gamification.service.ts:bumpLeaderboard.
  const upsertSql = (periodType: 'weekly' | 'monthly'): string => {
    const truncExpr =
      periodType === 'weekly'
        ? `date_trunc('week', tx.created_at)`
        : `date_trunc('month', tx.created_at)`;
    return `
      INSERT INTO leaderboard_entries
        (user_id, exam_type, scope, period_type, period_start, weekly_xp)
      SELECT
        tx.user_id,
        u.exam_type,
        'national',
        '${periodType}',
        (${truncExpr})::date,
        SUM(tx.level_xp)::int
      FROM xp_transactions tx
      JOIN users u ON u.id = tx.user_id
      WHERE tx.level_xp > 0 ${userFilter}
      GROUP BY tx.user_id, u.exam_type, ${truncExpr}
      ON CONFLICT (user_id, exam_type, scope, period_type, period_start)
      DO UPDATE SET weekly_xp = EXCLUDED.weekly_xp;
    `;
  };

  await dataSource.query(upsertSql('weekly'), params);
  console.log('Weekly buckets written.');

  await dataSource.query(upsertSql('monthly'), params);
  console.log('Monthly buckets written.');

  // Sanity print: this period's totals.
  interface WeekRow {
    exam_type: string;
    rows: string;
    xp: string;
  }
  const weekRows: WeekRow[] = await dataSource.query(
    `SELECT lb.exam_type, count(*) AS rows, sum(lb.weekly_xp) AS xp
     FROM leaderboard_entries lb
     WHERE lb.period_type = 'weekly'
       AND lb.period_start = date_trunc('week', now())::date
     GROUP BY lb.exam_type`,
  );
  console.log('\nCurrent week board snapshot:');
  for (const r of weekRows) {
    console.log(
      `  ${r.exam_type}: ${r.rows} ranked users, ${r.xp} total XP this week`,
    );
  }

  await dataSource.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
