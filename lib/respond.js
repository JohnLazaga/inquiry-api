/*
 * respond.io client.
 *
 * Two ways back into the inbox:
 *   comment(..) — an internal note only staff see. The default.
 *   message(..) — a real message to the customer. Gated.
 *
 * Verified against the docs: POST /v2/contact/{identifier}/message with
 * {channelId, message:{type:"text", text}}; identifiers are id:, phone:
 * or email:. The comment path and the Bearer scheme are the shapes
 * respond.io uses elsewhere — confirm both against your own account
 * before trusting them in prod (see README).
 */

const BASE = () => (process.env.RESPOND_BASE || "https://api.respond.io/v2").replace(/\/$/, "");

async function call(path, body) {
  const res = await fetch(`${BASE()}${path}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.RESPOND_TOKEN}`
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`respond.io ${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

/** Internal note on the contact. Nobody outside the team sees it. */
const comment = (contactId, text) =>
  call(`/contact/id:${contactId}/comment`, { text });

/** Customer-facing message. channelId null = last channel they used. */
const message = (contactId, text, channelId = null) =>
  call(`/contact/id:${contactId}/message`,
       { channelId, message: { type: "text", text } });

/**
 * Normalize the webhook body into the handful of fields we use.
 * respond.io's payloads vary a little by event and channel, so read
 * defensively rather than assuming one shape.
 */
function parseEvent(body) {
  const c = body.contact || body.data?.contact || {};
  const m = body.message || body.data?.message || {};

  const text = m.message?.text ?? m.text ?? body.text ?? "";
  const id   = m.messageId ?? m.id ?? body.messageId ?? body.eventId;

  return {
    event:     body.event_type || body.event || body.type || "message.received",
    messageId: id ? String(id) : null,
    contactId: c.id ?? body.contactId ?? null,
    name:      [c.firstName, c.lastName].filter(Boolean).join(" ") || c.name || null,
    phone:     c.phone ?? null,
    email:     c.email ?? null,
    channelId: m.channelId ?? body.channelId ?? c.lastChannelId ?? null,
    traffic:   m.traffic ?? body.traffic ?? "incoming",
    text:      String(text || "").trim()
  };
}

/** Style per channel: "sms" is GSM-7 and 160 chars; everything else rich. */
function channelStyle(channelId) {
  let map = {};
  try { map = JSON.parse(process.env.CHANNEL_STYLE || "{}"); } catch {}
  return map[String(channelId)] === "sms" ? "sms" : "rich";
}

module.exports = { comment, message, parseEvent, channelStyle };
