-- Run once if migration 0006 printed a notice that pg_cron was not enabled.
-- 1) Dashboard > Database > Extensions > enable "pg_cron"   2) run this file in the SQL editor.
select cron.schedule('breadfast-jobs', '* * * * *', 'select public.run_scheduled_jobs()');
