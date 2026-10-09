/**
 * Money handling for the POS.
 *
 * EVERY monetary amount in this system is an integer number of paisa.
 * 1 rupee = 100 paisa, so Rs 50.00 is stored as 5000.
 *
 * Floats are never used for money. A cent of drift per line silently becomes
 * a wrong customer balance after a few thousand bills, and a customer ledger
 * that does not reconcile is worse than no ledger at all.
 */

/** A monetary amount in paisa. Always an integer. */
export type Paisa = number;

export const PAISA_PER_RUPEE = 100;

/**
 * Round half away from zero.
 *
 * `Math.round` rounds -0.5 to -0 (towards +Infinity), which makes refunds and
 * reversing entries round differently from the sales they reverse. This does not.
 */
export function roundHalfUp(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/** Convert rupees (as typed by a human) to paisa. */
export function rupeesToPaisa(rupees: number): Paisa {
  return roundHalfUp(rupees * PAISA_PER_RUPEE);
}

/** Convert paisa to rupees. For display and export only — never for arithmetic. */
export function paisaToRupees(paisa: Paisa): number {
  return paisa / PAISA_PER_RUPEE;
}

/** True if the value is a safe integer amount of paisa. */
export function isValidPaisa(value: unknown): value is Paisa {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/**
 * Assert a value is usable as money, with a useful message if it is not.
 * Used at the service boundary so a bad amount never reaches the database.
 */
export function assertPaisa(value: unknown, label = 'amount'): Paisa {
  if (!isValidPaisa(value)) {
    throw new Error(`${label} must be an integer number of paisa, got: ${String(value)}`);
  }
  return value;
}

/**
 * Line total for `qty` units at `unitPrice` paisa each.
 *
 * Quantity is a float because wire and cable are sold by the metre, so the
 * product must be rounded back to whole paisa here rather than at the bill total.
 */
export function lineTotal(qty: number, unitPrice: Paisa): Paisa {
  if (!Number.isFinite(qty)) throw new Error(`quantity must be a finite number, got: ${qty}`);
  assertPaisa(unitPrice, 'unit price');
  return roundHalfUp(qty * unitPrice);
}

/** Sum a list of paisa amounts. */
export function sumPaisa(amounts: readonly Paisa[]): Paisa {
  let total = 0;
  for (const amount of amounts) total += amount;
  return total;
}

/**
 * Round an amount to the nearest whole rupee.
 *
 * Paisa coins do not circulate in Pakistan, so a bill total of Rs 1,249.60 is
 * meaningless at the counter. Bill totals are rounded to the rupee and the
 * difference is recorded separately so reports still reconcile exactly.
 */
export function roundToRupee(paisa: Paisa): Paisa {
  return roundHalfUp(paisa / PAISA_PER_RUPEE) * PAISA_PER_RUPEE;
}

/** The rounding adjustment applied to reach `roundToRupee(paisa)`. */
export function roundingDelta(paisa: Paisa): Paisa {
  return roundToRupee(paisa) - paisa;
}

/**
 * Format paisa for display, e.g. `Rs 1,250` or `Rs 1,250.50`.
 *
 * Paisa are shown only when non-zero, because after rounding they normally are.
 */
export function formatPKR(paisa: Paisa, options: { symbol?: boolean } = {}): string {
  const { symbol = true } = options;
  const negative = paisa < 0;
  const abs = Math.abs(paisa);
  const rupees = Math.floor(abs / PAISA_PER_RUPEE);
  const remainder = abs % PAISA_PER_RUPEE;

  let text = groupDigits(rupees);
  if (remainder !== 0) text += '.' + String(remainder).padStart(2, '0');
  if (symbol) text = 'Rs ' + text;
  return negative ? '-' + text : text;
}

/** Format without the currency symbol — for table columns and CSV export. */
export function formatAmount(paisa: Paisa): string {
  return formatPKR(paisa, { symbol: false });
}

function groupDigits(value: number): string {
  // Plain thousands grouping. Intl with en-PK gives lakh/crore grouping on some
  // platforms and plain grouping on others; shop bills need one predictable format.
  const digits = String(value);
  if (digits.length <= 3) return digits;
  const head = digits.length % 3 || 3;
  const parts = [digits.slice(0, head)];
  for (let i = head; i < digits.length; i += 3) parts.push(digits.slice(i, i + 3));
  return parts.join(',');
}

/**
 * Parse what a cashier typed into paisa. Returns null if it is not a number.
 *
 * Accepts `1250`, `1,250`, `1250.50`, `Rs 1250`, ` 1250 `. Rejects everything else
 * rather than guessing, so a typo becomes a visible error instead of a wrong bill.
 */
export function parseMoneyInput(input: string): Paisa | null {
  const cleaned = input.trim().replace(/^rs\.?\s*/i, '').replace(/,/g, '').replace(/\s+/g, '');
  if (cleaned === '' || cleaned === '-') return null;
  if (!/^-?\d*\.?\d*$/.test(cleaned)) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  const paisa = rupeesToPaisa(value);
  return Number.isSafeInteger(paisa) ? paisa : null;
}

/** Parse a typed quantity. Returns null if invalid or non-positive. */
export function parseQtyInput(input: string): number | null {
  const cleaned = input.trim().replace(/,/g, '');
  if (cleaned === '') return null;
  if (!/^\d*\.?\d*$/.test(cleaned)) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value <= 0) return null;
  // Three decimal places is enough for metres and kilograms, and keeps
  // qty * price from accumulating binary-float noise.
  return Math.round(value * 1000) / 1000;
}

/** Format a quantity, trimming trailing zeros: 2 -> "2", 2.5 -> "2.5". */
export function formatQty(qty: number): string {
  return String(Math.round(qty * 1000) / 1000);
}
