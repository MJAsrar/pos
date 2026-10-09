import type { Paisa } from '../money.js';
import type { Permission, Role } from '../permissions.js';

/** ISO-8601 UTC timestamp, e.g. `2026-09-20T14:03:11.204Z`. */
export type Timestamp = string;
/** Calendar date in the shop's local timezone, `YYYY-MM-DD`. */
export type LocalDate = string;

/** Columns every synced table carries. Stage 1 writes them and ignores the rest. */
export interface SyncFields {
  createdAt: Timestamp;
  updatedAt: Timestamp;
  deletedAt: Timestamp | null;
}

export type Unit = 'pcs' | 'mtr' | 'ft' | 'kg' | 'box' | 'set' | 'pkt' | 'pair';

export const UNITS: readonly Unit[] = ['pcs', 'mtr', 'ft', 'kg', 'box', 'set', 'pkt', 'pair'];

export const UNIT_LABELS: Record<Unit, string> = {
  pcs: 'Pieces',
  mtr: 'Metres',
  ft: 'Feet',
  kg: 'Kilograms',
  box: 'Boxes',
  set: 'Sets',
  pkt: 'Packets',
  pair: 'Pairs',
};

/** Units that can be sold in fractions. Pieces cannot; wire can. */
export function allowsFractionalQty(unit: Unit): boolean {
  return unit === 'mtr' || unit === 'ft' || unit === 'kg';
}

export type PaymentMethod = 'cash' | 'wallet' | 'bank' | 'credit';

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash',
  wallet: 'Easypaisa / JazzCash',
  bank: 'Bank transfer',
  credit: 'Credit (udhaar)',
};

/** Methods that can actually receive money. `credit` is the absence of payment. */
export type SettledMethod = Exclude<PaymentMethod, 'credit'>;

export interface User extends SyncFields {
  id: string;
  username: string;
  fullName: string;
  role: Role;
  permissions: Permission[];
  isActive: boolean;
}

export interface Category extends SyncFields {
  id: string;
  name: string;
  sortOrder: number;
}

export interface Item extends SyncFields {
  id: string;
  code: string;
  name: string;
  categoryId: string | null;
  unit: Unit;
  /** Only present for users holding `item.view_cost`. */
  costPrice: Paisa | null;
  salePrice: Paisa;
  /** Floor for bargaining. Null means no floor. */
  minPrice: Paisa | null;
  qtyOnHand: number;
  lowStockLevel: number;
  photoPath: string | null;
  isActive: boolean;
}

export interface Customer extends SyncFields {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
  openingBalance: Paisa;
  /** Cached sum of the ledger. Positive means the customer owes the shop. */
  balance: Paisa;
  isActive: boolean;
}

export type SaleStatus = 'active' | 'voided';

export interface SaleLine {
  id: string;
  saleId: string;
  itemId: string;
  /** Snapshot: the item may be renamed later, old bills must not change. */
  itemName: string;
  itemCode: string;
  unit: Unit;
  qty: number;
  unitPrice: Paisa;
  /** Snapshot of cost at the moment of sale, so historical profit stays correct. */
  costPrice: Paisa;
  lineTotal: Paisa;
  lineNo: number;
}

export interface Sale extends SyncFields {
  id: string;
  invoiceNo: string;
  customerId: string | null;
  customerName: string | null;
  userId: string;
  userName: string;
  soldAt: Timestamp;
  subtotal: Paisa;
  discount: Paisa;
  rounding: Paisa;
  total: Paisa;
  /** Amount actually received. `total - paid` went onto the customer's udhaar. */
  paid: Paisa;
  paymentMethod: PaymentMethod;
  /** Total cost of goods on this bill, frozen at sale time. */
  costTotal: Paisa;
  status: SaleStatus;
  note: string | null;
  lines: SaleLine[];
}

export type RefundMethod = SettledMethod | 'credit_note';

