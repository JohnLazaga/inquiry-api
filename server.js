#!/usr/bin/env node
/* =====================================================================
 * Inquiry API — Janice Auto Supply
 *
 * respond.io webhook in -> read the inquiry -> exact catalogue lookup
 * through the Host App's RPCs -> price lock -> technical details back
 * into the respond.io inbox as a staff note.
 *
 * No UI. respond.io owns the conversation; this owns the lookup and the
 * quote ledger.
 *
 *   npm install && psql "$DATABASE_URL" -f schema.sql && node server.js
 * ===================================================================== */

require("dotenv").config();

const express = require("express");
const crypto  = require("crypto");

const db      = require("./lib/db");
const host    = require("./lib/hostapp");
const respond = require("./lib/respond");
const { extract } = require("./lib/extract");
const C       = require("./lib/compose");

const app = express();
app.use(express.json({ limit: "1mb", verify: (req, _r, buf) => { req.raw = buf; } }));

const SHADOW   = process.env.SHADOW_MODE !== "false";
const AUTOSEND = (process.env.AUTOSEND_INTENTS || "")
                   .split(",").map((s) => s.trim()).filter(Boolean);

/* ------------------------------------------------------------------ */
/* Webhook                                                             */
/* ------------------------------------------------------------------ */

app.post("/webhook/respond/:secret", async (req, res) => {
  // The secret lives in the path, so only respond.io knows the URL.
  // Compared in constant time so a wrong guess leaks nothing.
  const want = Buffer.from(process.env.RESPOND_WEBHOOK_SECRET || "");
  const got  = Buffer.from(req.params.secret || "");
  if (want.length === 0 || got.length !== want.length ||
      !crypto.timingSafeEqual(got, want)) {
    return res.sendStatus(404);
  }

  res.sendStatus(200);          // ack first — respond.io retries on delay

  handle(respond.parseEvent(req.body)).catch((err) =>
    console.error("[handle]", err.message));
});

/* ------------------------------------------------------------------ */
/* The pipeline                                                        */
/* ------------------------------------------------------------------ */

async function handle(ev) {
  if (ev.traffic !== "incoming") return;        // our own replies echoing back
  if (!ev.contactId || !ev.text) return;
  if (ev.messageId && !(await db.claim(ev.messageId))) return;   // already done

  const started = Date.now();
  const style   = respond.channelStyle(ev.channelId);

  let person = null, fields = {}, rows = [], locks = {}, customer = null;
  let draft = null, postedKind = "none", failed = null;

  try {
    person = await db.person({
      respondId: ev.contactId, name: ev.name, phone: ev.phone
    });

    // 1. read the inquiry
    fields = await extract(ev.text);

    // 2. who is this, in Host App terms
    if (person.msisdn) {
      customer = await host.customerByPhone(person.msisdn).catch((e) => {
        console.error("[customer]", e.message); return null;
      });
      if (customer && customer.cust_code !== person.cust_code) {
        await db.setCustCode(person.id, customer.cust_code);
      }
    }

    // 3. exact lookup — the only read of their data
    const searchable = fields.part || fields.code || fields.brand || fields.engine;
    if (searchable) {
      rows = await host.searchParts({
        brand: fields.brand, part: fields.part, make: fields.make,
        engine: fields.engine, code: fields.code, limit: 20
      });

      await db.logSearch({
        personId: person.id, respondId: ev.contactId, channelId: ev.channelId,
        rawText: ev.text, extracted: fields,
        results: rows.map((r) => r.stock_code),
        resultCount: rows.length, latencyMs: Date.now() - started
      });

      // 4. the lock — what were they already told?
      for (const r of rows.slice(0, 5)) {
        const l = await db.lockedPrice(person.id, r.stock_code);
        if (l) locks[r.stock_code] = l;
      }
    }

    // 5. draft, unless money or credit is involved
    if (!C.needsHuman(fields, customer)) {
      draft = C.draftReply({ fields, rows, locks, style, name: person.display_name });
      const v = C.validate(draft, rows, locks);
      if (!v.ok) {
        console.warn("[validate] dropped draft:", v.reason);
        draft = null;
        failed = "draft failed validation: " + v.reason;
      }
    }

    // 6. back into the inbox
    const maySend = draft && !SHADOW && AUTOSEND.includes(fields.intent);

    await respond.comment(ev.contactId, C.note({
      fields, rows, locks, customer,
      personMsisdn: person.msisdn, draft, shadow: !maySend
    }));
    postedKind = "comment";

    if (maySend) {
      await respond.message(ev.contactId, draft, ev.channelId);
      postedKind = "message";

      // Only a price that actually reached the customer gets locked.
      const r = rows[0];
      if (r && !locks[r.stock_code]) {
        await db.recordQuote({
          personId: person.id, stockCode: r.stock_code, partName: r.part_name,
          price: r.price, channelId: ev.channelId,
          channelLabel: style === "sms" ? "SMS" : "respond.io", quotedBy: "ai"
        });
      }
    }
  } catch (err) {
    failed = err.message;
    console.error("[pipeline]", err);
    // Staff still get something useful rather than silence.
    await respond.comment(ev.contactId,
      `LOOKUP FAILED\n\n${err.message}\n\nHandle this one manually.`)
      .catch(() => {});
    postedKind = "comment";
  }

  await db.logRun({
    personId: person?.id, respondId: ev.contactId, channelId: ev.channelId,
    intent: fields.intent, shadow: SHADOW, postedKind, draft, failed
  }).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* Staff marked a draft as sent untouched — how autonomy gets earned   */
/* ------------------------------------------------------------------ */

app.post("/run/:id/as-is", async (req, res) => {
  await db.q(`update agent_run set sent_as_is = $2 where id = $1`,
             [req.params.id, req.body?.as_is !== false]);
  res.json({ ok: true });
});

app.get("/scorecard", async (_req, res) => {
  const { rows } = await db.q(`select * from intent_scorecard`);
  res.json({ shadow: SHADOW, autosend: AUTOSEND, intents: rows });
});

/* ------------------------------------------------------------------ */

app.get("/health", async (_req, res) => {
  try {
    await db.q("select 1");
    res.json({ ok: true, shadow: SHADOW, autosend: AUTOSEND });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`inquiry api on :${PORT} · shadow=${SHADOW} · autosend=[${AUTOSEND}]`));
