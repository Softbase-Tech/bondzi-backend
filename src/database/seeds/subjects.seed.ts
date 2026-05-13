import { DataSource } from 'typeorm';
import { Subject } from '../../modules/subjects/entities/subject.entity';
import { ExamType, SubjectCategory } from '../../common/types/enums';

/**
 * v2 canonical subject list covering both exam platforms. Idempotent upsert on
 * `code`. Codes are prefixed `BECE_` or `WASSCE_` to keep the two platforms'
 * namespaces distinct.
 */
export const SUBJECT_SEED: Array<Partial<Subject>> = [
  // BECE (JHS)
  {
    code: 'BECE_MATHS',
    name: 'Mathematics',
    examType: ExamType.BECE,
    category: SubjectCategory.CORE,
    isCore: true,
    sortOrder: 1,
  },
  {
    code: 'BECE_ENGLISH',
    name: 'English Language',
    examType: ExamType.BECE,
    category: SubjectCategory.CORE,
    isCore: true,
    sortOrder: 2,
  },
  {
    code: 'BECE_SCIENCE',
    name: 'Integrated Science',
    examType: ExamType.BECE,
    category: SubjectCategory.CORE,
    isCore: true,
    sortOrder: 3,
  },
  {
    code: 'BECE_SOCIAL',
    name: 'Social Studies',
    examType: ExamType.BECE,
    category: SubjectCategory.CORE,
    isCore: true,
    sortOrder: 4,
  },
  {
    code: 'BECE_RME',
    name: 'Religious & Moral Education',
    examType: ExamType.BECE,
    category: SubjectCategory.CORE,
    isCore: true,
    sortOrder: 5,
  },
  {
    code: 'BECE_BDT',
    name: 'Basic Design & Technology',
    examType: ExamType.BECE,
    category: SubjectCategory.CORE,
    isCore: true,
    sortOrder: 6,
  },
  {
    code: 'BECE_FRENCH',
    name: 'French',
    examType: ExamType.BECE,
    category: SubjectCategory.ELECTIVE,
    isCore: false,
    sortOrder: 7,
  },
  {
    code: 'BECE_GHANALANG',
    name: 'Ghanaian Language',
    examType: ExamType.BECE,
    category: SubjectCategory.CORE,
    isCore: true,
    sortOrder: 8,
  },
  // WASSCE (SHS)
  {
    code: 'WASSCE_CORE_MATHS',
    name: 'Core Mathematics',
    examType: ExamType.WASSCE,
    category: SubjectCategory.CORE,
    isCore: true,
    sortOrder: 1,
  },
  {
    code: 'WASSCE_ENGLISH',
    name: 'English Language',
    examType: ExamType.WASSCE,
    category: SubjectCategory.CORE,
    isCore: true,
    sortOrder: 2,
  },
  {
    code: 'WASSCE_INT_SCI',
    name: 'Integrated Science',
    examType: ExamType.WASSCE,
    category: SubjectCategory.CORE,
    isCore: true,
    sortOrder: 3,
  },
  {
    code: 'WASSCE_SOC_STUD',
    name: 'Social Studies',
    examType: ExamType.WASSCE,
    category: SubjectCategory.CORE,
    isCore: true,
    sortOrder: 4,
  },
  {
    code: 'WASSCE_ELEC_MATHS',
    name: 'Elective Mathematics',
    examType: ExamType.WASSCE,
    category: SubjectCategory.ELECTIVE,
    isCore: false,
    sortOrder: 5,
  },
  {
    code: 'WASSCE_PHYSICS',
    name: 'Physics',
    examType: ExamType.WASSCE,
    category: SubjectCategory.ELECTIVE,
    isCore: false,
    sortOrder: 6,
  },
  {
    code: 'WASSCE_CHEMISTRY',
    name: 'Chemistry',
    examType: ExamType.WASSCE,
    category: SubjectCategory.ELECTIVE,
    isCore: false,
    sortOrder: 7,
  },
  {
    code: 'WASSCE_BIOLOGY',
    name: 'Biology',
    examType: ExamType.WASSCE,
    category: SubjectCategory.ELECTIVE,
    isCore: false,
    sortOrder: 8,
  },
  {
    code: 'WASSCE_ECON',
    name: 'Economics',
    examType: ExamType.WASSCE,
    category: SubjectCategory.ELECTIVE,
    isCore: false,
    sortOrder: 9,
  },
  {
    code: 'WASSCE_GEOG',
    name: 'Geography',
    examType: ExamType.WASSCE,
    category: SubjectCategory.ELECTIVE,
    isCore: false,
    sortOrder: 10,
  },
  {
    code: 'WASSCE_HISTORY',
    name: 'History',
    examType: ExamType.WASSCE,
    category: SubjectCategory.ELECTIVE,
    isCore: false,
    sortOrder: 11,
  },
  {
    code: 'WASSCE_LIT',
    name: 'Literature in English',
    examType: ExamType.WASSCE,
    category: SubjectCategory.ELECTIVE,
    isCore: false,
    sortOrder: 12,
  },
  {
    code: 'WASSCE_ICT',
    name: 'ICT',
    examType: ExamType.WASSCE,
    category: SubjectCategory.ELECTIVE,
    isCore: false,
    sortOrder: 13,
  },
  {
    code: 'WASSCE_FRENCH',
    name: 'French',
    examType: ExamType.WASSCE,
    category: SubjectCategory.ELECTIVE,
    isCore: false,
    sortOrder: 14,
  },
];

export async function seedSubjects(ds: DataSource): Promise<void> {
  const repo = ds.getRepository(Subject);
  for (const s of SUBJECT_SEED) {
    const existing = await repo.findOne({ where: { code: s.code } });
    if (existing) {
      await repo.update(existing.id, s);
    } else {
      await repo.insert(repo.create(s));
    }
  }
}
