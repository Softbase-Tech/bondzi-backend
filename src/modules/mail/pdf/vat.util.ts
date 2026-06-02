/**
 * VAT breakdown helpers.
 *
 * Prices in the plans catalogue are stored VAT-INCLUSIVE (admin sets
 * ₵200, user pays ₵200, receipt shows the tax inside that 200). This
 * helper splits a gross amount into its net + VAT components using
 * the inclusive formula:
 *
 *     vat  = gross × rate / (100 + rate)
 *     net  = gross − vat
 *
 * Rounding is done with .toFixed(2) at the boundary so the displayed
 * net + VAT add up exactly to the gross — invoice arithmetic that's
 * off by 0.01 is a frequent customer-support complaint we want to
 * avoid up-front.
 */
export interface VatBreakdown {
  gross: number; // input amount
  net: number; // taxable amount before VAT
  vat: number; // VAT portion
  ratePct: number; // copy of input for display
}

export function computeVatInclusive(
  gross: number,
  ratePct: number,
): VatBreakdown {
  if (ratePct <= 0) {
    return { gross, net: gross, vat: 0, ratePct };
  }
  const vat = round2((gross * ratePct) / (100 + ratePct));
  const net = round2(gross - vat);
  return { gross: round2(gross), net, vat, ratePct };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
