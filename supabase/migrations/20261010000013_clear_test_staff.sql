-- Remove the cashier used to check that a PIN set on the website works at the
-- counter.
--
-- Put here by a test script with the till closed, so nothing anywhere has a
-- copy and deleting outright is correct. A real departure is handled by
-- switching the account off, never by removing the row: bills they rang up
-- still point at them and the audit log still names them.
--
-- Worth recording what the test established, because it is the claim the
-- whole arrangement rests on. The website hashed the chosen PIN with Argon2id
-- at the same cost the till uses -- the stored hash reads
-- `$argon2id$v=19$m=19456,t=2,p=1$...` -- and the counter's own library
-- verified it. A PIN set from a phone therefore opens the till, the plain PIN
-- never reached the database, and changing it left what the cashier is allowed
-- to do untouched.

delete from users where username = 'teststaff';
