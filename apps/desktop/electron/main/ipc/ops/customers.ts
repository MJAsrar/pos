import { z } from 'zod';
import { defineOp } from '../router.js';
import {
  duesSummary,
  findCustomerById,
  listCustomers,
} from '../../db/repos/customerRepo.js';
import {
  adjustBalance,
  createCustomer,
  customerLedger,
  receivePayment,
  removeCustomer,
  saveCustomer,
} from '../../services/customerService.js';

const paisa = z.number().int();

const customerFields = {
  name: z.string().min(2).max(80),
  phone: z.string().max(40).nullable(),
  address: z.string().max(160).nullable(),
  notes: z.string().max(400).nullable(),
};

export function registerCustomerOps(): void {
  defineOp({
    op: 'customer.list',
    input: z
      .object({
        search: z.string().max(80).optional(),
        withDuesOnly: z.boolean().optional(),
        includeInactive: z.boolean().optional(),
      })
      .optional(),
    handler: (input, ctx) =>
      listCustomers(ctx.db, {
        ...(input?.search ? { search: input.search } : {}),
        ...(input?.withDuesOnly ? { withDuesOnly: true } : {}),
        ...(input?.includeInactive ? { includeInactive: true } : {}),
      }),
  });

  defineOp({
    op: 'customer.get',
    input: z.object({ id: z.string().min(1) }),
    handler: (input, ctx) => findCustomerById(ctx.db, input.id),
  });

  defineOp({
    op: 'customer.ledger',
    input: z.object({ id: z.string().min(1) }),
    handler: (input, ctx) => {
      const customer = findCustomerById(ctx.db, input.id);
      if (!customer) return null;
      return { customer, entries: customerLedger(ctx.db, input.id) };
    },
  });

  defineOp({
    op: 'customer.create',
    permission: 'customer.manage',
    input: z.object({ ...customerFields, openingBalance: paisa.optional() }),
    handler: (input, ctx) => createCustomer(ctx.db, input, ctx.user.id),
  });

  defineOp({
    op: 'customer.save',
    permission: 'customer.manage',
    input: z.object({
      ...customerFields,
      id: z.string().min(1),
      isActive: z.boolean().optional(),
    }),
    handler: (input, ctx) => saveCustomer(ctx.db, input, ctx.user.id),
  });

  defineOp({
    op: 'customer.remove',
    permission: 'customer.manage',
    input: z.object({ id: z.string().min(1) }),
    handler: (input, ctx) => removeCustomer(ctx.db, input.id, ctx.user.id),
  });

  defineOp({
    op: 'customer.receivePayment',
    permission: 'customer.payment',
    input: z.object({
      customerId: z.string().min(1),
      amount: paisa.positive(),
      method: z.enum(['cash', 'wallet', 'bank']),
      note: z.string().max(200).nullable().optional(),
    }),
    handler: (input, ctx) => receivePayment(ctx.db, input, ctx.user.id),
  });

  /**
   * Correct a balance by hand.
   *
   * Requires `user.manage` rather than `customer.manage`: writing off what
   * somebody owes is an owner's decision, not part of serving customers.
   */
  defineOp({
    op: 'customer.adjustBalance',
    permission: 'user.manage',
    input: z.object({
      customerId: z.string().min(1),
      amount: paisa,
      note: z.string().min(1).max(200),
    }),
    handler: (input, ctx) =>
      adjustBalance(ctx.db, input.customerId, input.amount, input.note, ctx.user.id),
  });

  defineOp({
    op: 'customer.duesSummary',
    input: z.void().optional(),
    handler: (_input, ctx) => duesSummary(ctx.db),
  });
}
