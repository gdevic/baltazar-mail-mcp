// AI access: lets an AI assistant on the same computer work with this mailbox through the open
// mail tab. The assistant starts an MCP server (server/baltazar-mail-mcp.mjs, which a build
// carries in the extension's own folder), which listens on one port of the loopback address; this
// module, once the user switches AI access on in Settings, asks that server for work, does it in
// the page, and answers. Pairing and the signing of every message are in mcpwire.js.
//
// The app's own source knows nothing of this module. The build lays it over the app's (see
// tools/build.js): glue appended to mail.js and compose.js hands it what it needs of them (init,
// composer), and it adds its section to Settings itself.
//
// What the assistant can ask for is the table OPS and nothing else. It reads and organises mail
// and prepares drafts; it has no way to send a message, to delete one for good or to empty a
// folder, because no entry here does that. A message's text is data the assistant reads: nothing
// in this module acts on what a message says. Reading goes to the adapter directly: it changes
// neither what the user is looking at nor what is marked read. A change goes the way the app's
// own action goes, so it shows at once and is an entry of the undo history.
import * as api from "./api.js";
import { open, isCode, newCode, rowShaper, BACKOFF } from "./mcpwire.js";
import { parse, check, nativeQuery, evaluate } from "./query.js";
import { arrange } from "./thread.js";
import { isOpen, close, parseAddrs } from "./compose.js";
import * as contacts from "./contacts.js";
import { noBidi, esc } from "./text.js";
import { copyText } from "./guide.js";

const $ = id => document.getElementById(id);
const shape = rowShaper(noBidi);
// In chrome.storage.local, apart from the app's settings: the pairing code, and whether AI access is on.
const CODE_KEY = "mcpCode", ON_KEY = "mcpOn";
let mail = null, pen = null;    // what the glue in mail.js and in compose.js hands over
let code = "", on = false, running = null, phase = "off", nudge = null;

// What Settings says of the connection, in the row under the switch.
const SAYS = {
  off: "",
  queued: "Another Baltazar Mail tab holds the connection.",
  waiting: "Waiting for the assistant's server.",
  connected: "Connected.",
  code: "The server has a different code.",
  version: "The server is another version.",
};

export function composer(hooks) { pen = hooks; }
export async function init(hooks) {
  mail = hooks;
  const kept = await chrome.storage.local.get([CODE_KEY, ON_KEY]);
  code = kept[CODE_KEY] || ""; on = !!kept[ON_KEY];
  drawSettings();
  // a tab that comes into view, or whose Settings open, looks for the server at once
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") nudge?.(); });
  new MutationObserver(() => { if (!$("settings").classList.contains("hidden")) { nudge?.(); syncSettings(); } }).observe($("settings"), { attributes: true, attributeFilter: ["class"] });
  if (on && isCode(code)) start();
}

function setPhase(p) { phase = p; syncSettings(); }

// One tab of this extension holds the bridge (a lock); another tab waits until that one closes.
function start() {
  if (running) return;
  const mine = running = new AbortController();
  setPhase("queued");
  navigator.locks.request("baltazar-mcp", { signal: mine.signal }, () => serve(mine.signal)).catch(() => {});
}
function stop() {
  running?.abort(); running = null;
  nudge?.();
  setPhase("off");
}

// A wait that ends early when the tab is nudged (it came into view, Settings opened, the code
// changed) or stopped.
const pause = (ms, signal) => new Promise(done => {
  const end = () => { clearTimeout(t); signal.removeEventListener("abort", end); nudge = null; done(); };
  const t = setTimeout(end, ms);
  signal.addEventListener("abort", end);
  nudge = end;
});

