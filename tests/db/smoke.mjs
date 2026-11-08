import { newDb } from "./harness.mjs";
const h = await newDb();
console.log("migrations OK");
const r = await h.asPostgres("select count(*)::int c from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'");
console.log("public functions:", r.rows[0].c);
