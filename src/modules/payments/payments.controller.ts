import { Controller, Get, Header, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Public } from '../../common/decorators/public.decorator';
import { PaymentsService } from './payments.service';

@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Get('history')
  @ApiOperation({ summary: "Current user's payment event history." })
  history(@CurrentUser() user: AuthenticatedUser) {
    return this.payments.listUserPayments(user.id);
  }

  /**
   * Paystack post-payment "callback" — the URL Paystack redirects the
   * user's browser to once the transaction settles (success OR
   * abandoned at Paystack). This route is the ONLY thing standing
   * between a paid user and their app:
   *
   *   - Mobile flow: the user paid inside an in-app browser
   *     (Safari View Controller / Chrome Custom Tabs). Paystack
   *     redirects here. We respond with a tiny HTML page that
   *     immediately hops to `bondzi://payment/return?reference=…`,
   *     which is registered as the app's URL scheme (see
   *     mobile/app.json `scheme: 'bondzi'`). ASWebAuthenticationSession
   *     / Custom Tabs detects the deep-link redirect, closes the
   *     in-app browser, and hands control back to the JS layer of
   *     the app — which then calls /subscriptions/verify with the
   *     reference to confirm the outcome.
   *
   *   - Web flow (if/when we ship one): Paystack redirects a real
   *     browser tab here. The same HTML loads, the deep link fails
   *     silently (no app installed) and the visible "Return to app"
   *     link / "Open Bondzi" CTA covers the fallback.
   *
   *   - Webhook is still the authoritative state-change channel
   *     (charge.success / charge.failed). This endpoint does NOT
   *     mutate any DB state — it is purely UX glue.
   *
   * Public route — Paystack hits it unauthenticated, the user's
   * browser may or may not be carrying our cookies.
   */
  @Public()
  @Get('callback')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  callback(
    @Query('reference') reference: string | undefined,
    @Query('trxref') trxref: string | undefined,
    @Res() res: Response,
  ): void {
    // Pick whichever Paystack chose to send — both are populated on a
    // real callback. Sanitise for HTML injection safety (Paystack's
    // own references are alnum + underscore + hyphen, but we treat
    // the query string as untrusted because anyone can hit this URL).
    const raw = reference ?? trxref ?? '';
    const safe = raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 128);

    // Build the deep link back to the app.
    const deepLink = `bondzi://payment/return?reference=${encodeURIComponent(safe)}`;

    res.status(200).send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex,nofollow" />
<title>Returning to Bondzi…</title>
<style>
  body { margin:0; font-family:-apple-system,Segoe UI,Roboto,system-ui,sans-serif;
         background:#FFFFFF; color:#1A1A2E; display:flex; flex-direction:column;
         align-items:center; justify-content:center; min-height:100vh; padding:24px; }
  .spinner { width:32px; height:32px; border:3px solid #FFD6C5; border-top-color:#FF6B35;
             border-radius:50%; animation:spin .9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  h1 { font-size:18px; margin:24px 0 8px; font-weight:700; }
  p  { font-size:14px; color:#64748B; margin:0 0 24px; text-align:center; max-width:320px; }
  a.btn { display:inline-block; padding:12px 20px; background:#FF6B35; color:#fff;
          border-radius:999px; text-decoration:none; font-weight:600; font-size:14px; }
</style>
</head>
<body>
  <div class="spinner" aria-hidden="true"></div>
  <h1>Confirming your payment…</h1>
  <p>You're being returned to the Bondzi app. If it doesn't open automatically, tap below.</p>
  <a class="btn" href="${deepLink}">Open Bondzi</a>
  <script>
    // Fire the deep link immediately. In-app browsers
    // (ASWebAuthenticationSession / Chrome Custom Tabs) detect the
    // navigation to the registered URL scheme and dismiss themselves
    // — the JS in the app then resumes the verify flow.
    window.location.replace(${JSON.stringify(deepLink)});
  </script>
</body>
</html>`);
  }
}
