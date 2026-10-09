-- Somewhere offsite for a copy of the shop database.
--
-- Worth being plain about what this is for. The cloud tables are a *replica*:
-- they hold the same rows, so they survive the shop PC dying, but they are not
-- a backup -- a mistake made at the counter is replicated faithfully within a
-- minute. The backup is the SQLite file, which can be restored to a state the
-- shop was actually in.
--
-- Keeping one copy of that file offsite covers the case the local backups do
-- not: the computer and the backups folder are on the same disk, in the same
-- shop, behind the same electricity supply.
--
-- Private bucket, members only, and no public URL at any size.

insert into storage.buckets (id, name, public, file_size_limit)
values ('shop-backups', 'shop-backups', false, 209715200)
on conflict (id) do update set public = false, file_size_limit = 209715200;

drop policy if exists "shop members can add a backup" on storage.objects;
create policy "shop members can add a backup"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'shop-backups' and public.is_shop_member());

drop policy if exists "shop members can replace a backup" on storage.objects;
create policy "shop members can replace a backup"
  on storage.objects for update to authenticated
  using (bucket_id = 'shop-backups' and public.is_shop_member());

drop policy if exists "shop members can read backups" on storage.objects;
create policy "shop members can read backups"
  on storage.objects for select to authenticated
  using (bucket_id = 'shop-backups' and public.is_shop_member());

-- Needed so old copies can be cleared out; without it the free tier fills up
-- and then nothing can be uploaded at all.
drop policy if exists "shop members can remove old backups" on storage.objects;
create policy "shop members can remove old backups"
  on storage.objects for delete to authenticated
  using (bucket_id = 'shop-backups' and public.is_shop_member());
