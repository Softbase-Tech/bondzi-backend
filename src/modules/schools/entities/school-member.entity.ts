import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { SchoolRole } from '../../../common/types/enums';
import { School } from './school.entity';
import { User } from '../../users/entities/user.entity';

@Entity({ name: 'school_members' })
@Unique('school_member_uq', ['schoolId', 'userId'])
@Index('school_member_school_idx', ['schoolId'])
export class SchoolMember {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'school_id', type: 'uuid' })
  schoolId: string;

  @ManyToOne(() => School, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'school_id' })
  school: School;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'enum', enum: SchoolRole, default: SchoolRole.STUDENT })
  role: SchoolRole;

  @Column({ name: 'joined_at', type: 'timestamptz', default: () => 'now()' })
  joinedAt: Date;
}
