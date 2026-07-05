import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { AccountType, EntitlementService } from '../../../common/types/enums';

/**
 * Tier × service policy. One row per (accountType, service). Read by
 * the RequiresService guard on every gated request; edited by admin
 * via `/admin/entitlements`. See migration
 * `1960000000000-EntitlementMatrix.ts` for the shape rationale.
 */
@Entity({ name: 'tier_services' })
@Index('idx_tier_services_lookup', ['accountType', 'service'])
export class TierService {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({
    name: 'account_type',
    type: 'enum',
    enum: AccountType,
    enumName: 'account_type_enum',
  })
  accountType: AccountType;

  @Column({
    type: 'enum',
    enum: EntitlementService,
    enumName: 'entitlement_service_enum',
  })
  service: EntitlementService;

  @Column({ type: 'bool', default: true })
  enabled: boolean;

  /**
   * Requests per Accra day. NULL = unlimited (still tracked in
   * user_service_usage for analytics, just not enforced). 0 with
   * enabled=true is a legitimate "kill switch" state.
   */
  @Column({ name: 'daily_cap', type: 'int', nullable: true })
  dailyCap: number | null;

  /**
   * Per-service flags. Known keys today:
   *   { requiresFormLevel: true } — refuse when user.formLevel is null
   *   (used by level_tests so NOVDEC users are gated cleanly).
   *   { model: string } — override model at runtime without a deploy
   *   (for the services whose provider/model can flip per tier).
   */
  @Column({ type: 'jsonb', default: () => `'{}'::jsonb` })
  config: Record<string, unknown>;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  /** Admin user id who last edited this row. Null for the initial seed. */
  @Column({ name: 'updated_by', type: 'uuid', nullable: true })
  updatedBy: string | null;
}
