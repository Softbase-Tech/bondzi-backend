/* eslint-disable @typescript-eslint/no-require-imports */
import { computeVatInclusive, VatBreakdown } from './vat.util';

// pdfkit ships only CommonJS; the import shape is awkward when consumed
// from ESM-style TS. require() avoids a runtime/typings mismatch.
const PDFDocument =
  require('pdfkit') as typeof import('pdfkit');

export interface ReceiptArgs {
  recipientName: string;
  recipientEmail: string;
  /** "Bondzi Plus · WASSCE" etc. */
  planName: string;
  account: string; // 'Plus' | 'Pro' display label
  level: string; // 'BECE' | 'WASSCE' | 'NOVDEC'
  amountDisplay: number; // gross, VAT-inclusive
  currency: string; // 'GHS'
  vatRatePct: number;
  paidAt: Date;
  reference: string;
  /** For Plus: 'Lifetime'. For Pro: ISO date string of next renewal. */
  validUntil: string;
}

const BRAND_NAVY = '#1A1A2E';
const BRAND_ORANGE = '#FF6B35';
const TEXT_MUTED = '#64748B';
const RULE = '#E5E7EB';

/**
 * Generate a payment-success receipt as a PDF buffer. Layout:
 *
 *   [Brand bar in navy]                Receipt #<reference>
 *
 *   Bondzi                              Issued: <date>
 *   Ghana                               Reference: <ref>
 *
 *   ────────────────────────────────────────────────────────────
 *   Bill to: <name> <email>             Plan: <name>
 *                                       Level: <level>
 *                                       Account: <Plus|Pro>
 *                                       Valid until: <Lifetime|date>
 *   ────────────────────────────────────────────────────────────
 *   Description                                         Amount
 *   ────────────────────────────────────────────────────────────
 *   <plan>                                              <net>
 *                                                       <vat>
 *                                                       ───────
 *                                          TOTAL PAID   <gross>
 *
 *   Thank you for your purchase.
 *   Bondzi · bondzi.app · support@bondzi.app
 *
 * Caller is responsible for emailing the buffer as an attachment with
 * a sensible filename — see payment-success template.
 */
export async function generateReceiptPdf(args: ReceiptArgs): Promise<Buffer> {
  const breakdown = computeVatInclusive(args.amountDisplay, args.vatRatePct);
  return new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 56, bottom: 56, left: 56, right: 56 },
        info: {
          Title: `Bondzi Receipt ${args.reference}`,
          Author: 'Bondzi',
          Creator: 'Bondzi',
          Subject: `Receipt for ${args.planName}`,
        },
      });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      renderHeader(doc, args);
      renderBillingBlock(doc, args);
      renderLineItems(doc, args, breakdown);
      renderFooter(doc);

      doc.end();
    } catch (err) {
      reject(err as Error);
    }
  });
}

function renderHeader(
  doc: PDFKit.PDFDocument,
  args: ReceiptArgs,
): void {
  // Navy header strip
  doc
    .rect(0, 0, doc.page.width, 70)
    .fill(BRAND_NAVY);
  doc
    .fillColor('#FFFFFF')
    .font('Helvetica-Bold')
    .fontSize(20)
    .text('Bondzi', 56, 24, { baseline: 'top' });
  doc
    .font('Helvetica')
    .fontSize(11)
    .fillColor('#FFFFFF')
    .text('Receipt', 0, 30, { width: doc.page.width - 56, align: 'right' });
  doc
    .fillColor(TEXT_MUTED)
    .moveDown(2);

  // Issued + reference, right-aligned under the strip
  const yMeta = 90;
  doc
    .font('Helvetica')
    .fontSize(10)
    .fillColor(TEXT_MUTED);
  doc.text(`Issued: ${formatDate(args.paidAt)}`, 56, yMeta, {
    width: doc.page.width - 112,
    align: 'right',
  });
  doc.text(`Reference: ${args.reference}`, 56, yMeta + 14, {
    width: doc.page.width - 112,
    align: 'right',
  });
}

