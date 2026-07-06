import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { EntitlementService } from '../../../common/types/enums';

/**
 * Per-user, per-service, per-Accra-day counter. Written to by the
 * RequiresService guard via a single UPSERT that increments and
 * returns the new count in one round-trip, so two concurrent requests
 * can't both slip past the cap.
 *
 * `day` is an Accra-wall-clock date (`YYYY-MM-DD`). Rolling over at
 * local midnight matches the streak service and the daily-goal
 * counters; a UTC boundary would frustrate students whose day starts
 * before UTC midnight.
 */
@Entity({ name: 'user_service_usage' })
export class UserServiceUsage {
  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId: string;

  @PrimaryColumn({
    type: 'enum',
    enum: EntitlementService,
    enumName: 'entitlement_service_enum',
  })
  service: EntitlementService;

  /** `YYYY-MM-DD` in Africa/Accra. */
  @PrimaryColumn({ type: 'date' })
  day: string;

  @Column({ name: 'used_count', type: 'int', default: 0 })
  usedCount: number;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
