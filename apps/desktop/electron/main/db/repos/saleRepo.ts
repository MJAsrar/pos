import type BetterSqlite3 from 'better-sqlite3';
import type { PaymentMethod, SaleStatus, Unit } from '@pos/shared';

export interface SaleLineRecord {
  id: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  unit: Unit;
  qty: number;
  unitPrice: number;
  costPrice: number;
  lineTotal: number;
  lineNo: number;
  /** How many of this line have already been returned. */
  returnedQty: number;
}

export interface SaleRecord {
  id: string;
  invoiceNo: string;
  customerId: string | null;
  customerName: string | null;
  userId: string;
  userName: string;
  soldAt: string;
  subtotal: number;
  discount: number;
  rounding: number;
  total: number;
  paid: number;
  paymentMethod: PaymentMethod;
  costTotal: number;
  status: SaleStatus;
  note: string | null;
  /** Amount that went onto the customer's udhaar. */
  credit: number;
  /** Total value returned against this bill so far. */
  returnedTotal: number;
  lines: SaleLineRecord[];
}

export type SaleSummary = Omit<SaleRecord, 'lines'> & { lineCount: number };

const SALE_SELECT = `
  SELECT s.*,
         COALESCE(c.name, '') AS customer_name,
         COALESCE(u.full_name, 'Deleted user') AS user_name,
         (SELECT COUNT(*) FROM sale_items li WHERE li.sale_id = s.id) AS line_count,
         (SELECT COALESCE(SUM(r.total), 0) FROM sale_returns r
           WHERE r.sale_id = s.id AND r.deleted_at IS NULL) AS returned_total
    FROM sales s
    LEFT JOIN customers c ON c.id = s.customer_id
    LEFT JOIN users u ON u.id = s.user_id
   WHERE s.deleted_at IS NULL`;

interface SaleRow {
  id: string;
  invoice_no: string;
  customer_id: string | null;
  customer_name: string;
  user_id: string;
  user_name: string;
  sold_at: string;
  subtotal: number;
  discount: number;
  rounding: number;
  total: number;
  paid: number;
  payment_method: PaymentMethod;
  cost_total: number;
  status: SaleStatus;
  note: string | null;
  line_count: number;
  returned_total: number;
}

function mapSale(row: SaleRow): SaleSummary {
  return {
    id: row.id,
    invoiceNo: row.invoice_no,
    customerId: row.customer_id,
    customerName: row.customer_name || null,
    userId: row.user_id,
    userName: row.user_name,
    soldAt: row.sold_at,
    subtotal: row.subtotal,
    discount: row.discount,
    rounding: row.rounding,
    total: row.total,
    paid: row.paid,
    paymentMethod: row.payment_method,
    costTotal: row.cost_total,
    status: row.status,
    note: row.note,
    credit: row.total - row.paid,
    returnedTotal: row.returned_total,
    lineCount: row.line_count,
  };
}

export function findSaleById(db: BetterSqlite3.Database, id: string): SaleRecord | null {
  const row = db.prepare(`${SALE_SELECT} AND s.id = ?`).get(id) as SaleRow | undefined;
  if (!row) return null;
  const { lineCount: _ignored, ...sale } = mapSale(row);
  return { ...sale, lines: saleLines(db, id) };
}

export function findSaleByInvoiceNo(
  db: BetterSqlite3.Database,
  invoiceNo: string,
): SaleRecord | null {
  const row = db.prepare(`${SALE_SELECT} AND s.invoice_no = ? COLLATE NOCASE`).get(invoiceNo) as
    | SaleRow
    | undefined;
  return row ? findSaleById(db, row.id) : null;
}

export function saleLines(db: BetterSqlite3.Database, saleId: string): SaleLineRecord[] {
  const rows = db
    .prepare(
      `SELECT li.*,
              (SELECT COALESCE(SUM(ri.qty), 0)
                 FROM sale_return_items ri
                 JOIN sale_returns r ON r.id = ri.return_id AND r.deleted_at IS NULL
                WHERE ri.sale_item_id = li.id) AS returned_qty
         FROM sale_items li
        WHERE li.sale_id = ?
        ORDER BY li.line_no`,
    )
    .all(saleId) as Array<{
    id: string;
    item_id: string;
    item_code: string;
    item_name: string;
    unit: Unit;
    qty: number;
    unit_price: number;
    cost_price: number;
    line_total: number;
    line_no: number;
    returned_qty: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    itemId: row.item_id,
    itemCode: row.item_code,
    itemName: row.item_name,
    unit: row.unit,
    qty: row.qty,
    unitPrice: row.unit_price,
    costPrice: row.cost_price,
    lineTotal: row.line_total,
    lineNo: row.line_no,
    returnedQty: row.returned_qty,
  }));
}

export interface ListSalesOptions {
  /** Inclusive local date range, already converted to UTC timestamps. */
  start?: string;
  end?: string;
  customerId?: string;
  userId?: string;
  status?: SaleStatus;
  paymentMethod?: PaymentMethod;
  /** Matches an invoice number or customer name. */
  search?: string;
  /** Only bills with an amount still on udhaar. */
  creditOnly?: boolean;
  limit?: number;
  offset?: number;
}

export function listSales(db: BetterSqlite3.Database, options: ListSalesOptions = {}): SaleSummary[] {
  const where: string[] = [];
  const params: unknown[] = [];

  if (options.start) {
    where.push('s.sold_at >= ?');
    params.push(options.start);
  }
  if (options.end) {
    where.push('s.sold_at < ?');
    params.push(options.end);
  }
  if (options.customerId) {
    where.push('s.customer_id = ?');
    params.push(options.customerId);
  }
  if (options.userId) {
    where.push('s.user_id = ?');
    params.push(options.userId);
  }
  if (options.status) {
    where.push('s.status = ?');
    params.push(options.status);
  }
  if (options.paymentMethod) {
    where.push('s.payment_method = ?');
    params.push(options.paymentMethod);
  }
  if (options.creditOnly) {
    where.push('s.total > s.paid AND s.status = \'active\'');
  }
  if (options.search?.trim()) {
    where.push('(s.invoice_no LIKE ? COLLATE NOCASE OR c.name LIKE ? COLLATE NOCASE)');
    const pattern = `%${options.search.trim()}%`;
    params.push(pattern, pattern);
  }

  const clause = where.length ? ` AND ${where.join(' AND ')}` : '';
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);
  const offset = Math.max(options.offset ?? 0, 0);

  const rows = db
    .prepare(`${SALE_SELECT}${clause} ORDER BY s.sold_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as SaleRow[];

  return rows.map(mapSale);
}

/** The last few bills, for the "recent" list on the billing screen. */
export function recentSales(db: BetterSqlite3.Database, limit = 8): SaleSummary[] {
  return listSales(db, { limit });
}