function renderBillingBlock(
  doc: PDFKit.PDFDocument,
  args: ReceiptArgs,
): void {
  const startY = 140;
  doc
    .font('Helvetica-Bold')
    .fontSize(11)
    .fillColor(BRAND_NAVY)
    .text('Bill to', 56, startY);
  doc
    .font('Helvetica')
    .fontSize(11)
    .fillColor('#1A1A2E')
    .text(args.recipientName, 56, startY + 16)
    .text(args.recipientEmail, 56, startY + 30);

  // Right column: plan details
  const rightX = 320;
  doc
    .font('Helvetica-Bold')
    .fontSize(11)
    .fillColor(BRAND_NAVY)
    .text('Plan', rightX, startY);
  doc.font('Helvetica').fontSize(11).fillColor('#1A1A2E');
  doc.text(args.planName, rightX, startY + 16);
  doc.text(`${args.account} · ${args.level}`, rightX, startY + 30);
  doc.text(`Valid until: ${args.validUntil}`, rightX, startY + 44);

  // Rule below the block
  const ruleY = startY + 76;
  doc
    .strokeColor(RULE)
    .lineWidth(1)
    .moveTo(56, ruleY)
    .lineTo(doc.page.width - 56, ruleY)
    .stroke();
}

function renderLineItems(
  doc: PDFKit.PDFDocument,
  args: ReceiptArgs,
  breakdown: VatBreakdown,
): void {
  const startY = 240;
  doc
    .font('Helvetica-Bold')
    .fontSize(10)
    .fillColor(TEXT_MUTED);
  doc.text('Description', 56, startY);
  doc.text('Amount', 56, startY, {
    width: doc.page.width - 112,
    align: 'right',
  });
  doc
    .strokeColor(RULE)
    .lineWidth(1)
    .moveTo(56, startY + 18)
    .lineTo(doc.page.width - 56, startY + 18)
    .stroke();

  let y = startY + 28;
  // Net + VAT lines
  doc
    .font('Helvetica')
    .fontSize(11)
    .fillColor('#1A1A2E');
  doc.text(args.planName, 56, y);
  doc.text(
    `${args.currency} ${breakdown.net.toFixed(2)}`,
    56,
    y,
    { width: doc.page.width - 112, align: 'right' },
  );
  y += 18;
  doc
    .fillColor(TEXT_MUTED)
    .fontSize(10)
    .text(
      `VAT @ ${breakdown.ratePct.toFixed(2)}%`,
      56,
      y,
    );
  doc.text(
    `${args.currency} ${breakdown.vat.toFixed(2)}`,
    56,
    y,
    { width: doc.page.width - 112, align: 'right' },
  );

  y += 22;
  doc
    .strokeColor(RULE)
    .lineWidth(1)
    .moveTo(320, y)
    .lineTo(doc.page.width - 56, y)
    .stroke();

  y += 8;
  doc
    .font('Helvetica-Bold')
    .fontSize(13)
    .fillColor(BRAND_NAVY)
    .text('Total paid', 56, y);
  doc
    .fillColor(BRAND_ORANGE)
    .text(
      `${args.currency} ${breakdown.gross.toFixed(2)}`,
      56,
      y,
      { width: doc.page.width - 112, align: 'right' },
    );
}

function renderFooter(doc: PDFKit.PDFDocument): void {
  const y = doc.page.height - 96;
  doc
    .strokeColor(RULE)
    .lineWidth(1)
    .moveTo(56, y)
    .lineTo(doc.page.width - 56, y)
    .stroke();
  doc
    .font('Helvetica')
    .fontSize(10)
    .fillColor(TEXT_MUTED)
    .text(
      'Thank you for your purchase.',
      56,
      y + 14,
    )
    .text(
      'Bondzi · bondzi.app · support@bondzi.app',
      56,
      y + 30,
    );
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}
