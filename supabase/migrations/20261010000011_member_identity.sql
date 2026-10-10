-- Tie a cloud sign-in to the person it is at the counter.
--
-- Two different notions of "who" meet here. The cloud knows an email and a
-- password. The shop knows Muhammad Hamza, who signs in with a PIN and whose
-- id is on every bill, every stock movement and every line of the audit log.
--
-- Until now nothing connected them, which was fine while the website only
-- read. The moment it changes something -- a price, a stock count -- that
-- change has to be attributed to a shop person, because `stock_movements` and
-- `audit_log` both require a user and because "who changed this price?" is a
-- question the owner will eventually ask.
--
-- So a member row says which counter account it acts as. Nullable, because a
-- member who only ever looks does not need one, and an unattributed write is
-- refused rather than quietly recorded against nobody.

alter table shop_members add column if not exists pos_user_id text;

comment on column shop_members.pos_user_id is
  'The users.id this cloud account acts as when it changes anything. Null means read-only.';

-- The counter PC acts as the shop owner, which is the only account there is.
update shop_members
   set pos_user_id = (
         select id from users
          where role = 'admin' and deleted_at is null
          order by created_at
          limit 1)
 where pos_user_id is null;
