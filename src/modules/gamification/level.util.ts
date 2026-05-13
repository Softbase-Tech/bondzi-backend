/**
 * Level thresholds are product-fixed constants (not admin-configurable).
 *
 *   L1: 0    L2: 100    L3: 250   L4: 500   L5: 800   L6: 1200
 *   L7: 1700 L8: 2300   L9: 3000  L10: 4000
 *   L11+: +1000 per level (4000 + 1000*(level-10))
 */
const BASE_THRESHOLDS = [0, 100, 250, 500, 800, 1200, 1700, 2300, 3000, 4000];

function thresholdForLevel(level: number): number {
  if (level < 1) return 0;
  if (level <= BASE_THRESHOLDS.length) return BASE_THRESHOLDS[level - 1];
  return 4000 + 1000 * (level - 10);
}

/** Highest level whose threshold is <= given total level_xp. */
export function levelForXp(levelXp: number): number {
  let lvl = 1;
  while (thresholdForLevel(lvl + 1) <= levelXp) lvl += 1;
  return lvl;
}

/** XP needed to reach `level + 1`. */
export function xpToNextLevel(level: number): number {
  return thresholdForLevel(level + 1) - thresholdForLevel(level);
}

/** XP accumulated inside the current level (0 ≤ value < xpToNextLevel). */
export function xpIntoLevel(levelXp: number): number {
  const lvl = levelForXp(levelXp);
  return levelXp - thresholdForLevel(lvl);
}
