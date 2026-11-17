/* Our own database. Quote ledger, search log, run log. */
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const q = (sql, args) => pool.query(sql, args);

/** Claim an event id. Returns false if we have already handled it. */
async function claim(messageId) {
  const r = await q(
    `insert into seen_event (message_id) values ($1)
     on conflict (message_id) do nothing returning message_id`,
    [messageId]
  );
  return r.rowCount === 1;
}

/**
 * Find or create the person behind a respond.io contact.
 * The mobile number is the identity; respond_id is just the way back
 * into the inbox. A number learned later merges the records.
 */
async function person({ respondId, name, phone }) {
  const norm = (await q(`select norm_msisdn($1) n`, [phone])).rows[0].n;

  const byRespond = (await q(`select * from person where respond_id = $1`, [respondId])).rows[0];
  if (byRespond) {
    if (norm && !byRespond.msisdn) {
      const owner = (await q(`select id from person where msisdn = $1`, [norm])).rows[0];
      if (!owner) {
        await q(`update person set msisdn=$2, updated_at=now() where id=$1`, [byRespond.id, norm]);
        byRespond.msisdn = norm;
      } else if (owner.id !== byRespond.id) {
        // Two records, one human. Hand the quotes to the older record
        // and point this contact at it. Host App merges stay manual.
        await q(`update quote set person_id=$1 where person_id=$2`, [owner.id, byRespond.id]);
        await q(`update person set respond_id=$1 where id=$2`, [respondId, owner.id]);
        await q(`update person set respond_id=null where id=$1`, [byRespond.id]);
        return (await q(`select * from person where id=$1`, [owner.id])).rows[0];
      }
    }
    return byRespond;
  }

  if (norm) {
    const byPhone = (await q(`select * from person where msisdn = $1`, [norm])).rows[0];
    if (byPhone) {
      await q(`update person set respond_id=$2, display_name=coalesce($3,display_name),
               updated_at=now() where id=$1`, [byPhone.id, respondId, name]);
      return { ...byPhone, respond_id: respondId };
    }
  }

  return (await q(
    `insert into person (respond_id, msisdn, display_name) values ($1,$2,$3) returning *`,
    [respondId, norm, name]
  )).rows[0];
}

async function setCustCode(personId, custCode) {
  await q(`update person set cust_code=$2, updated_at=now() where id=$1`, [personId, custCode]);
}

/** The lock: what this person was already told, if it is still live. */
async function lockedPrice(personId, stockCode) {
  const r = await q(`select * from locked_price($1,$2)`, [personId, stockCode]);
  return r.rows[0]
    ? { price: Number(r.rows[0].price), since: r.rows[0].quoted_at,
        from: r.rows[0].channel_label, source: r.rows[0].source }
    : null;
}

async function recordQuote(row) {
  await q(
    `insert into quote (person_id, stock_code, part_name, price, source,
                        channel_id, channel_label, quoted_by, valid_until)
     values ($1,$2,$3,$4,$5,$6,$7,$8, now() + ($9 || ' hours')::interval)`,
    [row.personId, row.stockCode, row.partName, row.price, row.source || "srp",
     row.channelId ?? null, row.channelLabel ?? null, row.quotedBy || "ai",
     process.env.QUOTE_VALID_HOURS || "72"]
  );
}

async function logSearch(row) {
  const r = await q(
    `insert into search_log (person_id, respond_id, channel_id, raw_text,
                             extracted, results, result_count, latency_ms)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [row.personId ?? null, row.respondId ?? null, row.channelId ?? null, row.rawText,
     row.extracted ? JSON.stringify(row.extracted) : null,
     row.results ? JSON.stringify(row.results) : null,
     row.resultCount ?? null, row.latencyMs ?? null]
  );
  return r.rows[0].id;
}

async function logRun(row) {
  await q(
    `insert into agent_run (person_id, respond_id, channel_id, intent,
                            shadow, posted_kind, draft, failed)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [row.personId ?? null, row.respondId ?? null, row.channelId ?? null,
     row.intent ?? null, !!row.shadow, row.postedKind, row.draft ?? null,
     row.failed ?? null]
  );
}

module.exports = { pool, q, claim, person, setCustCode,
                   lockedPrice, recordQuote, logSearch, logRun };
