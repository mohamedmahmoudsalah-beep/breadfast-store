// Lets an admin with users.manage create an employee login (needs the service role, so it cannot run in the browser).
import { cors, json, serviceClient, userClient } from "../_shared/common.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  try {
    const caller = userClient(req);
    const { data: allowed } = await caller.rpc("has_permission", { p_perm: "users.manage" });
    if (allowed !== true) return json(req, { error: "FORBIDDEN" }, 403);
    const { email, password, hrid } = await req.json();
    if (typeof email !== "string" || !/^\S+@\S+\.\S+$/.test(email) || typeof password !== "string" || password.length < 8) return json(req, { error: "INVALID_INPUT" }, 400);
    const { data, error } = await serviceClient().auth.admin.createUser({ email: email.trim().toLowerCase(), password, email_confirm: true });
    if (error || !data.user) return json(req, { error: /registered|exists/i.test(error?.message ?? "") ? "EMAIL_EXISTS" : "CREATE_FAILED" }, 400);
    if (typeof hrid === "string" && hrid.trim()) {
      const { error: linkErr } = await caller.rpc("admin_link_hrid", { p_user: data.user.id, p_hrid: hrid });
      if (linkErr) return json(req, { email: data.user.email, warning: (linkErr.message.match(/^[A-Z_]+/) ?? ["LINK_FAILED"])[0] });
    }
    return json(req, { email: data.user.email });
  } catch (e) {
    console.error("admin-create-user", e);
    return json(req, { error: "INTERNAL" }, 500);
  }
});
