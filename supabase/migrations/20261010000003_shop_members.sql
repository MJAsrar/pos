-- Who the shop lets in.
--
-- Membership is explicit rather than "anyone who is signed in", because public
-- sign-up is enabled on this project: without this table, registering any
-- account would be enough to read the shop's books.
--
-- No password appears here. The account is created through Supabase's auth
-- admin interface and only referenced by address, so this file is safe in a
-- public repository.

insert into shop_members (user_id, label)
select id, 'Counter PC'
  from auth.users
 where email = 'counter@alhamza-pos.com'
on conflict (user_id) do nothing;
