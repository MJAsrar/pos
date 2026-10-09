# Al Hamza POS

Point-of-sale for **Al Hamza Electronics — Dina**, an electronics and spare-parts
shop in Punjab, Pakistan.

Runs on one Windows PC at the counter and works with no internet at all. Stage 2
will mirror everything to the cloud so the owner can see the shop from a phone;
Stage 3 adds the web portal.

---

## Running it

```bash
npm install          # also rebuilds better-sqlite3 for Electron's ABI
npm run dev          # start the app with hot reload
npm test             # 138 tests across both packages
npm run typecheck    # both the Electron side and the renderer
npm run build:win    # produces apps/desktop/release/Al Hamza POS Setup <version>.exe
```

First launch asks for the shop details and creates the owner's account. After
that it is a PIN to sign in.

While developing, `dev.seed` fills the database with a realistic shop — 42 parts
with Dina prices, six customers with balances, a week of trading. It is
registered only when the app is unpackaged, so it cannot reach a real shop.

---

## How it is put together

```
packages/shared     money, permissions, bill totals, ledger rules
apps/desktop
  electron/main     the only process that touches the database
    db/             schema, migrations, repositories (all SQL lives here)
    services/       business rules and transactions
    ipc/            the single door the UI talks through
  src/              React renderer — knows nothing but what it is told
```

**The renderer is untrusted.** `contextIsolation` on, `nodeIntegration` off,
`sandbox` on, and a Content-Security-Policy that allows no network at all. The
page can only ask the main process to run a named operation, which is validated
with a zod schema and permission-checked before anything happens. Hiding a
button is presentation; the check in `ipc/router.ts` is the boundary.

### Three decisions everything else follows from

**Money is integer paisa.** Never a float. `Rs 50.00` is `5000`. All arithmetic
lives in `packages/shared/src/money.ts`, and bill totals round to the whole
rupee with the difference recorded in `rounding` so reports reconcile exactly.

**Ledgers and stock are append-only.** `customers.balance` and
`items.qty_on_hand` are only caches of `customer_ledger_entries` and
`stock_movements`. Every change writes a signed row with a reason attached, in
the same transaction as whatever caused it. That is what makes *"why is this at
3 and not 5?"* and *"prove this customer owes Rs 8,400"* answerable — the
questions the paper register could never settle. Settings → **Check the figures**
compares both caches against their history.

**Cost is snapshotted onto every sale line.** Change a supplier price tomorrow
and last month's profit does not move.

### The counter screen

A whole sale is possible without the mouse, and focus returns to the search box
after every action. Type a code and press Enter; `5*201` adds five; an unknown
term opens a fuzzy search. `F2` customer, `F3` find item, `F5` quantity, `F6`
discount, `F9` rate, `F12` pay, `Ctrl+Enter` for an exact-cash sale — which is
most of them. Paying less than the total is not an error: the remainder goes on
the customer's udhaar, and the dialog shows what they will owe before it saves.

---

## Data safety

- SQLite in WAL mode with `synchronous = FULL` — mains power in Dina is not
  dependable, and a committed sale must survive a cut.
- Backups to `Documents/AlHamzaPOS/backups` on every start and close, keeping 14
  daily and 4 weekly, verified with `PRAGMA integrity_check` before being kept.
- Forward-only migrations tracked by `PRAGMA user_version`, each in its own
  transaction, with the database copied aside before the first pending one.
- The database lives in `userData`, never beside the executable, so an update
  cannot take the shop's data with it.

---

## Before handing it to the shop

- [ ] Set the GitHub `owner`/`repo` in `apps/desktop/electron-builder.yml`, or
      auto-update stays switched off (it fails quietly, which is by design).
- [ ] Add the shop logo in Settings, and check the address and phone number.
- [ ] Load the real item list, and enter each credit customer's balance from the
      register as their opening balance.
- [ ] Run a backup and **restore it once**, on purpose. An untested backup is not
      a backup.

The installer is unsigned — a code-signing certificate is not worth it for one
machine — so Windows SmartScreen will warn on first install. Click *More info →
Run anyway*.

---

## Not built, deliberately

Double-entry accounting, supplier payables and purchase orders, serial/IMEI and
warranty tracking, item variants, barcode and printer hardware, multi-branch,
tax invoices. Each was considered and left out; adding any of them is a decision,
not an oversight.
