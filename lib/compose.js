/*
 * Turn real catalogue rows into (a) a staff note and (b) a draft reply.
 *
 * The rule the whole thing rests on: every figure in a customer-facing
 * draft must come from a row the database returned, or from a live
 * price lock. Nothing is derived, rounded or remembered. validate()
 * enforces it, and a draft that fails is thrown away rather than sent.
 */

const peso = (n) =>
  "₱" + Number(n).toLocaleString("en-PH",
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// SMS is GSM-7: one peso sign drops the segment from 160 to 70
// characters and you pay for three texts instead of one.
const plainPeso = (n) =>
  "PHP " + Number(n).toLocaleString("en-PH",
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const BRANCH = { 1: "Regalado", 2: "Commonwealth", 3: "Sudipen", 4: "Jowil Motors" };

const total = (row) => (row.stock || []).reduce((s, b) => s + Number(b.qty || 0), 0);

const stockLine = (row) => {
  const on = (row.stock || []).filter((b) => Number(b.qty) > 0);
  if (!on.length) return "no stock at any branch";
  return on.map((b) => `${b.name || BRANCH[b.branch] || b.branch} ${b.qty}`).join(", ");
};

/* ------------------------------------------------------------------ */
/* The staff note — this is what lands in the inbox by default         */
/* ------------------------------------------------------------------ */

function note({ fields, rows, locks, customer, personMsisdn, draft, shadow }) {
  const L = [];

  L.push("LOOKUP · " + (fields.intent || "other"));

  const asked = [fields.brand, fields.part, fields.make, fields.engine,
                 fields.position, fields.code && `code ${fields.code}`,
                 fields.qty && `${fields.qty} pcs`]
                .filter(Boolean).join(" · ");
  if (asked) L.push("Asked: " + asked);

  L.push(customer
    ? `Customer: ${customer.cust_name} (${customer.cust_code})`
      + (Number(customer.open_balance) > 0
          ? ` — OPEN BALANCE ${peso(customer.open_balance)}` : " — no balance")
      + (Number(customer.terms) > 0 ? ` · ${customer.terms} day terms` : "")
    : `Customer: no record${personMsisdn ? "" : " · no mobile number yet"}`);

  L.push("");

  if (!rows.length) {
    L.push("No catalogue match. Needs a person — try another wording or ask");
    L.push("for the part number.");
  } else {
    rows.slice(0, 5).forEach((r, i) => {
      const lock = locks[r.stock_code];
      L.push(`${i + 1}. ${r.part_name}${r.brand ? " · " + r.brand : ""}`);
      L.push(`   ${r.stock_code}${r.part_no ? " / " + r.part_no : ""}`
             + `   ${peso(lock ? lock.price : r.price)}`
             + (lock ? `  [LOCKED — quoted ${peso(lock.price)} on `
                       + `${lock.from || "another channel"}]` : ""));
      L.push(`   ${stockLine(r)}`);
    });
    if (rows.length > 5) L.push(`   ... and ${rows.length - 5} more matches`);
  }

  if (fields.note) { L.push(""); L.push("Note: " + fields.note); }

  if (draft) {
    L.push("");
    L.push(shadow ? "DRAFT (shadow mode — not sent):" : "SENT:");
    L.push(draft);
  } else {
    L.push("");
    L.push("No draft written — this one needs you.");
  }

  return L.join("\n");
}

/* ------------------------------------------------------------------ */
/* The customer draft                                                  */
/* ------------------------------------------------------------------ */

/** Money or credit is never the agent's call. */
function needsHuman(fields, customer) {
  if (["credit_terms", "return", "follow_up"].includes(fields.intent)) return true;
  if (customer && Number(customer.open_balance) > 0) return true;
  return false;
}

function draftReply({ fields, rows, locks, style, name }) {
  const money = style === "sms" ? plainPeso : peso;
  const first = name ? name.split(" ")[0] : null;

  if (fields.intent === "store_info") {
    return style === "sms"
      ? "Open 8am-5pm Mon-Sat, closed Sunday. Regalado, Commonwealth and Sudipen branches."
      : `${first ? "Hi " + first + "! " : ""}We're open 8:00am to 5:00pm, Monday to Saturday, closed Sunday.`;
  }

  if (!rows.length) return null;

  const r = rows[0];
  const price = locks[r.stock_code] ? locks[r.stock_code].price : r.price;
  const have = total(r) > 0;

  if (style === "sms") {
    // One segment. Price and stock, nothing else.
    const s = `${r.part_name}${r.brand ? " " + r.brand : ""}: ${money(price)}. `
            + (have ? `Available: ${stockLine(r)}.` : "Out of stock, can order.");
    return s.length <= 160 ? s : s.slice(0, 157) + "...";
  }

  const L = [];
  L.push(`${first ? "Hi " + first + "! " : ""}`
         + `${r.part_name}${r.brand ? " (" + r.brand + ")" : ""} is ${money(price)}, VAT inclusive.`);
  L.push("");
  L.push(have ? `Stock: ${stockLine(r)}.` : "Wala pong stock ngayon — pwede po namin i-order.");

  // Only offer an alternative that genuinely came back from the search.
  const alt = rows.find((x) =>
    x.stock_code !== r.stock_code &&
    (x.equiv_group && x.equiv_group === r.equiv_group) && total(x) > 0);
  if (alt) {
    L.push("");
    L.push(`May equivalent din po: ${alt.part_name}`
           + `${alt.brand ? " (" + alt.brand + ")" : ""} at `
           + `${money(locks[alt.stock_code] ? locks[alt.stock_code].price : alt.price)}.`);
  }

  L.push("");
  L.push("Gusto po ba namin i-reserve?");
  return L.join("\n");
}

/* ------------------------------------------------------------------ */
/* The guard                                                           */
/* ------------------------------------------------------------------ */

/**
 * Every peso figure in the draft must match a returned row's price or a
 * live lock, to the centavo. A draft that fails this is dropped, not
 * repaired — a wrong price to a trade account costs more than a slow
 * reply.
 */
function validate(draft, rows, locks) {
  if (!draft) return { ok: true };

  const allowed = new Set();
  for (const r of rows) {
    allowed.add(Number(r.price).toFixed(2));
    const l = locks[r.stock_code];
    if (l) allowed.add(Number(l.price).toFixed(2));
  }

  const found = draft.match(/(?:₱|PHP\s*)\s*([\d,]+(?:\.\d{1,2})?)/g) || [];
  for (const f of found) {
    const n = Number(f.replace(/[^\d.]/g, ""));
    if (!allowed.has(n.toFixed(2))) {
      return { ok: false, reason: `figure ${f} is not in the search results` };
    }
  }

  // Cost must never appear. If it somehow did, these words would be how.
  if (/\b(cost|net cost|margin|markup|supplier price)\b/i.test(draft)) {
    return { ok: false, reason: "draft mentions cost" };
  }
  return { ok: true };
}

module.exports = { note, draftReply, needsHuman, validate, peso, plainPeso, stockLine, total };
