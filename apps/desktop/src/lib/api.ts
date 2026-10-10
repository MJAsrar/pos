/**
 * The renderer's view of the main process.
 *
 * Everything the UI knows about the shop comes through here. There is no
 * database client in the browser context — `window.pos.call` is the only door,
 * and it returns a result envelope rather than throwing, so this module is where
 * a failure becomes a normal error the UI can catch and show.
 */

import type {
  AdjustmentReason,
  LedgerEntryType,
  PaymentMethod,
  Permission,
  RefundMethod,
  Role,
  SaleStatus,
  SettledMethod,
  ShopSettings,
  StockMovementType,
  Unit,
} from '@pos/shared';

export interface OpError {
  code: string;
  message: string;
  fields?: Record<string, string>;
}

type OpResult<T> = { ok: true; data: T } | { ok: false; error: OpError };

interface PosBridge {
  call(op: string, payload?: unknown): Promise<OpResult<unknown>>;
}

declare global {
  interface Window {
    pos: PosBridge;
  }
}

/** An error the main process reported, carrying a code the UI can branch on. */
export class ApiError extends Error {
  readonly code: string;
  readonly fields: Record<string, string>;

  constructor(error: OpError) {
    super(error.message);
    this.name = 'ApiError';
    this.code = error.code;
    this.fields = error.fields ?? {};
  }

  get isAuthProblem(): boolean {
    return this.code === 'auth_required';
  }
}

export async function call<T>(op: string, payload?: unknown): Promise<T> {
  if (!window.pos) {
    throw new ApiError({
      code: 'no_bridge',
      message: 'The application did not start correctly. Close and reopen Al Hamza POS.',
    });
  }

  const result = (await window.pos.call(op, payload)) as OpResult<T>;
  if (!result || typeof result !== 'object' || !('ok' in result)) {
    throw new ApiError({ code: 'internal', message: 'The application gave an unexpected reply.' });
  }
  if (!result.ok) throw new ApiError(result.error);
  return result.data;
}

// --- Shapes ----------------------------------------------------------------

export interface SessionUser {
  id: string;
  username: string;
  fullName: string;
  role: Role;
  permissions: Permission[];
  isActive: boolean;
}

export interface Session {
  user: SessionUser;
  since: string | null;
}

export interface UpdateState {
  checking: boolean;
  available: boolean;
  downloaded: boolean;
  version: string | null;
  error: string | null;
  lastCheckedAt: string | null;
}

export interface AppStatus {
  version: string;
  update: UpdateState;
  needsSetup: boolean;
  shopName: string;
  signedIn: Session | null;
}

export interface LoginOption {
  id: string;
  fullName: string;
  username: string;
  role: Role;
  lockedUntil: string | null;
}

