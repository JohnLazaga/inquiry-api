/*
 * Read the inquiry. Taglish, typos, shorthand in; structured fields out.
 *
 * This is the one job the model is actually good at here. It does NOT
 * pick parts, quote prices or invent stock codes — it only turns
 * "paps meron ba kyb shokot for elf 4hf1 front, 4 pcs" into fields the
 * search RPC understands.
 */

const SYSTEM = `You read customer inquiries for a Philippine auto-parts
dealer and return structured search fields. Customers write in Tagalog,
English or a mix, with typos, shop slang and abbreviations.

Return ONLY a JSON object:

{
  "intent": "price_stock" | "order" | "follow_up" | "credit_terms"
          | "return" | "store_info" | "other",
  "brand":  string | null,   // KYB, 555, GMB, Bendix, Aisin, NOK, Koyo...
  "part":   string | null,   // catalogue wording: "shock absorber", not "shokot"
  "make":   string | null,   // Isuzu Elf, Fuso Canter, Toyota Hiace, L300...
  "engine": string | null,   // 4HF1, 4D56, 4D33, 2KD...
  "position": string | null, // front, rear, left, right
  "code":   string | null,   // a part or stock number typed verbatim
  "qty":    number | null,
  "note":   string | null    // anything a person needs to know, one line
}

Rules:
- Translate slang to catalogue wording in "part": shokot -> shock
  absorber, abrasadera -> hose clamp, rubber cup -> wheel cup,
  faninteb -> fan belt, bearing ng gulong -> wheel bearing.
- Keep engine codes verbatim, uppercased, no spaces: "4 hf1" -> "4HF1".
- "charge", "sa account namin", "terms" mean a credit customer:
  intent stays price_stock or order, and say so in "note".
- Asking for new credit terms is "credit_terms".
- Chasing an order already paid for is "follow_up".
- Null for anything not stated. Never guess a brand or an engine.
- No prose, no code fence. JSON only.`;

const SLANG = [
  [/\bshokot\b/gi, "shock absorber"],
  [/\babrasadera\b/gi, "hose clamp"],
  [/\bfaninteb\b/gi, "fan belt"],
  [/\brubber cup\b/gi, "wheel cup"]
];

/** Cheap pre-pass so the obvious slang never depends on the model. */
const preNormalize = (t) => SLANG.reduce((s, [re, to]) => s.replace(re, to), t);

async function extract(text) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5",
      max_tokens: 400,
      system: SYSTEM,
      messages: [{ role: "user", content: preNormalize(text) }]
    })
  });
  if (!res.ok) throw new Error(`extract failed: ${res.status} ${await res.text()}`);

  const raw = (await res.json()).content?.[0]?.text?.trim() || "{}";
  const json = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();

  let f;
  try { f = JSON.parse(json); }
  catch { return { intent: "other", note: "could not parse the inquiry" }; }

  // Normalize engine codes the same way the RPC does.
  if (f.engine) f.engine = String(f.engine).toUpperCase().replace(/\s+/g, "");
  if (f.qty != null) f.qty = Number(f.qty) || null;
  return f;
}

module.exports = { extract, preNormalize };
