/**
 * SuperMemo SM-2 update function.
 *
 * quality: 0-5, where
 *   0 = complete blackout, 1 = incorrect / familiar, 2 = incorrect but easy,
 *   3 = correct but hard, 4 = correct after hesitation, 5 = perfect recall.
 *
 * Spec §4.2 (SrsCard "SM-2 algorithm"):
 *   if quality < 3 → reset interval to 1, repetitions to 0
 *   else:
 *     easeFactor = max(1.3, ef + 0.1 - (5-q)*(0.08+(5-q)*0.02))
 *     if repetitions === 0: interval = 1
 *     else if repetitions === 1: interval = 6
 *     else: interval = round(interval * easeFactor)
 *     repetitions += 1
 *   nextReviewAt = now + intervalDays
 *
 * Implemented as a pure function so it is 100%-unit-testable.
 */
export interface Sm2State {
  easeFactor: number;
  intervalDays: number;
  repetitions: number;
  lastQuality: number;
  nextReviewAt: Date;
  lastReviewedAt: Date;
}

export interface Sm2Input {
  easeFactor: number;
  intervalDays: number;
  repetitions: number;
}

export function sm2(
  quality: number,
  card: Sm2Input,
  now: Date = new Date(),
): Sm2State {
  if (!Number.isInteger(quality) || quality < 0 || quality > 5) {
    throw new RangeError('SM-2 quality must be an integer in [0,5]');
  }

  let { easeFactor, intervalDays, repetitions } = card;

  if (quality < 3) {
    repetitions = 0;
    intervalDays = 1;
  } else {
    const delta = 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02);
    easeFactor = Math.max(1.3, easeFactor + delta);

    if (repetitions === 0) {
      intervalDays = 1;
    } else if (repetitions === 1) {
      intervalDays = 6;
    } else {
      intervalDays = Math.round(intervalDays * easeFactor);
    }
    repetitions += 1;
  }

  const nextReviewAt = new Date(
    now.getTime() + intervalDays * 24 * 60 * 60 * 1000,
  );
  return {
    easeFactor,
    intervalDays,
    repetitions,
    lastQuality: quality,
    nextReviewAt,
    lastReviewedAt: now,
  };
}
