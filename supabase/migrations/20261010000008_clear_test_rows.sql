-- Remove the rows written while proving sync_v1 worked.
--
-- They were pushed by a test script against this project, not by the shop, and
-- the counter has never synced yet -- so nothing anywhere has a copy of them
-- and deleting outright is correct here. Ordinary deletions are never done
-- this way: a row the shop has seen is retired by setting `deleted_at`, so
-- every device learns it is gone.

delete from stock_movements where id like 'test-%';
delete from items where id like 'test-%';
