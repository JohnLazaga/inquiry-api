/*
 * The Host App, read-only, through its RPCs.
 *
 * Signed in as a dedicated bot auth user, so row-level security and the
 * per-module permission checks do their job exactly as they do for a
 * counter user. The service_role key is never used here and must not be
 * put in this service's environment.
 */

const BASE  = () => process.env.HOST_APP_URL.replace(/\/$/, "");
const ANON  = () => process.env.HOST_APP_ANON_KEY;

let session = null;   // { token, expiresAt }

async function token() {
  if (session && session.expiresAt - Date.now() > 60_000) return session.token;

  const res = await fetch(`${BASE()}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON() },
    body: JSON.stringify({
      email: process.env.HOST_APP_BOT_EMAIL,
      password: process.env.HOST_APP_BOT_PASSWORD
    })
  });
  if (!res.ok) throw new Error(`host app sign-in failed: ${res.status} ${await res.text()}`);

  const j = await res.json();
  session = { token: j.access_token, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return session.token;
}

async function rpc(name, args) {
  const call = async () => fetch(`${BASE()}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: ANON(),
      Authorization: `Bearer ${await token()}`
    },
    body: JSON.stringify(args)
  });

  let res = await call();
  if (res.status === 401) { session = null; res = await call(); }   // token expired
  if (!res.ok) throw new Error(`${name} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * Catalogue search. Returns at most p_limit real rows — stock code,
 * name, brand, SRP incl VAT, per-branch quantities. Never cost.
 */
const searchParts = (f) => rpc("crm_search_parts", {
  p_brand:  f.brand  ?? null,
  p_part:   f.part   ?? null,
  p_make:   f.make   ?? null,
  p_engine: f.engine ?? null,
  p_code:   f.code   ?? null,
  p_limit:  f.limit  ?? 20
});

/** Who is this, in Host App terms. Balance is for routing, not replies. */
async function customerByPhone(msisdn) {
  if (!msisdn) return null;
  const rows = await rpc("crm_customer_by_phone", { p_msisdn: msisdn });
  return rows?.[0] ?? null;
}

module.exports = { searchParts, customerByPhone };
