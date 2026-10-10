-- Remove the customers used to exercise the ledger screen.
--
-- They were put here by a test script, not by the shop, and the counter was
-- closed throughout -- so nothing anywhere has a copy and deleting outright is
-- correct. Ordinary removals are never done this way: a customer the shop has
-- seen is retired by setting `deleted_at`, so every device learns they are
-- gone and their history stays readable.
--
-- One of these ledgers holds the evidence of a bug worth remembering. The
-- website let a payment be recorded before the customer history had finished
-- loading, so it worked from a balance of zero and wrote a running total of
-- minus the payment instead of the balance less the payment. The money was
-- never wrong -- a balance is always the sum of the entries, and the view
-- computed it correctly throughout -- but the register column read as
-- nonsense. The page now waits for the history, and re-reads it at the moment
-- of saving rather than trusting what is on screen.

delete from customer_ledger_entries where customer_id like 'test-%' or id like 'test-%';
delete from customer_payments where customer_id like 'test-%';
delete from customers where id like 'test-%';
