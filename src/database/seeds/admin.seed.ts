import { DataSource } from 'typeorm';
import { User } from '../../modules/users/entities/user.entity';
import {
  AuthProvider,
  ExamType,
  SchoolLevel,
  UserRole,
} from '../../common/types/enums';
import { hashPassword } from '../../common/utils/password.util';

/**
 * Seed / upsert the platform superadmin.
 *
 * The v2 users table requires exam_type, school_level, form_level and a unique
 * referral_code on every row — these are modelled around students but the
 * schema enforces them for all roles. Admins don't actually take exams, so we
 * pick sensible defaults (WASSCE / SHS / form 3) and a distinctive referral
 * code so the admin never collides with a student's generated one.
 */
export async function seedAdmin(ds: DataSource): Promise<void> {
  const email = process.env.SEED_ADMIN_EMAIL ?? 'admin@passmaster.com.gh';
  const password = process.env.SEED_ADMIN_PASSWORD ?? 'change_me_strong_8+';
  const name = process.env.SEED_ADMIN_NAME ?? 'Platform Admin';
  const referralCode = process.env.SEED_ADMIN_REFERRAL_CODE ?? 'PM-ADMIN';

  const repo = ds.getRepository(User);
  const existing = await repo.findOne({ where: { email } });
  const passwordHash = await hashPassword(password);

  if (existing) {
    await repo.update(existing.id, {
      fullName: name,
      role: UserRole.SUPERADMIN,
      passwordHash,
      authProvider: AuthProvider.EMAIL,
      isActive: true,
      // Backfill v2-required fields if the existing row predates the migration.
      examType: existing.examType ?? ExamType.WASSCE,
      schoolLevel: existing.schoolLevel ?? SchoolLevel.SHS,
      formLevel: existing.formLevel ?? 3,
      referralCode: existing.referralCode ?? referralCode,
    });
    return;
  }
  await repo.insert(
    repo.create({
      email,
      fullName: name,
      passwordHash,
      role: UserRole.SUPERADMIN,
      authProvider: AuthProvider.EMAIL,
      isActive: true,
      examType: ExamType.WASSCE,
      schoolLevel: SchoolLevel.SHS,
      formLevel: 3,
      referralCode,
    }),
  );
}
