/**
 * The permission matrix — the single source of truth for who can do what.
 *
 * The renderer uses this to hide controls; the Electron main process uses the
 * same table to refuse the IPC call outright. Hiding a button is a courtesy,
 * not a security boundary, so both sides must agree and only one of them counts.
 */

export const PERMISSIONS = [
  'sale.create',        // ring up a bill
  'sale.credit',        // put a bill (or part of it) on a customer's udhaar
  'sale.edit_price',    // change a line rate at the counter (bargaining)
  'sale.discount',      // apply a bill-level discount
  'sale.return',        // take a return against a bill
  'sale.edit',          // correct a saved bill
  'sale.void',          // cancel a saved bill
  'sale.view_all',      // see other users' bills, not just your own
  'item.manage',        // add and edit items, change prices
  'item.view_cost',     // see cost price and margin anywhere in the app
  'stock.manage',       // stock-in and stock adjustments
  'customer.manage',    // add and edit customers
  'customer.payment',   // receive a payment against a customer's balance
  'expense.manage',     // record shop expenses
  'report.view',        // sales and stock reports
  'report.view_profit', // profit figures inside those reports
  'user.manage',        // create staff, set PINs, change permissions
  'settings.manage',    // shop details, invoice prefix, pricing policy
  'backup.manage',      // run and restore backups
  'audit.view',         // read the audit log
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export type Role = 'admin' | 'staff';

/**
 * What a newly created staff account can do before the admin ticks anything else.
 * Deliberately minimal: sell, and manage the customers they sell to.
 */
export const DEFAULT_STAFF_PERMISSIONS: readonly Permission[] = [
  'sale.create',
  'customer.manage',
];

/**
 * Permissions an admin may grant to a staff account.
 *
 * `user.manage`, `settings.manage`, `backup.manage` and `audit.view` are absent
 * on purpose — a staff account that can grant itself permissions is not a
 * permission system.
 */
export const GRANTABLE_PERMISSIONS: readonly Permission[] = [
  'sale.create',
  'sale.credit',
  'sale.edit_price',
  'sale.discount',
  'sale.return',
  'sale.view_all',
  'item.manage',
  'item.view_cost',
  'stock.manage',
  'customer.manage',
  'customer.payment',
  'expense.manage',
  'report.view',
  'report.view_profit',
];

/** Human-readable labels for the permission checklist on the Users screen. */
export const PERMISSION_LABELS: Record<Permission, string> = {
  'sale.create': 'Make sales',
  'sale.credit': 'Sell on credit (udhaar)',
  'sale.edit_price': 'Change price while billing',
  'sale.discount': 'Give discounts',
  'sale.return': 'Accept returns',
  'sale.edit': 'Edit a saved bill',
  'sale.void': 'Cancel a saved bill',
  'sale.view_all': "See other users' bills",
  'item.manage': 'Add and edit items',
  'item.view_cost': 'See cost price',
  'stock.manage': 'Add and adjust stock',
  'customer.manage': 'Add and edit customers',
  'customer.payment': 'Receive customer payments',
  'expense.manage': 'Record expenses',
  'report.view': 'View reports',
  'report.view_profit': 'See profit figures',
  'user.manage': 'Manage users',
  'settings.manage': 'Change settings',
  'backup.manage': 'Backup and restore',
  'audit.view': 'View audit log',
};

export interface PermissionSubject {
  role: Role;
  permissions: readonly Permission[];
  isActive: boolean;
}

/** Can this user perform this action? Admins can do everything. */
export function can(user: PermissionSubject | null | undefined, permission: Permission): boolean {
  if (!user || !user.isActive) return false;
  if (user.role === 'admin') return true;
  return user.permissions.includes(permission);
}

/** Every permission this user effectively holds. */
export function effectivePermissions(user: PermissionSubject): readonly Permission[] {
  if (user.role === 'admin') return PERMISSIONS;
  return user.permissions;
}

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value);
}

/** Drop anything unknown or non-grantable from a stored permission list. */
export function sanitizePermissions(values: readonly unknown[]): Permission[] {
  const seen = new Set<Permission>();
  for (const value of values) {
    if (isPermission(value) && GRANTABLE_PERMISSIONS.includes(value)) seen.add(value);
  }
  return [...seen];
}

/** Thrown by the main process when a user lacks a permission. */
export class PermissionDeniedError extends Error {
  readonly permission: Permission;
  constructor(permission: Permission) {
    super(`You do not have permission to do this (${PERMISSION_LABELS[permission]}).`);
    this.name = 'PermissionDeniedError';
    this.permission = permission;
  }
}
