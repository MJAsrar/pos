-- Let a member read the member list.
--
-- The original policy asked "is there a row in shop_members for me?" while
-- being the policy *on* shop_members, so answering it required applying
-- itself. Postgres stops that with 42P17, infinite recursion, and every read
-- of the table failed.
--
-- It went unnoticed because nothing reads this table yet: sync checks
-- membership through is_shop_member(), which is `security definer` and so
-- skips row-level security entirely. The website will be the first thing to
-- ask who can reach the shop, and it would have met the error instead.
--
-- Same question, asked through that function rather than through the table,
-- which is what the function is for.

drop policy if exists "members can see the member list" on shop_members;

create policy "members can see the member list"
  on shop_members for select
  using (public.is_shop_member());