// Pairs with the server and does what it asks, one command at a time, until stopped. When no
// server answers, or it holds another code, it looks again after a wait that grows to half a
// minute; a signed-out tab waits for the sign-in.
async function serve(signal) {
  for (let tries = 0; !signal.aborted;) {
    if (!mail.ready()) { setPhase("waiting"); await pause(3000, signal); continue; }
    try {
      const account = mail.account();
      const s = await open(code, { signal });
      await s.call("/join", { role: "tab", provider: api.PROVIDER.id, account, app: chrome.runtime.getManifest().name, version: chrome.runtime.getManifest().version });
      setPhase("connected"); tries = 0;
      // another account, or none, in this tab ends the session: the next one names the new account
      while (mail.ready() && mail.account() === account) {
        const r = await s.call("/next");
        for (const c of r.cmds || []) await s.call("/done", { id: c.id, ...(await perform(c, s)) });
      }
    } catch (e) {
      if (signal.aborted) break;
      setPhase(e?.why === "code" ? "code" : e?.why === "version" ? "version" : "waiting");
    }
    if (signal.aborted) break;
    await pause(BACKOFF[Math.min(tries++, BACKOFF.length - 1)], signal);
  }
}

async function perform(c, session) {
  const op = Object.hasOwn(OPS, c.op) ? OPS[c.op] : null;
  if (!op) return { ok: false, code: "bad_request", message: `This copy of Baltazar Mail has no "${String(c.op).slice(0, 40)}"; it may be older than the assistant's server.` };
  if (!mail.ready()) return { ok: false, code: "signed_out", message: "not signed in" };
  try { return { ok: true, result: await op(c.args && typeof c.args === "object" ? c.args : {}, session) }; }
  catch (e) { return { ok: false, code: e instanceof api.NotSignedIn ? "signed_out" : "failed", message: String(e?.message || e).slice(0, 500) }; }
}

// ---------- what an assistant can ask for ----------
const FOLDER_TYPES = { INBOX: "inbox", DRAFT: "drafts", SENT: "sent", ARCHIVE: "archive", BULK: "spam", TRASH: "trash" };
// A message's text goes out this many characters at a time; an attachment of more bytes than
// this is not fetched; this many of the rows shown are remembered; one change takes this many
// messages at most.
const TEXT_PAGE = 12000, BLOB_MAX = 30 * 1048576, ROWS_KEPT = 2000, IDS_MAX = 100;

const whole = (v, least, most, or) => { const n = Math.trunc(Number(v ?? or)); return Number.isFinite(n) ? Math.min(most, Math.max(least, n)) : or; };
const paging = a => ({ limit: whole(a.limit, 1, 50, 20), offset: whole(a.offset, 0, 1e6, 0) });
const visible = () => mail.folders().filter(f => !mail.isHidden(f));
const folderRow = f => ({ id: String(f.id), name: mail.folderName(f), type: FOLDER_TYPES[mail.folderType(f)] || "", unread: f.unread || 0, total: f.total || 0 });
// The folder an assistant names: by its id, by the word for a system folder, or by its full name.
function folderOf(want) {
  const w = String(want ?? "").trim(), low = w.toLowerCase(), all = visible();
  const type = Object.keys(FOLDER_TYPES).find(t => FOLDER_TYPES[t] === low);
  const named = all.filter(f => mail.folderName(f).toLowerCase() === low);
  const f = all.find(x => String(x.id) === w) || (type && mail.folderByType(type)) || (named.length === 1 ? named[0] : null);
  if (!f) throw new Error(`No folder "${w.slice(0, 80)}". Give an id or a full name from list_folders, or inbox, drafts, sent, archive, spam or trash.`);
  return f;
}
// One part of a folder's path, as the assistant gives a new folder's name.
const leaf = v => String(v ?? "").trim().slice(0, 200);

// The rows an assistant was shown, as the adapter gave them, so a later call that names one by
// its id has the row to work from.
const shownRows = new Map();
function rowsOut(list) {
  for (const m of list) { shownRows.delete(m.id); shownRows.set(m.id, m); }
  while (shownRows.size > ROWS_KEPT) shownRows.delete(shownRows.keys().next().value);
  return list.map(shape);
}