export interface SaleReturnLine {
  id: string;
  returnId: string;
  saleLineId: string;
  itemId: string;
  itemName: string;
  qty: number;
  unitPrice: Paisa;
  costPrice: Paisa;
  lineTotal: Paisa;
}

export interface SaleReturn extends SyncFields {
  id: string;
  returnNo: string;
  saleId: string;
  invoiceNo: string;
  customerId: string | null;
  userId: string;
  returnedAt: Timestamp;
  total: Paisa;
  refundMethod: RefundMethod;
  reason: string | null;
  lines: SaleReturnLine[];
}

export type StockMovementType = 'opening' | 'stock_in' | 'sale' | 'return' | 'adjustment';

export type AdjustmentReason = 'damaged' | 'lost' | 'correction' | 'other';

export const ADJUSTMENT_REASON_LABELS: Record<AdjustmentReason, string> = {
  damaged: 'Damaged',
  lost: 'Lost / stolen',
  correction: 'Stock count correction',
  other: 'Other',
};

export interface StockMovement {
  id: string;
  itemId: string;
  itemName: string;
  type: StockMovementType;
  /** Signed. Stock is the running sum of these, never an absolute value. */
  qtyDelta: number;
  qtyAfter: number;
  unitCost: Paisa | null;
  supplierName: string | null;
  reason: string | null;
  refType: string | null;
  refId: string | null;
  userId: string;
  userName: string;
  createdAt: Timestamp;
}

export type LedgerEntryType =
  | 'opening'
  | 'credit_sale'
  | 'payment'
  | 'return_credit'
  | 'adjustment';

export const LEDGER_ENTRY_LABELS: Record<LedgerEntryType, string> = {
  opening: 'Opening balance',
  credit_sale: 'Credit sale',
  payment: 'Payment received',
  return_credit: 'Return credit',
  adjustment: 'Adjustment',
};

export interface LedgerEntry {
  id: string;
  customerId: string;
  type: LedgerEntryType;
  /** Signed: positive increases what the customer owes, negative reduces it. */
  amount: Paisa;
  balanceAfter: Paisa;
  refType: string | null;
  refId: string | null;
  /** Invoice number when this entry came from a bill. */
  refLabel: string | null;
  note: string | null;
  userId: string;
  userName: string;
  entryDate: Timestamp;
  createdAt: Timestamp;
}

export interface CustomerPayment extends SyncFields {
  id: string;
  customerId: string;
  amount: Paisa;
  method: SettledMethod;
  receivedAt: Timestamp;
  userId: string;
  note: string | null;
}

export interface Expense extends SyncFields {
  id: string;
  category: string;
  description: string | null;
  amount: Paisa;
  spentAt: LocalDate;
  userId: string;
  userName: string;
}

export interface AuditLogEntry {
  id: string;
  userId: string;
  userName: string;
  action: string;
  entity: string;
  entityId: string;
  summary: string;
  beforeJson: string | null;
  afterJson: string | null;
  createdAt: Timestamp;
}

export interface HeldSale {
  id: string;
  label: string;
  userId: string;
  payloadJson: string;
  createdAt: Timestamp;
}

export interface ShopSettings {
  shopName: string;
  addressLine1: string;
  addressLine2: string;
  phone: string;
  logoPath: string | null;
  invoicePrefix: string;
  /** Block selling below `minPrice` instead of only warning. */
  enforceMinPrice: boolean;
  /** Block selling an item that would take stock negative. */
  blockNegativeStock: boolean;
  footerNote: string;
}

export const DEFAULT_SETTINGS: ShopSettings = {
  shopName: 'Al Hamza Electronics - Dina',
  addressLine1: '',
  addressLine2: '',
  phone: '',
  logoPath: null,
  invoicePrefix: 'AH',
  enforceMinPrice: true,
  blockNegativeStock: false,
  footerNote: 'Thank you for your business.',
};
