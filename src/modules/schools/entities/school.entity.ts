import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** [P2] — table exists from Phase 1 migration so school member FKs can resolve. */
@Entity({ name: 'schools' })
export class School {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  name: string;

  @Column({ type: 'text', nullable: true })
  region: string | null;

  @Column({ name: 'contact_email', type: 'text', nullable: true })
  contactEmail: string | null;

  @Column({ name: 'licence_key', type: 'text', unique: true, nullable: true })
  licenceKey: string | null;

  @Column({ name: 'student_cap', type: 'int', default: 100 })
  studentCap: number;

  @Column({ name: 'country_code', type: 'varchar', length: 2, default: 'GH' })
  countryCode: string;

  @Column({ name: 'licence_expires_at', type: 'timestamptz', nullable: true })
  licenceExpiresAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
