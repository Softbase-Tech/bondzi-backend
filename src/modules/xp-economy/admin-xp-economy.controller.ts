import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExcludeController,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../common/types/enums';
import { XpRateConfig } from './entities/xp-rate-config.entity';
import { XpRedemptionConfig } from './entities/xp-redemption-config.entity';
import { XpRedemption } from './entities/xp-redemption.entity';
import { XpTransaction } from './entities/xp-transaction.entity';
import { User } from '../users/entities/user.entity';
import { ReferralEvent } from '../referrals/entities/referral-event.entity';

interface DailyXpBucket {
  day: string;
  issued: number;
  redeemed: number;
}

/**
 * Admin surface for XP economy:
 *   - Read-all (inactive included) on rates + tiers
 *   - PATCH to toggle isActive / change amounts
 *   - Health snapshot (issued vs redeemed) + 30-day chart series
 *   - Redemption log (paginated) for audit
 *   - Referral XP summary (top referrers + chain count)
 *
 * The matching consumer endpoints live in XpEconomyController at /xp/*
 * — they only ever return `isActive=true` rows because students should
 * not see disabled rates/tiers. The admin needs the disabled ones so it
 * can re-enable them.
 */
@ApiTags('admin-xp-economy')
@ApiExcludeController()
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
@Controller('admin/xp-economy')
export class AdminXpEconomyController {
  constructor(
    @InjectRepository(XpRateConfig)
    private readonly ratesRepo: Repository<XpRateConfig>,
    @InjectRepository(XpRedemptionConfig)
    private readonly tiersRepo: Repository<XpRedemptionConfig>,
    @InjectRepository(XpRedemption)
    private readonly redemptionsRepo: Repository<XpRedemption>,
    @InjectRepository(XpTransaction)
    private readonly txRepo: Repository<XpTransaction>,
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
    @InjectRepository(ReferralEvent)
    private readonly referralsRepo: Repository<ReferralEvent>,
  ) {}

  // ----------------------- Rate config -----------------------

  @Get('rates')
  listRates() {
    return this.ratesRepo.find({ order: { xpAmount: 'DESC' } });
  }

  @Patch('rates/:id')
  @ApiOperation({
    summary:
      'Update xpAmount and/or isActive on a single rate row. Other fields are read-only.',
  })
  async updateRate(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: { xpAmount?: number; isActive?: boolean },
  ): Promise<XpRateConfig> {
    const row = await this.ratesRepo.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Rate not found');
    if (
      body.xpAmount !== undefined &&
      (!Number.isFinite(body.xpAmount) || body.xpAmount < 0)
    ) {
      throw new BadRequestException('xpAmount must be a non-negative number');
    }
    if (body.xpAmount !== undefined) row.xpAmount = Math.floor(body.xpAmount);
    if (typeof body.isActive === 'boolean') row.isActive = body.isActive;
    return this.ratesRepo.save(row);
  }

  // ----------------------- Redemption tiers -----------------------

  @Get('redemption-tiers')
  listTiers() {
    return this.tiersRepo.find({ order: { xpCost: 'ASC' } });
  }

  @Patch('redemption-tiers/:id')
  @ApiOperation({
    summary: 'Update xpCost, creditDays, and/or isActive on a tier.',
  })
  async updateTier(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body()
    body: { xpCost?: number; creditDays?: number; isActive?: boolean },
  ): Promise<XpRedemptionConfig> {
    const row = await this.tiersRepo.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Tier not found');
    if (
      body.xpCost !== undefined &&
      (!Number.isFinite(body.xpCost) || body.xpCost < 0)
    ) {
      throw new BadRequestException('xpCost must be non-negative');
    }
    if (
      body.creditDays !== undefined &&
      (!Number.isFinite(body.creditDays) || body.creditDays < 1)
    ) {
      throw new BadRequestException('creditDays must be at least 1');
    }
    if (body.xpCost !== undefined) row.xpCost = Math.floor(body.xpCost);
    if (body.creditDays !== undefined)
      row.creditDays = Math.floor(body.creditDays);
    if (typeof body.isActive === 'boolean') row.isActive = body.isActive;
    return this.tiersRepo.save(row);
  }

  // ----------------------- Health -----------------------

