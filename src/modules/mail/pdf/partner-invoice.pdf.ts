/* eslint-disable @typescript-eslint/no-require-imports */
// pdfkit ships CommonJS only — same shim as receipt.pdf.ts.
const PDFDocument = require('pdfkit') as typeof import('pdfkit');

/**
 * Line-item shape rendered inside the invoice table. Each row is one
 * commission the payout absorbed.
 */
export interface PartnerInvoiceLine {
  /** Human-readable description — "Plus WASSCE — Kwame A." etc. */
  description: string;
  /** Signed amount as a display string (negative for clawback rows). */
  amountGhs: string;
  /** ISO date the commission was earned. Optional. */
  earnedAt?: string;
}

export interface PartnerInvoiceArgs {
  invoiceNumber: string;
  partnerName: string;
  partnerEmail: string;
  momoProvider: string; // display label
  momoNumber: string;
  momoReference: string;
  weekOf: string; // ISO date
  paidAt: Date;
  currency: string; // 'GHS'
  /** 2dp string, e.g. "80.00" */
  totalAmount: string;
  lines: PartnerInvoiceLine[];
}

const BRAND_NAVY = '#1A1A2E';
const BRAND_ORANGE = '#FF6B35';
const TEXT_MUTED = '#64748B';
const RULE = '#E5E7EB';

/**
 * Generate the partner-payout invoice PDF as a Buffer. Attached to the
 * PARTNER_PAYOUT_PAID email + (later) uploaded to Cloudinary so partners
 * can re-download from the portal.
 *
 * Layout mirrors the payment receipt (navy header strip, right-aligned
 * meta, itemised body, orange TOTAL) so the visual language stays
 * consistent across every Bondzi document a user receives.
 */
export async function generatePartnerInvoicePdf(
  args: PartnerInvoiceArgs,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 56, bottom: 56, left: 56, right: 56 },
        info: {
          Title: `Bondzi Partner Invoice ${args.invoiceNumber}`,
          Author: 'Bondzi',
          Creator: 'Bondzi',
          Subject: `Partner payout ${args.invoiceNumber}`,
        },
      });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      renderHeader(doc, args);
      renderBillingBlock(doc, args);
      const linesEndY = renderLineItems(doc, args);
      renderTotal(doc, args, linesEndY);
      renderFooter(doc);

      doc.end();
    } catch (err) {
      reject(err as Error);
    }
  });
}

function renderHeader(doc: PDFKit.PDFDocument, args: PartnerInvoiceArgs): void {
  doc.rect(0, 0, doc.page.width, 70).fill(BRAND_NAVY);
  doc
    .fillColor('#FFFFFF')
    .font('Helvetica-Bold')
    .fontSize(20)
    .text('Bondzi', 56, 24, { baseline: 'top' });
  doc
    .font('Helvetica')
    .fontSize(11)
    .fillColor('#FFFFFF')
    .text('Partner Invoice', 0, 30, {
      width: doc.page.width - 56,
      align: 'right',
    });
  doc.fillColor(TEXT_MUTED).moveDown(2);

  const yMeta = 90;
  doc.font('Helvetica').fontSize(10).fillColor(TEXT_MUTED);
  doc.text(`Issued: ${formatDate(args.paidAt)}`, 56, yMeta, {
    width: doc.page.width - 112,
    align: 'right',
  });
  doc.text(`Invoice #${args.invoiceNumber}`, 56, yMeta + 14, {
    width: doc.page.width - 112,
    align: 'right',
  });
  doc.text(`Week of ${formatIsoDate(args.weekOf)}`, 56, yMeta + 28, {
    width: doc.page.width - 112,
    align: 'right',
  });
}

function renderBillingBlock(
  doc: PDFKit.PDFDocument,
  args: PartnerInvoiceArgs,
): void {
  const startY = 150;
  doc
    .font('Helvetica-Bold')
    .fontSize(11)
    .fillColor(BRAND_NAVY)
    .text('Paid to', 56, startY);
  doc
    .font('Helvetica')
    .fontSize(11)
    .fillColor('#1A1A2E')
    .text(args.partnerName, 56, startY + 16)
    .text(args.partnerEmail, 56, startY + 30);

  const rightX = 320;
  doc
    .font('Helvetica-Bold')
    .fontSize(11)
    .fillColor(BRAND_NAVY)
    .text('MoMo transfer', rightX, startY);
  doc.font('Helvetica').fontSize(11).fillColor('#1A1A2E');
  doc.text(`${args.momoProvider} · ${args.momoNumber}`, rightX, startY + 16);
  doc.text(`Reference: ${args.momoReference}`, rightX, startY + 30);

  const ruleY = startY + 62;
  doc
    .strokeColor(RULE)
    .lineWidth(1)
    .moveTo(56, ruleY)
    .lineTo(doc.page.width - 56, ruleY)
    .stroke();
}

function renderLineItems(
  doc: PDFKit.PDFDocument,
  args: PartnerInvoiceArgs,
): number {
  const startY = 230;
  doc.font('Helvetica-Bold').fontSize(10).fillColor(TEXT_MUTED);
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
  doc.font('Helvetica').fontSize(11).fillColor('#1A1A2E');
  for (const line of args.lines) {
    // Page-break guard: leave 100pt of margin for the total block.
    if (y > doc.page.height - 180) {
      doc.addPage();
      y = 56;
    }
    doc.text(line.description, 56, y, { width: 380 });
    doc.text(`${args.currency} ${line.amountGhs}`, 56, y, {
      width: doc.page.width - 112,
      align: 'right',
    });
    if (line.earnedAt) {
      doc
        .fillColor(TEXT_MUTED)
        .fontSize(9)
        .text(formatIsoDate(line.earnedAt), 56, y + 14);
      doc.fillColor('#1A1A2E').fontSize(11);
      y += 30;
    } else {
      y += 20;
    }
  }
  return y;
}

function renderTotal(
  doc: PDFKit.PDFDocument,
  args: PartnerInvoiceArgs,
  linesEndY: number,
): void {
  const y = Math.max(linesEndY + 12, 320);
  doc
    .strokeColor(RULE)
    .lineWidth(1)
    .moveTo(320, y)
    .lineTo(doc.page.width - 56, y)
    .stroke();

  doc
    .font('Helvetica-Bold')
    .fontSize(13)
    .fillColor(BRAND_NAVY)
    .text('Total paid', 56, y + 12);
  doc
    .fillColor(BRAND_ORANGE)
    .text(`${args.currency} ${args.totalAmount}`, 56, y + 12, {
      width: doc.page.width - 112,
      align: 'right',
    });
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
    .text('Thank you for partnering with Bondzi.', 56, y + 14)
    .text('Bondzi · bondzi.app · support@bondzi.app', 56, y + 30);
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function formatIsoDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return formatDate(d);
}