export interface Item {
  id: string;
  code: string;
  name: string;
  categoryId: string | null;
  categoryName: string | null;
  unit: Unit;
  /** Null when the signed-in user may not see cost. */
  costPrice: number | null;
  salePrice: number;
  minPrice: number | null;
  qtyOnHand: number;
  lowStockLevel: number;
  photoPath: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Category {
  id: string;
  name: string;
  sortOrder: number;
  itemCount: number;
}

export interface Customer {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
  openingBalance: number;
  balance: number;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LedgerEntry {
  id: string;
  type: LedgerEntryType;
  amount: number;
  balanceAfter: number;
  refType: string | null;
  refId: string | null;
  refLabel: string | null;
  note: string | null;
  userName: string;
  entryDate: string;
  createdAt: string;
}

export interface SaleLine {
  id: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  unit: Unit;
  qty: number;
  unitPrice: number;
  costPrice: number | null;
  lineTotal: number;
  lineNo: number;
  returnedQty: number;
}

export interface Sale {
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
  costTotal: number | null;
  profit: number | null;
  status: SaleStatus;
  note: string | null;
  credit: number;
  returnedTotal: number;
  lines: SaleLine[];
}

export type SaleSummary = Omit<Sale, 'lines'> & { lineCount: number };

export interface SaleReturn {
  id: string;
  returnNo: string;
  saleId: string;
  invoiceNo: string;
  total: number;
  refundMethod: RefundMethod;
  reason: string | null;
  returnedAt: string;
  userName: string;
  lines: Array<{ id: string; itemId: string; itemName: string; qty: number; unitPrice: number; lineTotal: number }>;
}

export interface StockMovement {
  id: string;
  type: StockMovementType;
  qtyDelta: number;
  qtyAfter: number;
  unitCost: number | null;
  supplierName: string | null;
  reason: string | null;
  refType: string | null;
  refId: string | null;
  refLabel: string | null;
  userName: string;
  createdAt: string;
}

export interface Expense {
  id: string;
  category: string;
  description: string | null;
  amount: number;
  spentAt: string;
  userId: string;
  userName: string;
  createdAt: string;
}

export interface UserRecord {
  id: string;
  username: string;
  fullName: string;
  role: Role;
  permissions: Permission[];
  isActive: boolean;
  failedAttempts: number;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEntry {
  id: string;
  userId: string;
  userName: string;
  action: string;
  entity: string;
  entityId: string;
  summary: string;
  beforeJson: string | null;
  afterJson: string | null;
  createdAt: string;
}

export interface SalesReport {
  billCount: number;
  itemCount: number;
  grossSales: number;
  discounts: number;
  returns: number;
  netSales: number;
  costOfGoods: number | null;
  grossProfit: number | null;
  expenses: number | null;
  netProfit: number | null;
  cashTaken: number;
  onCredit: number;
  byMethod: Array<{ method: PaymentMethod; billCount: number; total: number; paid: number }>;
  byDay: Array<{ date: string; billCount: number; netSales: number; grossProfit: number | null }>;
  byUser: Array<{ userId: string; userName: string; billCount: number; netSales: number }>;
  expenseBreakdown: Array<{ category: string; total: number }>;
}

export interface StockValueReport {
  rows: Array<{
    itemId: string;
    code: string;
    name: string;
    categoryName: string | null;
    unit: string;
    qtyOnHand: number;
    costPrice: number | null;
    salePrice: number;
    stockCost: number | null;
    stockRetail: number;
  }>;
  totalCost: number | null;
  totalRetail: number;
}

export interface LowStockRow {
  itemId: string;
  code: string;
  name: string;
  unit: string;
  qtyOnHand: number;
  lowStockLevel: number;
  soldLast30: number;
}

export interface BestSellerRow {
  itemId: string;
  code: string;
  name: string;
  qtySold: number;
  revenue: number;
  profit: number | null;
}

export interface DeadStockRow {
  itemId: string;
  code: string;
  name: string;
  qtyOnHand: number;
  stockCost: number | null;
  lastSoldAt: string | null;
  daysSinceSale: number | null;
}

export interface DuesRow {
  customerId: string;
  name: string;
  phone: string | null;
  balance: number;
  oldestUnpaidAt: string | null;
  daysOutstanding: number;
  lastPaymentAt: string | null;
}

export interface HeldSale {
  id: string;
  label: string;
  userId: string;
  userName: string;
  payloadJson: string;
  createdAt: string;
}

export interface ImportRow {
  line: number;
  code: string;
  name: string;
  unit: Unit;
  costPrice: number;
  salePrice: number;
  openingQty: number;
  lowStockLevel: number;
  categoryName: string;
  categoryId: string | null;
  existingId: string | null;
}

export interface ImportPreview {
  rows: ImportRow[];
  problems: Array<{ line: number; message: string }>;
  toAdd: number;
  toUpdate: number;
  newCategories: string[];
}

export interface BackupFile {
  name: string;
  path: string;
  sizeBytes: number;
  createdAt: string;
}

export interface ItemInput {
  code: string;
  name: string;
  categoryId: string | null;
  unit: Unit;
  costPrice: number;
  salePrice: number;
  minPrice: number | null;
  lowStockLevel: number;
  photoPath: string | null;
}

export interface SaleInput {
  lines: Array<{ itemId: string; qty: number; unitPrice?: number }>;
  customerId?: string | null;
  discount?: number;
  paymentMethod: PaymentMethod;
  tendered?: number;
  note?: string | null;
}

export interface DateRangeInput {
  from: string;
  to: string;
}

// --- Operations ------------------------------------------------------------

export interface SyncRun {
  sent: number;
  received: number;
  conflicts: number;
  setAside: number;
  rounds: number;
  reachedServer: boolean;
  problem: string | null;
  skipped: boolean;
}

export interface SyncStatus {
  pending: number;
  failed: number;
  dead: number;
  unseenConflicts: number;
  lastSyncedAt: string | null;
  lastError: string | null;
  /** False until this computer has been signed in to the cloud. */
  configured: boolean;
  account: string | null;
  busy: boolean;
  /** Ready-made line for the indicator, e.g. "14 changes waiting". */
  summary: string;
  lastRun: SyncRun | null;
}

export interface SyncConflict {
  id: string;
  tableName: string;
  rowId: string;
  detail: string;
  createdAt: string;
}

export interface SyncQueue {
  rows: Array<{ tableName: string; rowId: string; attempts: number; queuedAt: string }>;
  cursor: number;
  deviceId: string | null;
}

export const api = {
  // Session
  appStatus: () => call<AppStatus>('app.status'),
  loginOptions: () => call<LoginOption[]>('auth.loginOptions'),
  login: (userId: string, pin: string) => call<Session>('auth.login', { userId, pin }),
  logout: () => call<{ ok: true }>('auth.logout'),
  setupOwner: (input: {
    fullName: string;
    username: string;
    pin: string;
    shopName: string;
    phone?: string;
    addressLine1?: string;
  }) => call<Session>('setup.createOwner', input),

  // Catalogue
  items: (includeInactive = false) => call<Item[]>('item.list', { includeInactive }),
  item: (id: string) => call<Item | null>('item.get', { id }),
  createItem: (input: ItemInput & { openingQty?: number }) => call<Item>('item.create', input),
  saveItem: (input: ItemInput & { id: string; isActive?: boolean }) => call<Item>('item.save', input),
  removeItem: (id: string) => call<{ deleted: boolean }>('item.remove', { id }),
  nextItemCode: () => call<{ code: string }>('item.nextCode'),
  itemHistory: (id: string) => call<StockMovement[]>('item.history', { id }),

  itemPhoto: (id: string) => call<{ dataUrl: string | null }>('item.photo', { id }),
  setItemPhoto: (id: string) =>
    call<{ cancelled: boolean; dataUrl?: string | null }>('item.setPhoto', { id }),
  clearItemPhoto: (id: string) => call<{ ok: true }>('item.clearPhoto', { id }),

  categories: () => call<Category[]>('category.list'),
  createCategory: (name: string) => call<Category>('category.create', { name }),
  renameCategory: (id: string, name: string) => call<{ ok: true }>('category.rename', { id, name }),
  removeCategory: (id: string) => call<{ ok: true }>('category.remove', { id }),

  // Stock
  stockIn: (input: {
    itemId: string;
    qty: number;
    unitCost?: number | null;
    supplierName?: string | null;
    note?: string | null;
  }) => call<{ qtyAfter: number; costPrice: number }>('stock.in', input),
  countStock: (counts: Array<{ itemId: string; countedQty: number }>) =>
    call<{ adjusted: number; unchanged: number; netChange: number }>('stock.count', { counts }),
  adjustStock: (input: {
    itemId: string;
    countedQty: number;
    reason: AdjustmentReason;
    note?: string | null;
  }) => call<{ qtyAfter: number; qtyDelta: number }>('stock.adjust', input),

  // Customers
  customers: (options?: { search?: string; withDuesOnly?: boolean; includeInactive?: boolean }) =>
    call<Customer[]>('customer.list', options),
  customer: (id: string) => call<Customer | null>('customer.get', { id }),
  customerLedger: (id: string) =>
    call<{ customer: Customer; entries: LedgerEntry[] } | null>('customer.ledger', { id }),
  createCustomer: (input: {
    name: string;
    phone: string | null;
    address: string | null;
    notes: string | null;
    openingBalance?: number;
  }) => call<Customer>('customer.create', input),
  saveCustomer: (input: {
    id: string;
    name: string;
    phone: string | null;
    address: string | null;
    notes: string | null;
    isActive?: boolean;
  }) => call<Customer>('customer.save', input),
  removeCustomer: (id: string) => call<{ deleted: boolean }>('customer.remove', { id }),
  receivePayment: (input: {
    customerId: string;
    amount: number;
    method: SettledMethod;
    note?: string | null;
  }) => call<{ balanceAfter: number }>('customer.receivePayment', input),
  duesSummary: () =>
    call<{ owedToShop: number; advances: number; customersOwing: number }>('customer.duesSummary'),

  // Bills
  createSale: (input: SaleInput) =>
    call<{ sale: Sale; change: number; customerBalance: number | null }>('sale.create', input),
  sale: (id: string) => call<{ sale: Sale; returns: SaleReturn[] } | null>('sale.get', { id }),
  sales: (options: {
    from?: string;
    to?: string;
    customerId?: string;
    status?: SaleStatus;
    paymentMethod?: PaymentMethod;
    search?: string;
    creditOnly?: boolean;
    limit?: number;
  }) => call<SaleSummary[]>('sale.list', options),
  recentSales: (limit = 8) => call<SaleSummary[]>('sale.recent', { limit }),
  voidSale: (id: string, reason: string) => call<Sale>('sale.void', { id, reason }),
  createReturn: (input: {
    saleId: string;
    lines: Array<{ saleItemId: string; qty: number }>;
    refundMethod: RefundMethod;
    reason?: string | null;
  }) =>
    call<{ returnRecord: SaleReturn; refundAmount: number; customerBalance: number | null }>(
      'sale.return',
      input,
    ),

  // Parked bills
  holdSale: (label: string, payloadJson: string) =>
    call<HeldSale>('sale.hold', { label, payloadJson }),
  heldSales: () => call<HeldSale[]>('sale.heldList'),
  recallHeld: (id: string) => call<HeldSale>('sale.recallHeld', { id }),
  discardHeld: (id: string) => call<{ ok: true }>('sale.discardHeld', { id }),

  // Bringing an item list in from Excel
  previewImport: (csv: string) => call<ImportPreview>('item.previewImport', { csv }),
  applyImport: (rows: ImportRow[]) =>
    call<{ added: number; updated: number }>('item.applyImport', { rows }),

  // Reports
  salesReport: (range: DateRangeInput) => call<SalesReport>('report.sales', range),
  stockValue: () => call<StockValueReport>('report.stockValue'),
  lowStock: () => call<LowStockRow[]>('report.lowStock'),
  bestSellers: (range: DateRangeInput, limit = 25) =>
    call<BestSellerRow[]>('report.bestSellers', { ...range, limit }),
  deadStock: (days = 90) => call<DeadStockRow[]>('report.deadStock', { days }),
  dues: () => call<DuesRow[]>('report.dues'),

  // Expenses
  expenseCategories: () => call<string[]>('expense.categories'),
  expenses: (options?: { from?: string; to?: string; category?: string; limit?: number }) =>
    call<Expense[]>('expense.list', options),
  saveExpense: (input: {
    id?: string;
    category: string;
    description?: string | null;
    amount: number;
    spentAt?: string;
  }) => call<Expense>('expense.save', input),
  removeExpense: (id: string) => call<{ ok: true }>('expense.remove', { id }),

  // Users and settings
  users: () => call<UserRecord[]>('user.list'),
  grantablePermissions: () => call<Permission[]>('user.grantablePermissions'),
  createUser: (input: {
    fullName: string;
    username: string;
    pin: string;
    role: Role;
    permissions?: Permission[];
  }) => call<UserRecord>('user.create', input),
  saveUser: (input: {
    id: string;
    fullName: string;
    username: string;
    role: Role;
    permissions: Permission[];
    isActive: boolean;
  }) => call<UserRecord>('user.save', input),
  changeUserPin: (id: string, pin: string) => call<{ ok: true }>('user.changePin', { id, pin }),
  removeUser: (id: string) => call<{ ok: true }>('user.remove', { id }),

  settings: () => call<ShopSettings>('settings.get'),
  shopLogo: () => call<{ dataUrl: string | null }>('settings.logo'),
  chooseShopLogo: () =>
    call<{ cancelled: boolean; dataUrl?: string | null }>('settings.chooseLogo'),
  clearShopLogo: () => call<{ ok: true }>('settings.clearLogo'),
  saveSettings: (input: Partial<ShopSettings>) => call<ShopSettings>('settings.save', input),

  // Data health and backups
  checkData: () =>
    call<{
      stock: Array<{ itemId: string; code: string; name: string; cached: number; fromMovements: number }>;
      ledger: Array<{ customerId: string; name: string; cached: number; fromEntries: number }>;
    }>('data.check'),
  repairStock: () => call<{ repaired: number }>('data.repairStock'),
  backups: () => call<BackupFile[]>('backup.list'),
  createBackup: () => call<BackupFile>('backup.create'),
  inspectBackup: (path: string) =>
    call<{ schemaVersion: number; sales: number }>('backup.inspectRestore', { path }),
  restoreBackup: (path: string) =>
    call<{ replacedTo: string; sales: number; restartRequired: boolean }>('backup.restore', {
      path,
      confirm: true,
    }),
  openFolder: (which: 'backups' | 'receipts' | 'reports') =>
    call<{ path: string }>('folder.open', { which }),
  exportReport: (range: { from: string; to: string }) =>
    call<{ fileName: string; path: string; rows: number }>('report.export', range),

  // Receipts
  saleReceipt: (saleId: string) =>
    call<{ path: string; fileName: string }>('receipt.sale', { saleId }),
  customerStatement: (customerId: string) =>
    call<{ path: string; fileName: string }>('receipt.statement', { customerId }),
  openReceiptsFolder: () => call<{ path: string }>('folder.open', { which: 'receipts' }),

  audit: (options?: { entity?: string; entityId?: string; limit?: number }) =>
    call<AuditEntry[]>('audit.list', options),

  // Cloud
  joinExistingShop: (email: string, password: string) =>
    call<{
      shopName: string;
      items: number;
      categories: number;
      people: number;
      received: number;
    }>('setup.joinExistingShop', { email, password }),

  syncStatus: () => call<SyncStatus>('sync.status'),
  syncNow: () => call<SyncRun>('sync.now'),
  syncResumed: () =>
    call<{ sent: number; received: number; problem: string | null }>('sync.resumed'),
  cloudSignIn: (email: string, password: string) =>
    call<{ email: string; run: SyncRun }>('sync.signIn', { email, password }),
  cloudSignOut: () => call<{ ok: true }>('sync.signOut'),
  syncConflicts: (limit?: number) => call<SyncConflict[]>('sync.conflicts', { limit }),
  acknowledgeSyncConflicts: () => call<{ ok: true }>('sync.acknowledgeConflicts'),
  retrySyncQueue: () => call<{ requeued: number }>('sync.retryDead'),
  syncQueue: (limit?: number) => call<SyncQueue>('sync.peekQueue', { limit }),
};
