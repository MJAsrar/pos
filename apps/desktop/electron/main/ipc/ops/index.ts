import { registerAdminOps } from './admin.js';
import { registerAuthOps } from './auth.js';
import { registerCustomerOps } from './customers.js';
import { registerDevOps } from './dev.js';
import { registerItemOps } from './items.js';
import { registerReceiptOps } from './receipts.js';
import { registerReportOps } from './reports.js';
import { registerSaleOps } from './sales.js';
import { registerSyncOps } from './sync.js';

/**
 * Register every operation the renderer is allowed to call.
 *
 * One place, so the whole surface the UI can reach is readable in a single file
 * rather than scattered across feature folders.
 */
export function registerAllOps(): void {
  registerAuthOps();
  registerItemOps();
  registerCustomerOps();
  registerSaleOps();
  registerReportOps();
  registerReceiptOps();
  registerSyncOps();
  registerAdminOps();
  // No-op in a packaged build.
  registerDevOps();
}
