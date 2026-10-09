import { BrowserWindow, shell } from 'electron';
import type BetterSqlite3 from 'better-sqlite3';
import { readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import {
  LEDGER_ENTRY_LABELS,
  PAYMENT_METHOD_LABELS,
  formatDate,
  formatDateTime,
  formatPKR,
  formatQty,
} from '@pos/shared';
import { AppError } from '../errors.js';
import { receiptsDir } from '../paths.js';
import { findCustomerById } from '../db/repos/customerRepo.js';
import { findSaleById } from '../db/repos/saleRepo.js';
import { customerLedger } from './customerService.js';
import { getSettings } from './settingsService.js';

/**
 * Soft receipts.
 *
 * The shop has no printer, so a bill is a PDF the owner attaches in WhatsApp.
 * It is rendered by loading a small HTML document into an offscreen window and
 * asking Chromium to print it — the same engine the app already ships, so there
 * is no PDF library to keep up to date and the layout is plain CSS.
 *
 * A5 width, because these go to other businesses as much as to walk-in
 * customers, and an invoice that looks like an invoice gets paid.
 */

export interface PdfResult {
  path: string;
  fileName: string;
}

/**
 * The receipt as HTML, before it becomes a PDF.
 *
 * Exported so the layout can be checked in a browser during development; the
 * PDF path uses the very same string.
 */
export async function saleReceiptHtml(
  db: BetterSqlite3.Database,
  saleId: string,
): Promise<string> {
  return document(await saleReceiptBody(db, saleId));
}

export async function renderSaleReceipt(
  db: BetterSqlite3.Database,
  saleId: string,
): Promise<PdfResult> {
  return print(await saleReceiptBody(db, saleId), `${saleInvoiceNo(db, saleId)}.pdf`);
}

function saleInvoiceNo(db: BetterSqlite3.Database, saleId: string): string {
  const sale = findSaleById(db, saleId);
  if (!sale) throw new AppError('not_found', 'That bill no longer exists.');
  return sale.invoiceNo;
}

async function saleReceiptBody(db: BetterSqlite3.Database, saleId: string): Promise<string> {
  const sale = findSaleById(db, saleId);
  if (!sale) throw new AppError('not_found', 'That bill no longer exists.');

  const settings = getSettings(db);
  const customer = sale.customerId ? findCustomerById(db, sale.customerId) : null;

  const rows = sale.lines
    .map(
      (line, index) => `
        <tr>
          <td class="num">${index + 1}</td>
          <td>${escapeHtml(line.itemName)}<span class="code">${escapeHtml(line.itemCode)}</span></td>
          <td class="num">${formatQty(line.qty)} ${escapeHtml(line.unit)}</td>
          <td class="num">${formatPKR(line.unitPrice)}</td>
          <td class="num money">${formatPKR(line.lineTotal)}</td>
        </tr>`,
    )
    .join('');

  const totals = [
    ['Subtotal', formatPKR(sale.subtotal), false],
    ...(sale.discount > 0 ? [['Discount', `-${formatPKR(sale.discount)}`, false]] : []),
    ...(sale.rounding !== 0
      ? [['Rounding', `${sale.rounding > 0 ? '+' : ''}${formatPKR(sale.rounding)}`, false]]
      : []),
    ['Total', formatPKR(sale.total), true],
    ['Paid', formatPKR(sale.paid), false],
    ...(sale.credit > 0 ? [['Remaining (udhaar)', formatPKR(sale.credit), false]] : []),
  ] as Array<[string, string, boolean]>;

  const body = `
    ${header(settings)}

    <section class="meta">
      <div>
        <span class="label">Bill</span>
        <span class="value strong">${escapeHtml(sale.invoiceNo)}</span>
      </div>
      <div>
        <span class="label">Date</span>
        <span class="value">${escapeHtml(formatDateTime(sale.soldAt))}</span>
      </div>
      <div>
        <span class="label">Customer</span>
        <span class="value">${escapeHtml(customer?.name ?? 'Walk-in')}</span>
      </div>
      <div>
        <span class="label">Paid by</span>
        <span class="value">${escapeHtml(PAYMENT_METHOD_LABELS[sale.paymentMethod])}</span>
      </div>
    </section>

    ${sale.status === 'voided' ? '<p class="voided">This bill was cancelled.</p>' : ''}

    <table class="lines">
      <colgroup>
        <col style="width: 7%" />
        <col />
        <col style="width: 17%" />
        <col style="width: 19%" />
        <col style="width: 22%" />
      </colgroup>
      <thead>
        <tr>
          <th class="num">#</th>
          <th>Item</th>
          <th class="num">Qty</th>
          <th class="num">Rate</th>
          <th class="num">Amount</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <table class="totals">
      ${totals
        .map(
          ([label, value, strong]) => `
            <tr class="${strong ? 'grand' : ''}">
              <td>${escapeHtml(label)}</td>
              <td class="num money">${escapeHtml(value)}</td>
            </tr>`,
        )
        .join('')}
    </table>

    ${
      customer && customer.balance > 0
        ? `<p class="balance">Total outstanding for ${escapeHtml(customer.name)}: <strong>${formatPKR(customer.balance)}</strong></p>`
        : ''
    }

    ${settings.footerNote ? `<p class="footer">${escapeHtml(settings.footerNote)}</p>` : ''}
  `;

  return body;
}

export async function renderCustomerStatement(
  db: BetterSqlite3.Database,
  customerId: string,
): Promise<PdfResult> {
  const customer = findCustomerById(db, customerId);
  if (!customer) throw new AppError('not_found', 'That customer no longer exists.');

  const settings = getSettings(db);
  const entries = customerLedger(db, customerId);

  const rows = entries
    .map(
      (entry) => `
        <tr>
          <td>${escapeHtml(formatDate(entry.entryDate))}</td>
          <td>${escapeHtml(LEDGER_ENTRY_LABELS[entry.type])}${
            entry.refLabel ? `<span class="code">${escapeHtml(entry.refLabel)}</span>` : ''
          }</td>
          <td class="num">${entry.amount > 0 ? formatPKR(entry.amount) : ''}</td>
          <td class="num">${entry.amount < 0 ? formatPKR(-entry.amount) : ''}</td>
          <td class="num money">${formatPKR(entry.balanceAfter)}</td>
        </tr>`,
    )
    .join('');

  const body = `
    ${header(settings)}

    <section class="meta">
      <div>
        <span class="label">Statement for</span>
        <span class="value strong">${escapeHtml(customer.name)}</span>
      </div>
      ${customer.phone ? `<div><span class="label">Phone</span><span class="value">${escapeHtml(customer.phone)}</span></div>` : ''}
      <div>
        <span class="label">As at</span>
        <span class="value">${escapeHtml(formatDate(new Date()))}</span>
      </div>
    </section>

    <table class="lines">
      <colgroup>
        <col style="width: 20%" />
        <col />
        <col style="width: 18%" />
        <col style="width: 18%" />
        <col style="width: 20%" />
      </colgroup>
      <thead>
        <tr>
          <th>Date</th>
          <th>Details</th>
          <th class="num">Charged</th>
          <th class="num">Paid</th>
          <th class="num">Balance</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <p class="balance">
      ${
        customer.balance > 0
          ? `Amount due: <strong>${formatPKR(customer.balance)}</strong>`
          : customer.balance < 0
            ? `Paid in advance: <strong>${formatPKR(-customer.balance)}</strong>`
            : 'Account is clear.'
      }
    </p>

    ${settings.footerNote ? `<p class="footer">${escapeHtml(settings.footerNote)}</p>` : ''}
  `;

  return print(body, `statement-${slug(customer.name)}.pdf`);
}

function header(settings: ReturnType<typeof getSettings>): string {
  const address = [settings.addressLine1, settings.addressLine2].filter(Boolean).join(', ');
  return `
    <header>
      ${settings.logoPath ? `<img class="logo" src="${embedImage(settings.logoPath)}" alt="" />` : ''}
      <h1>${escapeHtml(settings.shopName)}</h1>
      ${address ? `<p>${escapeHtml(address)}</p>` : ''}
      ${settings.phone ? `<p>${escapeHtml(settings.phone)}</p>` : ''}
    </header>`;
}

/**
 * Render HTML to a PDF through an offscreen window.
 *
 * The window never shows and is always destroyed, including when printing
 * throws — a leaked hidden window keeps the whole app alive after the counter
 * closes it.
 */
async function print(body: string, fileName: string): Promise<PdfResult> {
  const html = document(body);
  const window = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, javascript: false, sandbox: true },
  });

  try {
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const pdf = await window.webContents.printToPDF({
      pageSize: 'A5',
      printBackground: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    });

    const path = join(receiptsDir(), fileName);
    writeFileSync(path, pdf);
    return { path, fileName };
  } finally {
    window.destroy();
  }
}

