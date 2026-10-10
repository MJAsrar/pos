-- Let the owner's own sign-in reach the shop, as themselves.
--
-- Two separate things, both needed. Membership is what `is_shop_member()`
-- checks, so without a row here the account can sign in and see nothing at
-- all. And `pos_user_id` is who the shop knows them as: without it they could
-- look but not change anything, because a stock movement and an audit entry
-- both record a person and an email address is not one.
--
-- Pointed at the admin account at the counter, so a price changed from a phone
-- is recorded against Muhammad Hamza rather than against the till.
--
-- By email lookup rather than a pasted id, so this migration says what it
-- means and carries no password.

insert into shop_members (user_id, label, pos_user_id)
select u.id,
       'Owner (website)',
       (select id from users where role = 'admin' and deleted_at is null order by created_at limit 1)
  from auth.users u
 where u.email = 'admin@alhamza-pos.com'
on conflict (user_id) do update
  set label = excluded.label,
      pos_user_id = coalesce(shop_members.pos_user_id, excluded.pos_user_id);