  @Get('health')
  @ApiOperation({
    summary:
      'XP economy health: total outstanding spendable XP, this-week issued/redeemed, and a 30-day issued-vs-redeemed series.',
  })
  async health() {
    // Outstanding spendable XP across all users — what would we owe in
    // subscription days if everyone redeemed today.
    const sumRow: { sum: string | null }[] = await this.usersRepo.manager.query(
      `select coalesce(sum(spendable_xp), 0)::text as sum from users where is_active = true;`,
    );
    const spendableXpOutstanding = parseInt(sumRow[0]?.sum ?? '0', 10);

    // This-week issued = sum of positive level_xp deltas from xp_transactions
    // in the trailing 7 days. We pull level_xp not spendable_xp because
    // spendable goes negative on redemption — level_xp only ever grows.
    const issuedRow: { sum: string | null }[] = await this.txRepo.manager.query(
      `
        select coalesce(sum(level_xp), 0)::text as sum
        from xp_transactions
        where created_at > now() - interval '7 days'
          and level_xp > 0;
      `,
    );
    const xpIssuedThisWeek = parseInt(issuedRow[0]?.sum ?? '0', 10);

    const redeemedRow: { sum: string | null }[] =
      await this.redemptionsRepo.manager.query(
        `
          select coalesce(sum(xp_spent), 0)::text as sum
          from xp_redemptions
          where applied_at > now() - interval '7 days';
        `,
      );
    const xpRedeemedThisWeek = parseInt(redeemedRow[0]?.sum ?? '0', 10);

    const redemptionRate =
      xpIssuedThisWeek > 0 ? xpRedeemedThisWeek / xpIssuedThisWeek : 0;

    // 30-day daily series — issued from xp_transactions, redeemed from
    // xp_redemptions. Uses a generate_series so empty days appear as 0
    // rather than gaps in the chart.
    const daily: DailyXpBucket[] = await this.txRepo.manager.query(
      `
        with days as (
          select generate_series(
            (current_date - interval '29 days')::date,
            current_date,
            interval '1 day'
          )::date as day
        ),
        issued as (
          select date(created_at) as day, sum(level_xp)::int as v
          from xp_transactions
          where created_at >= current_date - interval '29 days'
            and level_xp > 0
          group by 1
        ),
        redeemed as (
          select date(applied_at) as day, sum(xp_spent)::int as v
          from xp_redemptions
          where applied_at >= current_date - interval '29 days'
          group by 1
        )
        select
          to_char(d.day, 'YYYY-MM-DD') as day,
          coalesce(i.v, 0)::int as issued,
          coalesce(r.v, 0)::int as redeemed
        from days d
        left join issued i on i.day = d.day
        left join redeemed r on r.day = d.day
        order by d.day;
      `,
    );

    return {
      spendableXpOutstanding,
      xpIssuedThisWeek,
      xpRedeemedThisWeek,
      redemptionRate,
      daily30d: daily,
    };
  }

  // ----------------------- Redemption log -----------------------

  @Get('redemption-log')
  @ApiOperation({
    summary:
      'Paginated XP redemption events newest-first, joined with the tier label and the user name. ' +
      'Backs the admin "Redemption log" table and CSV export.',
  })
  async redemptionLog(@Query('limit') limitParam?: string) {
    const parsed = limitParam ? parseInt(limitParam, 10) : 50;
    const limit =
      Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 500) : 50;
    interface Row {
      id: string;
      user_id: string;
      user_name: string;
      tier_key: string;
      tier_label: string | null;
      xp_spent: number;
      credit_days: number;
      applied_at: string;
    }
    const rows: Row[] = await this.redemptionsRepo.manager.query(
      `
        select
          r.id,
          r.user_id,
          u.full_name as user_name,
          r.tier_key,
          t.label as tier_label,
          r.xp_spent,
          r.credit_days,
          r.applied_at
        from xp_redemptions r
        inner join users u on u.id = r.user_id
        left join xp_redemption_config t on t.tier_key = r.tier_key
        order by r.applied_at desc
        limit $1;
      `,
      [limit],
    );
    const items = rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      userName: r.user_name,
      tierKey: r.tier_key,
      tierLabel: r.tier_label ?? r.tier_key,
      xpSpent: r.xp_spent,
      creditDays: r.credit_days,
      appliedAt: new Date(r.applied_at).toISOString(),
    }));
    return { items, total: items.length, nextCursor: null };
  }

  // ----------------------- Referral summary -----------------------

  @Get('referrals')
  @ApiOperation({
    summary:
      'Headline referral XP figures + top 10 referrers. ' +
      'Top referrers ranked by total XP earned from referral events; ties broken by referral count.',
  })
  async referralSummary() {
    // Total referral XP issued = sum of xp_transactions where event_key
    // matches a referral reward. The exact keys live in xp_rate_config;
    // we filter by the prefix `referral_` to catch both signup and
    // qualification rewards without hard-coding the full list.
    const totalRow: { sum: string | null }[] = await this.txRepo.manager.query(
      `
        select coalesce(sum(level_xp), 0)::text as sum
        from xp_transactions
        where event_key like 'referral_%' and level_xp > 0;
      `,
    );
    const totalReferralXp = parseInt(totalRow[0]?.sum ?? '0', 10);

    // Active chains = distinct referrer_id with at least one qualified
    // referral. The cron job sets qualified_at when the referred user
    // crosses the answer threshold.
    const chainsRow: { count: string | null }[] =
      await this.referralsRepo.manager.query(
        `
          select count(distinct referrer_id)::text as count
          from referral_events
          where qualified_at is not null;
        `,
      );
    const activeChains = parseInt(chainsRow[0]?.count ?? '0', 10);

    interface TopRow {
      user_id: string;
      full_name: string;
      total_xp: string;
      referral_count: string;
    }
    const topRows: TopRow[] = await this.referralsRepo.manager.query(
      `
        select
          re.referrer_id as user_id,
          u.full_name,
          coalesce(sum(
            case when xt.event_key like 'referral_%' then xt.level_xp else 0 end
          ), 0)::text as total_xp,
          count(distinct re.referred_id)::text as referral_count
        from referral_events re
        inner join users u on u.id = re.referrer_id
        left join xp_transactions xt on xt.user_id = re.referrer_id
        where re.qualified_at is not null
        group by re.referrer_id, u.full_name
        order by total_xp desc, referral_count desc
        limit 10;
      `,
    );

    return {
      totalReferralXp,
      activeChains,
      topReferrers: topRows.map((r) => ({
        userId: r.user_id,
        fullName: r.full_name,
        totalXp: parseInt(r.total_xp, 10) || 0,
        referralCount: parseInt(r.referral_count, 10) || 0,
      })),
    };
  }
}
