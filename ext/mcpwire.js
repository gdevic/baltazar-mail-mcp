// AI access, the part that needs no page and no other module: how the mail tab and the MCP server
// an AI assistant runs on the same computer (server/baltazar-mail-mcp.mjs) prove to each other
// that they hold the same pairing code, how every message after that is signed, and the one shape
// a message row takes for an assistant, whichever edition it comes from.
//
// The pairing code (32 hex digits, made in Settings) never travels. The tab sends a number of its
// own and the code's id (a server holds one code for each mailbox, and the id tells it which is
// meant without telling the code); the server answers with a number of its own and a proof, the
// HMAC of both numbers under the code, which the tab checks before it says anything about itself. Both sides then derive a session key from
// the code and the two numbers, and every later message is "<mac>\n<json>": the HMAC, under the
// session key, of the direction, the path and the JSON. The JSON carries the session and a count
// that only rises, so a message can be neither forged nor sent again, and an answer echoes the
// count of what it answers. A program that takes the server's port later holds no session key.
export const PORT = 18417;
export const WIRE = 1;
// What this copy of the page's side can do, as a number that rises with each thing added to it (a
// command, or an argument of one). The tab tells it when it joins, and the server refuses a call
// that needs more than the tab has, in words that say to reload the extension: a browser goes on
// running the copy it loaded while the files and the server beside them are replaced. A tab that
// tells none has 0. 1: the message being written read, added to and reopened from Drafts, the line
// named for what is added, and an argument the page does not know refused, not passed over.
// 2: what the user has selected corrected in place, or rewritten.
export const LEVEL = 2;
// How long the tab waits before it looks for a server again (ms): each wait once, then the last.
export const BACKOFF = [1000, 3000, 10000, 30000];

const HEX = /^[0-9a-f]{32}$/;
export const isCode = s => typeof s === "string" && HEX.test(s);
const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
export const nonce = () => hex(crypto.getRandomValues(new Uint8Array(16)));
export const newCode = nonce;

const enc = new TextEncoder();
const keyOf = bytes => crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
const mac = async (key, text) => new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(text)));
export async function idOf(code) { return hex(await mac(await keyOf(enc.encode(code)), `baltazar-mcp ${WIRE} id`)).slice(0, 16); }
export async function proofOf(code, cn, sn) { return hex(await mac(await keyOf(enc.encode(code)), `baltazar-mcp ${WIRE} server\n${cn}\n${sn}`)); }
export async function sessionKey(code, cn, sn) { return keyOf(await mac(await keyOf(enc.encode(code)), `baltazar-mcp ${WIRE} session\n${cn}\n${sn}`)); }

// dir: "c" for what the tab (or a relaying server) sends, "s" for what the server answers.
export async function seal(key, dir, path, obj) {
  const json = JSON.stringify(obj);
  return `${hex(await mac(key, `${dir}\n${path}\n${json}`))}\n${json}`;
}
// The object of a sealed message, or null when its mac is not the one the key gives.
export async function unseal(key, dir, path, body) {
  if (typeof body !== "string" || body[64] !== "\n") return null;
  const json = body.slice(65), want = hex(await mac(key, `${dir}\n${path}\n${json}`));
  let differ = 0;                // every digit is compared, wherever the first difference is
  for (let i = 0; i < 64; i++) differ |= want.charCodeAt(i) ^ body.charCodeAt(i);
  if (differ) return null;
  try { return JSON.parse(json); } catch { return null; }
}

// why: "unreachable" (no server answers), "refused" (it answered with an error), "version" (it
// speaks another version of this), "code" (it holds a different code, or is another program),
// "forged" (an answer that is not the server's), "stopped" (the caller's signal ended the wait).
export class WireError extends Error {
  constructor(why, detail = "") { super(detail ? `${why}: ${detail}` : why); this.name = "WireError"; this.why = why; }
}

// A session with the server at base: sid, call(path, obj) for a signed exchange, and put(token,
// bytes) for an attachment's bytes, which go as they are under a token the server gave for them.
export async function open(code, { base = `http://127.0.0.1:${PORT}`, fetch = globalThis.fetch, signal } = {}) {
  const post = async (path, body, sig) => {
    let r;
    try { r = await fetch(base + path, { method: "POST", body, signal: sig, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" }); }
    catch (e) { throw new WireError(sig?.aborted ? "stopped" : "unreachable", e?.message); }
    const text = await r.text().catch(() => "");
    if (!r.ok) throw new WireError("refused", `${r.status} ${text.slice(0, 100)}`.trim());
    return text;
  };
  const cn = nonce();
  let a;
  try { a = JSON.parse(await post("/hello", JSON.stringify({ v: WIRE, cn, kid: await idOf(code) }), signal)); } catch (e) { if (e instanceof WireError) throw e; throw new WireError("code"); }
  if (a?.v !== WIRE) throw new WireError("version", String(a?.v));
  if (!HEX.test(a.sn) || a.proof !== await proofOf(code, cn, a.sn)) throw new WireError("code");
  const key = await sessionKey(code, cn, a.sn);
  let n = 0;
  return {
    sid: a.sn,
    async call(path, obj = {}, sig = signal) {
      const mine = ++n;
      const out = await unseal(key, "s", path, await post(path, await seal(key, "c", path, { sid: a.sn, n: mine, ...obj }), sig));
      if (!out || out.n !== mine) throw new WireError("forged");
      return out;
    },
    async put(token, bytes, sig = signal) { if (!HEX.test(token)) throw new WireError("refused", "token"); await post(`/blob/${token}`, bytes, sig); },
  };
}

// ---------- rows ----------
// A message row as an assistant gets it. Search results mark their hits in the subject (^_), which
// goes; date is ISO 8601, or empty when the message has none that can be read; attachments counts
// the files, as the list does: not the pictures a message shows in its text.
// noBidi: the app's own removal of direction controls from text that mail supplies (text.js).
export const rowShaper = noBidi => function shape(m) {
  const person = a => a?.name && a.name !== a.email ? `${noBidi(a.name)} <${a.email || ""}>` : String(a?.email || "");
  const people = list => (Array.isArray(list) ? list : []).map(person).filter(Boolean);
  const h = m?.headers || {}, d = new Date(Number(h.date) * 1000);
  const out = {
    id: String(m?.id ?? ""), folder: m?.folder?.id != null ? String(m.folder.id) : "",
    from: people(h.from), to: people(h.to),
    subject: noBidi(h.subject || "").replace(/\^_/g, ""),
    date: Number(h.date) > 0 && !isNaN(d) ? d.toISOString() : "",
    snippet: noBidi(m?.snippet || "").replace(/\s+/g, " ").trim().slice(0, 200),
    read: !!m?.flags?.read, starred: !!m?.flags?.flagged,
    attachments: Array.isArray(m?.attachments) ? m.attachments.filter(a => a?.disposition !== "inline").length : (m?.attachmentCount || 0),
  };
  if (h.cc?.length) out.cc = people(h.cc);
  if (h.bcc?.length) out.bcc = people(h.bcc);
  return out;
};
