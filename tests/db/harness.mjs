// Test harness: real PostgreSQL (PGlite) + minimal Supabase stubs (auth schema, roles, auth.uid()).
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../supabase");

export async function newDb() {
  const db = new PGlite();
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create schema auth;
    create table auth.users(id uuid primary key default gen_random_uuid(), email text unique, email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to authenticated, service_role;
    grant usage on schema public to anon, authenticated, service_role;
  `);
  const files = readdirSync(join(root, "migrations")).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    try { await db.exec(readFileSync(join(root, "migrations", f), "utf8")); }
    catch (e) { throw new Error(`Migration ${f} failed: ${e.message}`); }
  }
  return new Harness(db);
}

export class Harness {
  constructor(db) { this.db = db; this.users = {}; }
  async asPostgres(sql, params) { await this.db.exec("reset role; select set_config('request.jwt.claim.sub','',false)"); return this.db.query(sql, params); }
  async setNow(ts) { await this.db.query("select set_config('app.test_now', $1, false)", [ts ?? ""]); }
  async addUser(name, { confirmed = true } = {}) {
    const r = await this.asPostgres("insert into auth.users(email, email_confirmed_at) values ($1, $2) returning id",
      [`${name}@breadfast.test`, confirmed ? new Date().toISOString() : null]);
    this.users[name] = r.rows[0].id; return r.rows[0].id;
  }
  async grantRole(name, role) { await this.asPostgres("insert into user_roles(user_id, role) values ($1, $2) on conflict do nothing", [this.users[name], role]); }
  async grantPerm(name, perm) { await this.asPostgres("insert into user_permissions(user_id, permission) values ($1,$2) on conflict do nothing", [this.users[name], perm]); }
  // run a query as an authenticated API user (RLS + grants apply)
  async as(name, sql, params) {
    await this.db.exec(`reset role; select set_config('request.jwt.claim.sub','${this.users[name]}',false); set role authenticated`);
    try { return await this.db.query(sql, params); }
    finally { await this.db.exec("reset role; select set_config('request.jwt.claim.sub','',false)"); }
  }
  async rpc(name, fn, ...args) {
    const ph = args.map((_, i) => `$${i + 1}`).join(", ");
    const r = await this.as(name, `select ${fn}(${ph}) as r`, args.map((a) => (a !== null && typeof a === "object" ? JSON.stringify(a) : a)));
    return r.rows[0].r;
  }
  // expect an RPC to fail with a given error code (message)
  async rpcFails(name, code, fn, ...args) {
    try { await this.rpc(name, fn, ...args); } catch (e) {
      if (!String(e.message).includes(code)) throw new Error(`expected ${code} but got: ${e.message}`);
      return e;
    }
    throw new Error(`expected ${code} but call succeeded: ${fn}`);
  }
  async asService(sql, params) {
    await this.db.exec("reset role; set role service_role");
    try { return await this.db.query(sql, params); } finally { await this.db.exec("reset role"); }
  }
}