/** Open a rendered PDF in whatever the machine uses for PDFs. */
export async function openPdf(path: string): Promise<void> {
  const problem = await shell.openPath(path);
  if (problem) {
    throw new AppError(
      'open_failed',
      `The receipt was saved but could not be opened: ${problem}. It is in the receipts folder.`,
    );
  }
}

function document(body: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  @page { size: A5; margin: 12mm 10mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: 'Segoe UI', system-ui, sans-serif;
    font-size: 10pt;
    line-height: 1.4;
    color: #14201a;
  }
  header { text-align: center; border-bottom: 2px solid #14201a; padding-bottom: 8px; }
  header .logo { max-height: 56px; max-width: 200px; margin-bottom: 6px; }
  header h1 { margin: 0; font-size: 15pt; letter-spacing: -0.01em; }
  header p { margin: 1px 0 0; font-size: 8.5pt; color: #5d6b63; }

  .meta { display: flex; flex-wrap: wrap; gap: 4px 22px; margin: 10px 0 12px; }
  .meta .label { display: block; font-size: 7.5pt; color: #5d6b63; }
  .meta .value { font-size: 9.5pt; font-variant-numeric: tabular-nums; }
  .meta .strong { font-weight: 600; }

  .voided {
    margin: 0 0 10px; padding: 5px 8px; border: 1px solid #a81e17;
    color: #a81e17; font-size: 9pt; text-align: center;
  }

  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  .lines td:first-child, .lines th:first-child { padding-right: 6px; }
  .lines td:nth-child(2) { word-wrap: break-word; }
  .lines th {
    text-align: left; font-size: 8pt; font-weight: 600; color: #5d6b63;
    border-bottom: 1px solid #14201a; padding-bottom: 4px;
  }
  .lines td { padding: 4px 0; border-bottom: 1px solid #dbe2dc; vertical-align: top; }
  .lines .code { display: block; font-size: 7.5pt; color: #8a958f; font-variant-numeric: tabular-nums; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .lines th.num, .lines td.num { padding-left: 8px; }
  .money { font-weight: 500; }

  .totals { width: 58%; margin-left: auto; margin-top: 10px; }
  .totals td { padding: 2px 0; font-size: 9.5pt; }
  .totals td:first-child { color: #5d6b63; }
  .totals .grand td {
    border-top: 1px solid #14201a; padding-top: 5px;
    font-size: 12pt; font-weight: 600; color: #14201a;
  }

  .balance {
    margin-top: 14px; padding: 7px 9px; background: #fbeceb;
    border-left: 3px solid #a81e17; font-size: 9.5pt;
  }
  .footer {
    margin-top: 16px; padding-top: 8px; border-top: 1px solid #dbe2dc;
    font-size: 8.5pt; color: #5d6b63; text-align: center;
  }
</style></head><body>${body}</body></html>`;
}

function embedImage(path: string): string {
  try {
    const extension = extname(path).toLowerCase().replace('.', '') || 'png';
    const type = extension === 'jpg' ? 'jpeg' : extension;
    return `data:image/${type};base64,${readFileSync(path).toString('base64')}`;
  } catch {
    // A missing logo must not stop a customer getting their bill.
    return '';
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'customer';
}