function idOf(a) {
  const id = String(a.id ?? "").trim();
  if (!id) throw new Error("Which message? Give its id.");
  return id;
}
const GONE = "That message no longer exists.";
async function bodyOf(id) {
  try { return await api.body(id); }
  catch (e) { if (api.isGone(e)) throw new Error(GONE); throw e; }
}
// The rows of the messages a change names: those shown, and for the others the message as it is now.
async function rowsFor(given) {
  const ids = [...new Set((Array.isArray(given) ? given : [given]).map(x => String(x ?? "").trim()).filter(Boolean))];
  if (!ids.length) throw new Error("Which messages? Give their ids.");
  if (ids.length > IDS_MAX) throw new Error(`At most ${IDS_MAX} messages at a time.`);
  for (const id of ids) if (!shownRows.has(id)) rowsOut([(await bodyOf(id)).message]);
  return ids.map(id => shownRows.get(id));
}
// A message's files, as the reader lists them: not the pictures it shows in its text.
const filesOf = r => (r.attachments || []).filter(a => a.disposition !== "inline" && a.partId);
const typeOf = a => [a.type, a.subtype].filter(Boolean).join("/").toLowerCase();

// The HTML without what its own inline styles hide from a reader: text an assistant would read
// and the user never sees. What a style sheet hides is not known here.
function shown(html) {
  const tpl = document.createElement("template");      // inert: nothing in it loads
  tpl.innerHTML = html;
  for (const el of tpl.content.querySelectorAll("style, [hidden], [style]")) {
    const s = el.style, zero = v => v !== "" && parseFloat(v) === 0;
    if (el.localName === "style" || el.hasAttribute("hidden") || s.display === "none" || s.visibility === "hidden" || s.visibility === "collapse" || zero(s.opacity) || zero(s.fontSize)
      || ((zero(s.maxHeight) || zero(s.height) || zero(s.maxWidth) || zero(s.width)) && /hidden|clip/.test(s.overflow))) el.remove();
  }
  return tpl.innerHTML;
}

// What an assistant writes as HTML keeps its words, their emphasis, lists, tables and links, and
// nothing else: no picture, no style, nothing that loads or runs.
const WRITTEN = ["a", "b", "strong", "i", "em", "u", "s", "p", "div", "span", "br", "hr", "ul", "ol", "li", "blockquote", "pre", "code", "h1", "h2", "h3", "h4", "table", "thead", "tbody", "tr", "td", "th"];
const written = html => globalThis.DOMPurify.sanitize(html, { ALLOWED_TAGS: WRITTEN, ALLOWED_ATTR: ["href", "colspan", "rowspan"], ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i, ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false });
const MODES = { new: "new", reply: "reply", reply_all: "replyAll", forward: "forward" };
// Addresses as an assistant gives them: a list, or one line, of "name <address>" or plain addresses.
const people = v => v == null || v === "" || (Array.isArray(v) && !v.length) ? null : parseAddrs(Array.isArray(v) ? v.join(", ") : String(v));

