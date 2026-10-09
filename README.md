# Al Hamza POS

Point-of-sale for **Al Hamza Electronics — Dina**, an electronics and spare-parts
shop in Punjab, Pakistan.

Runs on one Windows PC at the counter and works with no internet at all. When
there is a connection it mirrors everything to a Postgres database in the cloud,
so the shop can be seen from somewhere other than the counter. Stage 3 adds the
web portal that reads it.

---

## Running it

```bash
npm install          # also rebuilds better-sqlite3 for Electron's ABI
npm run dev          # start the app with hot reload
npm test             # 248 tests across both packages
npm run typecheck    # both the Electron side and the renderer
npm run build:win    # produces apps/desktop/release/Al Hamza POS Setup <version>.exe
```

First launch asks for the shop details and creates the owner's account. After
that it is a PIN to sign in.

The database starts empty. The shop's own catalogue is loaded from the Items
screen, by CSV import or by hand.

The Supabase schema is separate:

```bash
npx supabase db push    # applies supabase/migrations to the cloud database
```

---

## How it is put together

```
packages/shared     money, permissions, bill totals, ledger rules
apps/desktop
  electron/main     the only process that touches the database
    db/             schema, migrations, repositories (all SQL lives here)
    services/       business rules and transactions
      sync/           the cloud: sign-in, transport, offsite backup
    ipc/            the single door the UI talks through
  src/              React renderer — knows nothing but what it is told
supabase/migrations  the cloud schema, its access rules and the sync function
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

### Sync

One HTTP call to one Postgres function, `sync_v1`: send what changed here,
receive what changed there, in a single transaction. A bill and its lines have
to land together, and on a bad connection one request succeeds far more often
than eight.

The rules live in the database rather than the app, because the app on the shop
counter cannot be force-updated — whatever version is running out there, the
server decides. Three of them matter:

**Stock is never sent as a number.** `items.qty_on_hand` and
`customers.balance` are sums of `stock_movements` and the ledger, and they are
stripped from everything that crosses the wire. The cloud has no such columns at
all — it computes them in a view. An absolute quantity arriving from elsewhere
could erase a day of offline sales silently, and signed deltas add up to the
same answer whatever order they arrive in.

**Rows written once cannot conflict.** Sale lines, movements, ledger entries:
seeing one twice is a retry, not a problem. Only rows that get *edited* — an
item's price, a customer's phone — need a winner, and that is last-write-wins on
`updated_at`, clamped to the server's clock so a counter PC running three days
fast cannot win every conflict forever. The loser is kept and shown in Settings,
because an owner whose price change vanished deserves to know why.

**A change not yet accepted is never overwritten.** The server echoes back what
it was just sent; if the row was edited again in the meantime, writing that echo
would quietly undo the newer edit and then push the old value back. The outbox is
the record of what has not been accepted, and it is checked before anything from
the server is written.

Queued by SQLite triggers rather than by the services, so a new service cannot
forget. A flag in `sync_state` stands the triggers down while a batch from the
server is being applied, which is what stops a pulled row bouncing straight
back. Being offline costs a row nothing; only a refusal counts against it, and
after ten refusals one row is set aside so the rest can go.

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
- A gzipped copy of the database goes to a private cloud bucket about once a
  day, kept for thirty days.

Three different things, worth not confusing:

| | covers | cannot |
|---|---|---|
| Local backups | a mistake, a bad migration | the computer being lost |
| The cloud tables | the computer being lost | undo anything — they are a replica, and a mistake is copied up within the minute |
| The offsite file | the computer being lost *and* a mistake | be restored without someone deciding to |

---

## Before handing it to the shop

- [ ] Set the GitHub `owner`/`repo` in `apps/desktop/electron-builder.yml`, or
      auto-update stays switched off (it fails quietly, which is by design).
- [ ] Add the shop logo in Settings, and check the address and phone number.
- [ ] Load the real item list, and enter each credit customer's balance from the
      register as their opening balance.
- [ ] Run a backup and **restore it once**, on purpose. An untested backup is not
      a backup.
- [ ] Connect the computer in Settings → *Seeing the shop from a phone*, and
      watch the rail go from "Phone view not set up" to "Up to date".

The installer is unsigned — a code-signing certificate is not worth it for one
machine — so Windows SmartScreen will warn on first install. Click *More info →
Run anyway*.

---

## Not built, deliberately

Double-entry accounting, supplier payables and purchase orders, serial/IMEI and
warranty tracking, item variants, barcode and printer hardware, multi-branch,
tax invoices. Each was considered and left out; adding any of them is a decision,
not an oversight.
