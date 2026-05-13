import { Injectable, Logger } from '@nestjs/common';
import { ReferralsService } from '../modules/referrals/referrals.service';

/**
 * Spec §1.2 / §6.2: check referral qualification after 10 questions. Invoked
 * from ExamsService post-submit + post-complete (see ExamsService.submitAnswer
 * and complete()). Kept as a dedicated wrapper so a future BullMQ handoff can
 * move the check off the request path without touching call sites.
 */
@Injectable()
export class ReferralQualifyJob {
  private readonly logger = new Logger(ReferralQualifyJob.name);

  constructor(private readonly referrals: ReferralsService) {}

  async run(userId: string): Promise<boolean> {
    const promoted = await this.referrals.checkQualification(userId);
    if (promoted) {
      this.logger.log(`[referrals] user ${userId} qualified`);
    }
    return promoted;
  }
}