const OPS = {
  // as the folder pane has them after its last check of the mailbox: no request is made
  folders: async () => visible().map(folderRow),

  // one more row is asked for than is given, which tells whether more exist
  messages: async a => {
    const f = folderOf(a.folder ?? "inbox"), { limit, offset } = paging(a);
    const r = await api.list(f.id, limit + 1, offset);
    return { folder: String(f.id), messages: rowsOut(r.messages.slice(0, limit)), more: r.messages.length > limit };
  },

  // The search of the search box: a query the provider answers in one request pages there; a
  // compound one query.js evaluates whole, and the page is cut from that.
  search: async a => {
    const { limit, offset } = paging(a);
    let ast;
    try { ast = parse(String(a.query ?? "").trim()); check(ast, api.dialect); } catch (e) { throw new Error(`Could not search: ${e.message}.`); }
    if (!ast) throw new Error("Nothing to search for.");
    let scope = null;
    if (a.folder != null && a.folder !== "") { const f = folderOf(a.folder); scope = { ids: [f.id, ...mail.subfolders(f).filter(x => !mail.isHidden(x)).map(x => x.id)] }; }
    const nq = nativeQuery(ast, api.dialect);
    if (nq) {
      const r = scope ? await api.searchScoped(nq, { include: scope }, limit + 1, offset) : await api.search(nq, limit + 1, offset);
      return { messages: rowsOut(r.messages.slice(0, limit)), more: r.messages.length > limit };
    }
    const r = await evaluate(ast, (q, n) => api.query(q, n).then(x => x.messages), api.scopeFilter({ include: scope }), api.dialect);
    return { messages: rowsOut(r.messages.slice(offset, offset + limit)), more: r.messages.length > offset + limit, ...(r.truncated ? { truncated: true } : {}) };
  },

  // The text is what the reader would show, made plain: cleaned as the reader cleans it, without
  // what the message hides, links with their addresses.
  message: async a => {
    const id = idOf(a), r = await bodyOf(id);
    const html = shown(mail.cleanHtml(r.html || "", r)), text = a.html ? html : html ? pen.toText(html) : String(r.text || "");
    const from = Math.min(text.length, whole(a.offset, 0, 1e9, 0));
    let to = Math.min(text.length, from + TEXT_PAGE);
    if (to < text.length && (text.charCodeAt(to - 1) & 0xfc00) === 0xd800) to--;      // not between the two halves of one character
    const { snippet, attachments, ...row } = shape(r.message);
    if (!row.folder && shownRows.has(id)) row.folder = shape(shownRows.get(id)).folder;
    if (!shownRows.has(id)) rowsOut([r.message]);
    return { ...row, attachments: filesOf(r).map(f => ({ part: String(f.partId), name: noBidi(f.filename || ""), type: typeOf(f), size: f.size || 0 })),
      offset: from, length: text.length, more: to < text.length, ...(to < text.length ? { next_offset: to } : {}), text: text.slice(from, to) };
  },

  // The provider's conversation of the message, arranged as the conversation view arranges it;
  // the message itself is among its rows also when the provider leaves it out (Spam, Trash).
  conversation: async a => {
    const id = idOf(a), m = shownRows.get(id) || (await bodyOf(id)).message;
    const r = await api.conversation(m);
    const all = r.messages.some(x => x.id === m.id) ? r.messages : [...r.messages, m];
    rowsOut(all);
    return arrange(all, api.refsOf).map(({ row, depth }) => ({ ...shape(row), depth }));
  },

  // The bytes go to the server apart from this answer, which names their length and SHA-256.
  attachment: async (a, session) => {
    const id = idOf(a), r = await bodyOf(id), f = filesOf(r).find(x => String(x.partId) === String(a.part ?? ""));
    if (!f) throw new Error("That message has no attachment with that part. read_message lists a message's attachments.");
    const large = "That attachment is too large to fetch.";
    if ((f.size || 0) > BLOB_MAX) throw new Error(large);
    const got = await api.partBytes(id, f);
    if (got.bytes.byteLength > BLOB_MAX) throw new Error(large);
    await session.put(String(a.token ?? ""), got.bytes);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", got.bytes));
    return { name: noBidi(f.filename || got.filename || ""), type: String(got.type || "").includes("/") ? String(got.type).toLowerCase() : typeOf(f), size: got.bytes.byteLength,
      sha256: [...digest].map(b => b.toString(16).padStart(2, "0")).join("") };
  },

  contacts: async a => (await contacts.suggest(String(a.query ?? ""), whole(a.limit, 1, 50, 10))).map(c => ({ name: noBidi(c.name || ""), email: c.email })),

  // ---------- changes: each an entry of the undo history, which begins "AI:" ----------
  mark: async a => {
    const read = typeof a.read === "boolean", starred = typeof a.starred === "boolean";
    if (!read && !starred) throw new Error("Say what to change: read or starred, each true or false.");
    const rows = await rowsFor(a.ids), out = {};
    if (read) out.read = await mail.setFlag(rows, "read", a.read);
    if (starred) out.starred = await mail.setFlag(rows, "flagged", a.starred);
    return out;
  },

  // Trash is a folder like another: a message moved there is in Trash, and can be moved back.
  move: async a => {
    const dest = folderOf(a.to);
    if (["DRAFT", "SENT"].includes(mail.folderType(dest))) throw new Error("Messages are not moved into Drafts or Sent.");
    return mail.move(await rowsFor(a.ids), dest);
  },

  createFolder: async a => {
    const made = await mail.createFolder(leaf(a.name), a.parent == null || a.parent === "" ? null : folderOf(a.parent));
    if (!made) throw new Error("The folder was made, but the mailbox does not list it yet.");
    return folderRow(made);
  },
  renameFolder: async a => {
    const now = await mail.renameFolder(folderOf(a.folder), leaf(a.name));
    if (!now) throw new Error("The folder was renamed, but the mailbox does not list it yet.");
    return folderRow(now);
  },

  // A message written for the user to send: the composer opens as it does for the user (the
  // signature, and for a reply or forward the quoted original), takes what the assistant wrote,
  // and saves to Drafts. It stays open for the user unless asked not to. A message the user is
  // writing is never put away for it.
  draft: async a => {
    const mode = MODES[a.mode ?? "new"];
    if (!mode) throw new Error("mode is new, reply, reply_all or forward.");
    const id = mode === "new" ? null : idOf(a);
    const to = people(a.to), cc = people(a.cc), bcc = people(a.bcc), body = String(a.body ?? "").replace(/\r\n?/g, "\n");
    if (mode === "new" && !to && !body.trim() && !String(a.subject ?? "").trim()) throw new Error("Nothing to draft: give recipients, a subject or a body.");
    if (isOpen()) throw new Error("A message is being written in the mail tab, so it was left alone. Ask the user to finish or close it first.");
    const focused = document.activeElement;
    let opened;
    try { opened = await mail.openComposer(mode, id); } catch (e) { if (api.isGone(e)) throw new Error(GONE); throw e; }
    if (!opened) throw new Error("The composer could not be opened.");
    const html = a.html ? written(body) : body.split("\n").map(l => `<div>${esc(l) || "<br>"}</div>`).join("");
    pen.fill({ to, cc, bcc, subject: a.subject == null ? null : String(a.subject), html, text: a.html ? pen.toText(html) : body });
    const why = await pen.save();
    if (why) throw new Error(`The message is open in the mail tab but could not be saved to Drafts: ${why}`);
    const out = { id: pen.savedId(), opened: a.open !== false };
    if (!out.opened) { await close(false); focused?.focus?.(); }
    mail.draftsChanged();
    return out;
  },
};

