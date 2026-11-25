// AI access: lets an AI assistant on the same computer work with this mailbox through the open
// mail tab. The assistant starts an MCP server (server/baltazar-mail-mcp.mjs, which a build
// carries in the extension's own folder), which listens on one port of the loopback address; this
// module, once the user switches AI access on in Settings, asks that server for work, does it in
// the page, and answers. Pairing and the signing of every message are in mcpwire.js.
//
// The app's own source knows nothing of this module. The build lays it over the app's (see
// tools/build.js): glue appended to mail.js and compose.js hands it what it needs of them (init,
// composer), and it adds its section to Settings and its marker to the header itself.
//
// What the assistant can ask for is the table OPS and nothing else. It reads and organises mail
// and prepares drafts; it has no way to send a message, to delete one for good or to empty a
// folder, because no entry here does that. A message's text is data the assistant reads: nothing
// in this module acts on what a message says. Reading goes to the adapter directly: it changes
// neither what the user is looking at nor what is marked read. A change goes the way the app's
// own action goes, so it shows at once and is an entry of the undo history.
import * as api from "./api.js";
import { open, isCode, newCode, rowShaper, BACKOFF, LEVEL } from "./mcpwire.js";
import { parse, check, nativeQuery, evaluate } from "./query.js";
import { arrange } from "./thread.js";
import { isOpen, close, parseAddrs } from "./compose.js";
import * as contacts from "./contacts.js";
import { noBidi, esc } from "./text.js";
import { copyText } from "./guide.js";

const $ = id => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
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
// What the marker in the header says of the connection, after "AI access:"; and, after "AI is",
// of the assistant's command while it is done, which it goes on saying this long after (ms), so
// that a command done in a moment is seen.
const MARKS = { off: "off", queued: "in another tab", waiting: "waiting", connected: "connected", code: "wrong code", version: "wrong version" };
const DOING = {
  folders: "listing folders", messages: "listing messages", search: "searching", message: "reading a message", conversation: "reading a conversation",
  attachment: "fetching an attachment", contacts: "looking up people", mark: "marking messages", move: "moving messages",
  createFolder: "making a folder", renameFolder: "renaming a folder", composing: "reading your draft",
  draft: a => a?.mode === "open_draft" ? "opening a draft" : "writing a draft",
};
const LINGER = 1500;
let doing = "", resting = 0;

export function composer(hooks) { pen = hooks; }
export async function init(hooks) {
  mail = hooks;
  const kept = await chrome.storage.local.get([CODE_KEY, ON_KEY]);
  code = kept[CODE_KEY] || ""; on = !!kept[ON_KEY];
  drawSettings(); drawMark();
  // a tab that comes into view, or whose Settings open, looks for the server at once
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") nudge?.(); });
  new MutationObserver(() => { if (!$("settings").classList.contains("hidden")) { nudge?.(); syncSettings(); } }).observe($("settings"), { attributes: true, attributeFilter: ["class"] });
  if (on && isCode(code)) start();
}

function setPhase(p) { phase = p; syncSettings(); syncMark(); }

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
      await s.call("/join", { role: "tab", provider: api.PROVIDER.id, account, app: chrome.runtime.getManifest().name, version: chrome.runtime.getManifest().version, level: LEVEL });
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
  const args = c.args && typeof c.args === "object" ? c.args : {}, known = ARGS[c.op];
  const strange = known && Object.keys(args).find(k => !known.includes(k));
  if (strange !== undefined) return { ok: false, code: "bad_request", message: `This copy of Baltazar Mail does not know "${String(strange).slice(0, 40)}" there, so it did nothing: it is older than the assistant's server. Ask the user to reload the extension (Reload on its card in the browser's extensions page) and to open the mail tab again.` };
  if (!mail.ready()) return { ok: false, code: "signed_out", message: "not signed in" };
  const does = DOING[c.op];
  clearTimeout(resting); doing = (typeof does === "function" ? does(args) : does) || "at work"; syncMark();
  try { return { ok: true, result: await op(args, session) }; }
  catch (e) { return { ok: false, code: e instanceof api.NotSignedIn ? "signed_out" : "failed", message: String(e?.message || e).slice(0, 500) }; }
  finally { resting = setTimeout(rested, LINGER); }
}
// The marker says the command until a draft that is being shown as typed has been.
function rested() {
  if (replaying) { resting = setTimeout(rested, 300); return; }
  doing = ""; syncMark();
}

