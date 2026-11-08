-- 1) Register normally on the website with your email and confirm it.
-- 2) Run this in the Supabase SQL editor (replace the email) to become Super Admin.
select public.bootstrap_super_admin('your-email@example.com');