// ---------- Settings ----------
// A section of its own, put in before the update note: the switch and, while it is on, one row
// with what the connection is doing, the pairing code and Copy. The code can be typed over (a
// mailbox can take another's code); emptied, it is made anew.
function drawSettings() {
  const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  const box = el("div", { id: "mcp-set" });
  const tick = el("input", { type: "checkbox", id: "mcp-on" });
  const label = el("label", { title: "An assistant that speaks MCP, such as Claude Code, reaches this tab through a small server it runs on this computer. It can read and organise your mail and prepare drafts; it cannot send, and what it changes can be undone here. The tab must stay open." },
    tick, " Let an assistant on this computer read and organise mail, and prepare drafts for you to send");
  const said = el("span", { id: "mcp-status", role: "status" });
  const field = el("input", { id: "mcp-code", spellcheck: false, autocomplete: "off", maxLength: 32, size: 34, title: "The pairing code. Copy it, then run the server's setup, which takes it from the clipboard. Empty the box for a new one." });
  field.setAttribute("aria-label", "Pairing code");
  const copy = el("button", { type: "button", id: "mcp-copy", textContent: "Copy", title: "Copy the pairing code" });
  box.append(el("b", { textContent: "AI access" }), label, el("div", { className: "set-row", id: "mcp-row" }, said, field, copy));
  $("update-note").before(box);
  tick.onchange = async () => {
    if (tick.checked && !isCode(code)) await setCode(newCode());
    on = tick.checked;
    await chrome.storage.local.set({ [ON_KEY]: on });
    if (on) start(); else stop();
    syncSettings();
  };
  field.onchange = async () => {
    const typed = field.value.trim().toLowerCase();
    if (typed && !isCode(typed)) { field.value = code; said.textContent = "A code is 32 digits and letters a to f."; return; }
    if (typed === code) return;
    await setCode(typed || newCode());
    if (running) { stop(); start(); }
    syncSettings();
  };
  copy.onclick = () => copyText(code, copy, null).catch(() => { field.select(); });
  syncSettings();
}
async function setCode(c) { code = c; await chrome.storage.local.set({ [CODE_KEY]: c }); }

function syncSettings() {
  if (!$("mcp-on")) return;
  $("mcp-on").checked = on;
  $("mcp-row").classList.toggle("hidden", !on);
  $("mcp-status").textContent = SAYS[on ? phase : "off"] || "";
  if (document.activeElement !== $("mcp-code")) $("mcp-code").value = code;
}