// ---------- what an assistant can ask for ----------
const FOLDER_TYPES = { INBOX: "inbox", DRAFT: "drafts", SENT: "sent", ARCHIVE: "archive", BULK: "spam", TRASH: "trash" };
// A message's text goes out this many characters at a time; an attachment of more bytes than
// this is not fetched; this many of the rows shown are remembered; one change takes this many
// messages at most.
const TEXT_PAGE = 12000, BLOB_MAX = 30 * 1048576, ROWS_KEPT = 2000, IDS_MAX = 100;

// What marks the user's caret in the text of the message being written, for an assistant.
const CARET = "[CARET]";

const whole = (v, least, most, or) => { const n = Math.trunc(Number(v ?? or)); return Number.isFinite(n) ? Math.min(most, Math.max(least, n)) : or; };
// A text a part at a time: the part that begins at offset, the whole text's length, and where the
// next part begins when there is one.
function part(text, offset) {
  const from = Math.min(text.length, whole(offset, 0, 1e9, 0));
  let to = Math.min(text.length, from + TEXT_PAGE);
  if (to < text.length && (text.charCodeAt(to - 1) & 0xfc00) === 0xd800) to--;      // not between the two halves of one character
  return { offset: from, length: text.length, more: to < text.length, ...(to < text.length ? { next_offset: to } : {}), text: text.slice(from, to) };
}
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
// A link says where it leads: one whose words are themselves an address, but not the address it
// goes to, gets the address it goes to for its words.
function written(html) {
  const kept = document.createElement("template");      // inert: nothing in it loads
  kept.innerHTML = globalThis.DOMPurify.sanitize(html, { ALLOWED_TAGS: WRITTEN, ALLOWED_ATTR: ["href", "colspan", "rowspan"], ADD_URI_SAFE_ATTR: ["colspan", "rowspan"],
    ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i, ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false });
  const bare = host => host.toLowerCase().replace(/^www\./, "");
  for (const a of kept.content.querySelectorAll("a[href]")) {
    const goes = a.getAttribute("href").trim(), says = a.textContent.trim();
    if (/^mailto:/i.test(goes)) {
      const to = goes.slice(7).split("?")[0];
      if (/^[^\s@]+@[^\s@]+$/.test(says) && says.toLowerCase() !== decodeURIComponent(to).toLowerCase()) a.textContent = to;
      continue;
    }
    const named = says.match(/^(?:https?:\/\/)?((?:[\w-]+\.)+[a-z]{2,})(?:[/:?#]\S*)?$/i);
    let host = "";
    try { host = new URL(goes).hostname; } catch { /* no address a browser would follow */ }
    if (named && host && bare(named[1]) !== bare(host)) a.textContent = goes;
  }
  return kept.innerHTML;
}
const MODES = { new: "new", reply: "reply", reply_all: "replyAll", forward: "forward", continue: "continue", open_draft: "draft" };
// When a draft is to be opened and none is named: this many of the saved drafts are told of, each
// with this many characters of how its text begins, for the user to be asked which.
const DRAFTS_TOLD = 10, DRAFT_BEGINS = 400;
const given = v => v != null && v !== "" && !(Array.isArray(v) && !v.length);
// Addresses as an assistant gives them: a list, or one line, of "name <address>" or plain addresses.
const people = v => given(v) ? parseAddrs(Array.isArray(v) ? v.join(", ") : String(v)) : null;

// The arguments each command takes. One that is not among them is refused, not passed over: it
// comes from a server newer than this copy of the page, and it meant something there.
const ARGS = {
  folders: [], messages: ["folder", "limit", "offset"], search: ["query", "folder", "limit", "offset"], message: ["id", "offset", "html"], composing: ["offset"],
  conversation: ["id"], attachment: ["id", "part", "token"], contacts: ["query", "limit"], mark: ["ids", "read", "starred"], move: ["ids", "to"],
  createFolder: ["name", "parent"], renameFolder: ["folder", "name"], draft: ["mode", "id", "to", "cc", "bcc", "subject", "body", "html", "open", "after"],
};

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
    const { snippet, attachments, ...row } = shape(r.message);
    if (!row.folder && shownRows.has(id)) row.folder = shape(shownRows.get(id)).folder;
    if (!shownRows.has(id)) rowsOut([r.message]);
    return { ...row, attachments: filesOf(r).map(f => ({ part: String(f.partId), name: noBidi(f.filename || ""), type: typeOf(f), size: f.size || 0 })), ...part(text, a.offset) };
  },

  // The message the user is writing, as it stands in the composer, saved or not: read from the
  // page, with nothing of it changed. Its text is made plain as a message's is, without what its
  // quoted original hides, and has CARET where the user's caret is.
  composing: async a => {
    if (!isOpen()) return { open: false };
    const m = pen.look(CARET), person = p => p.name && p.name !== p.email ? `${noBidi(p.name)} <${p.email}>` : p.email;
    const text = (m.html != null ? pen.toText(shown(m.html)) : m.text).replaceAll("\u200B", "");
    return { open: true, kind: m.kind, from: m.from, to: m.to.map(person), ...(m.cc.length ? { cc: m.cc.map(person) } : {}), ...(m.bcc.length ? { bcc: m.bcc.map(person) } : {}),
      subject: noBidi(m.subject), format: m.html != null ? "html" : "text", attachments: m.files.map(f => noBidi(f || "")), caret: m.caret,
      ...(m.selected ? { selected: m.selected.slice(0, 2000) } : {}), ...part(text, a.offset) };
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
  // and saves to Drafts. It stays open for the user unless asked not to, and what the assistant
  // wrote is then shown as if typed (replay). A message the user is writing is never put away
  // for it.
  // The mode continue is for that message instead, and is never taken unasked: it adds what the
  // assistant wrote to the user's own text, after the line the caret is in or the line the
  // assistant names with after (glue/compose.js says exactly where), and changes nothing else
  // of the message, neither the user's text, its recipients nor its subject. What it added is
  // an entry of the undo history, as its other changes are. The message stays open, and is
  // saved as the composer's own autosave saves it; where that fails the text is in the message
  // all the same, so the answer says so instead of failing.
  draft: async a => {
    const mode = MODES[a.mode ?? "new"];
    if (!mode) throw new Error("mode is new, reply, reply_all, forward, continue or open_draft.");
    const body = String(a.body ?? "").replace(/\r\n?/g, "\n");
    const html = a.html ? written(body) : body.split("\n").map(l => `<div>${esc(l) || "<br>"}</div>`).join("");
    if (mode === "continue") {
      if (!isOpen()) throw new Error("No message is being written in the mail tab to continue. To start one, use another mode.");
      if (given(a.to) || given(a.cc) || given(a.bcc) || given(a.subject)) throw new Error("continue adds to the text only: the recipients and the subject of the message being written are the user's to change.");
      const text = a.html ? pen.toText(html) : body;
      if (!text.trim()) throw new Error(a.html && body.trim() ? "Nothing to add: the body holds no text once what is not kept of its HTML is dropped." : "Nothing to add: give a body.");
      // The line is named as read_composer shows it, which is with the caret's mark and, at its
      // start, with the marks that plain text gives a quoted line and a list's item.
      const after = given(a.after) ? String(a.after).replaceAll(CARET, "").replace(/^\s*(?:>\s?)*(?:(?:•|\d+\.)\s)?/, "") : null;
      const put = pen.add({ html, text, after });
      replay(put.wrote);
      mail.added(put);            // an entry of the undo history, which takes the text out again
      const why = await pen.save(true);
      if (!why) mail.draftsChanged();
      return { id: pen.savedId(), opened: true, ...(why ? { unsaved: why } : {}) };
    }
    if (given(a.after)) throw new Error("after names a line of the message being written, and goes with the mode continue only.");
    // The mode open_draft opens a saved draft as the user's click on it in Drafts does, and
    // changes nothing of it. The draft is the one named, which must be in Drafts; or, with none
    // named, the only one there. With several there and none named, none is opened: the answer
    // tells of each (whom it is to, its subject, its date and how its text begins), and the
    // server tells the assistant to ask the user which.
    if (mode === "draft") {
      if (given(a.to) || given(a.cc) || given(a.bcc) || given(a.subject) || body.trim()) throw new Error("open_draft opens a draft as it is: it takes no recipients, subject or body. To add to the draft once it is open, use the mode continue.");
      if (isOpen()) throw new Error("A message is being written in the mail tab, so it was left alone. Ask the user to finish or close it first; read_composer shows it, and the mode continue adds to it.");
      const drafts = mail.folderByType("DRAFT");
      if (!drafts) throw new Error("This mailbox has no Drafts folder.");
      const listed = (await api.list(drafts.id, DRAFTS_TOLD + 1, 0)).messages;
      let id = String(a.id ?? "").trim();
      if (!id && !listed.length) throw new Error("Drafts is empty: there is no draft to open.");
      if (!id && listed.length > 1) {
        const told = await Promise.all(listed.slice(0, DRAFTS_TOLD).map(async m => {
          const { snippet, folder, from, read, starred, ...row } = shape(m);
          let begins = "";
          try { const r = await api.body(m.id), text = shown(mail.cleanHtml(r.html || "", r)); begins = (text ? pen.toText(text) : String(r.text || "")).slice(0, DRAFT_BEGINS); } catch { /* the row's own words tell of it */ }
          return { ...row, begins: begins || snippet };
        }));
        rowsOut(listed);
        return { opened: false, drafts: told, more: listed.length > DRAFTS_TOLD };
      }
      id ||= listed[0].id;
      if (!listed.some(m => m.id === id) && String((await bodyOf(id)).message?.folder?.id ?? "") !== String(drafts.id)) throw new Error("That message is not a draft in Drafts. list_messages with the folder drafts lists the drafts.");
      let opened;
      try { opened = await mail.openDraft(id); } catch (e) { if (api.isGone(e)) throw new Error(GONE); throw e; }
      if (!opened) throw new Error("The composer could not be opened.");
      return { id, opened: true };
    }
    const id = mode === "new" ? null : idOf(a);
    const to = people(a.to), cc = people(a.cc), bcc = people(a.bcc);
    if (mode === "new" && !to && !body.trim() && !String(a.subject ?? "").trim()) throw new Error("Nothing to draft: give recipients, a subject or a body.");
    if (isOpen()) throw new Error("A message is being written in the mail tab, so it was left alone. Ask the user to finish or close it first; or, if the user asked you to add to that message, use the mode continue.");
    const focused = document.activeElement;
    let opened;
    try { opened = await mail.openComposer(mode, id); } catch (e) { if (api.isGone(e)) throw new Error(GONE); throw e; }
    if (!opened) throw new Error("The composer could not be opened.");
    const wrote = pen.fill({ to, cc, bcc, subject: a.subject == null ? null : String(a.subject), html, text: a.html ? pen.toText(html) : body });
    if (a.open !== false) replay(wrote);        // begun before the editor is next painted, so the text is not seen whole first
    const why = await pen.save();
    if (why) throw new Error(`The message is open in the mail tab but could not be saved to Drafts: ${why}`);
    const out = { id: pen.savedId(), opened: a.open !== false };
    if (!out.opened) { await close(false); focused?.focus?.(); }
    mail.draftsChanged();
    return out;
  },
};

// ---------- the replay ----------
// What the assistant wrote is in the editor whole from the start, and is saved as it is. Where the
// message stays open its text is then shown as if typed: the part not yet "typed" is painted in
// no colour (a CSS highlight over a range, see glue/mail.css), and a caret marked AI stands where
// the typing has come to, in the editor's scrolling box and outside the message. Nothing of the
// message is changed for it, so a save at any moment saves all of it, and the assistant's command
// does not wait for it. A key, a click or anything put into the composer ends it at once and shows
// the whole text, as does the composer closing. A reader who asked the system for less motion
// gets the text at once. wrote: the range of the editor that holds the assistant's text.
const UNWRITTEN = "mcp-unwritten";
// How long the typing takes (ms): this long for each character, within these bounds; how often the
// text grows; and how long the caret stays once the text is whole.
const PER_CHAR = 25, REPLAY_MS = [600, 3000], STEP_MS = 30, CARET_STAYS = 1200;
let replaying = null;           // ends the replay under way
function replay(wrote) {
  replaying?.();
  if (!wrote || !globalThis.Highlight || !CSS.highlights || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const pane = $("compose"), box = $("c-body"), texts = [];
  for (let walk = document.createTreeWalker(wrote.commonAncestorContainer, NodeFilter.SHOW_TEXT), n; (n = walk.nextNode());) if (n.data.length && wrote.intersectsNode(n)) texts.push(n);
  const total = texts.reduce((sum, n) => sum + n.data.length, 0);
  if (!total) return;
  const caret = el("div", { id: "mcp-caret", hidden: true }, el("b", { textContent: "AI" }));
  caret.setAttribute("aria-hidden", "true");
  box.append(caret);
  const took = Math.min(REPLAY_MS[1], Math.max(REPLAY_MS[0], total * PER_CHAR)), began = performance.now();
  const ENDS = ["keydown", "pointerdown", "wheel", "beforeinput", "paste", "drop"];
  let timer = 0;
  const end = () => {
    clearTimeout(timer);
    for (const e of ENDS) pane.removeEventListener(e, end, true);
    CSS.highlights.delete(UNWRITTEN);
    caret.remove();
    if (replaying === end) replaying = null;
  };
  // The caret after the character before (node, at), or before the node's first; where that
  // character takes no room on the page the caret stays where it was. The box scrolls to keep it
  // in view.
  const place = (node, at) => {
    const r = document.createRange();
    r.setStart(node, Math.max(0, at - 1)); r.setEnd(node, at > 0 ? at : Math.min(1, node.data.length));
    const rects = r.getClientRects(), rect = rects[at > 0 ? rects.length - 1 : 0];
    if (!rect?.height) return;
    const frame = box.getBoundingClientRect();
    const left = (at > 0 ? rect.right : rect.left) - frame.left - box.clientLeft + box.scrollLeft, top = rect.top - frame.top - box.clientTop + box.scrollTop;
    Object.assign(caret.style, { left: `${left}px`, top: `${top}px`, height: `${rect.height}px` });
    caret.classList.toggle("flip", left > box.clientWidth - 48);      // its mark stays inside the box
    caret.hidden = false;
    if ((top + rect.height) > (box.scrollTop + box.clientHeight)) box.scrollTop = top + rect.height - box.clientHeight + 24;
    else if (top < box.scrollTop) box.scrollTop = Math.max(0, top - 24);
  };
  const step = () => {
    if (!isOpen() || !texts[0].isConnected) return end();
    const shown = Math.min(total, Math.floor((total * (performance.now() - began)) / took));
    // the text node the typing has come to, and how far into it
    let i = 0, at = shown;
    while (i < texts.length - 1 && at >= texts[i].data.length) at -= texts[i++].data.length;
    at = Math.min(at, texts[i].data.length);
    place(texts[i], at);
    if (shown >= total) { CSS.highlights.delete(UNWRITTEN); timer = setTimeout(end, CARET_STAYS); return; }
    const rest = document.createRange();
    rest.setStart(texts[i], at); rest.setEnd(wrote.endContainer, wrote.endOffset);
    CSS.highlights.set(UNWRITTEN, new Highlight(rest));
    timer = setTimeout(step, STEP_MS);
  };
  for (const e of ENDS) pane.addEventListener(e, end, true);
  replaying = end;
  step();
}

// ---------- Settings ----------
// A section of its own, put in before the update note: the switch and, while it is on, one row
// with what the connection is doing, the pairing code and Copy. The code can be typed over (a
// mailbox can take another's code); emptied, it is made anew.
function drawSettings() {
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

// ---------- the marker ----------
// In the header, always: that this copy of the app has AI access, and what the connection is
// doing. While an assistant's command is done it says what the assistant is doing, and pulses. It
// stands before the account, at the end of the header's free space, so that its words changing
// move nothing else. A click opens Settings at their end, where AI access is.
function drawMark() {
  const mark = el("button", { type: "button", id: "mcp-mark" }, el("i"), el("span"));
  // Settings open scrolled to their end, where AI access is, with Copy focused; while AI access
  // is off there is no Copy to focus, and its switch is instead.
  // Settings go on filling for a moment after they open (what the tab's being kept awake and
  // Contacts say of themselves), and grow as they do: the end is kept in view meanwhile.
  mark.onclick = () => {
    mail.openSettings();
    const box = $("settings-box"), toEnd = () => { box.scrollTop = box.scrollHeight; };
    toEnd();
    const grows = new ResizeObserver(toEnd);
    grows.observe($("settings-main"));
    setTimeout(() => grows.disconnect(), 800);
    $(on ? "mcp-copy" : "mcp-on").focus({ preventScroll: true });
  };
  $("account").before(mark);
  syncMark();
}
function syncMark() {
  const mark = $("mcp-mark");
  if (!mark) return;
  const state = !on ? "off" : phase === "connected" && doing ? "working" : phase;
  mark.dataset.phase = state;
  mark.lastChild.textContent = state === "working" ? `AI is ${doing}` : `AI access: ${MARKS[state]}`;
  mark.title = `${state === "off" ? "This copy of Baltazar Mail has AI access. It is switched off." : state === "working" || state === "connected" ? "An assistant on this computer can read and organise this mail, and prepare drafts." : SAYS[state]} Click for its settings.`;
}
