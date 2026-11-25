// ---------- AI access ----------
// Appended to the app's mail.js by this repository's build (tools/build.js): it stands inside that
// module and uses its functions by name, and the app's own source has none of it. It hands mcp.js
// what the bridge needs of the mail page: what the folder pane holds, the reader's cleaning of a
// message, the opening of the composer, of a saved draft and of Settings, and the changes an
// assistant may make. Each change is made as the app's own action makes it (the undo history's
// entry, the folder counts, the list, the address book), for messages that need not be in the
// list; its entry in the undo history begins with "AI:". No function here sends a message,
// deletes one for good or empties a folder.
// uses: $ api compose state busy run pause status plural pushUndo aboutMessages groupBy applyFlags bumpFolder removeLocal byIds renderList clearReader readerRow updateFolderCounts keptUnread refreshStarredCount listDirty folderType folderName folderByType subfolders isHidden managed acctOf leafName parentPath checkFolderName renamePaths loadFolders renderFolders saveSettings loadList outOfMail mailLeft mailBack cleanHtml inlineImages hideReaderForCompose openSettings imagesLeft hist history showUndo
// watches: doSetRead doSetStarred doMove startCompose editDraft createFolderIn renameFolderAsk run
{
  const inList = id => state.messages.some(m => m.id === id);
  // the list's own row where it holds the message, which is its newest state
  const current = rows => rows.map(m => state.messages.find(x => x.id === m.id) || m);
  const ids = failed => (failed || []).map(f => String(f?.id ?? f));

  // An assistant's change takes its turn among the user's own: it waits while one of those runs,
  // where a key pressed meanwhile would be dropped.
  async function inTurn(change) {
    for (let tries = 0; tries < 600; tries++) {
      if (busy) { await pause(100); continue; }
      let ran = false, out, failed = null;
      await run(async () => { ran = true; try { out = await change(); } catch (e) { failed = e; } });
      if (!ran) continue;
      if (failed) throw failed;
      return out;
    }
    throw new Error("The mail tab is busy. Try again in a moment.");
  }

  // Read or unread, starred or not: as doSetRead and doSetStarred. flag is "read" or "flagged".
  async function setFlag(given, flag, value) {
    const isRead = flag === "read", change = isRead ? api.setRead : api.setStarred;
    const rows = current(given), before = rows.map(m => [!!m.flags?.[flag], m.id]);
    const r = await change(rows.map(m => m.id), value);
    const okSet = new Set(r.ok), done = rows.filter(m => okSet.has(m.id));
    // a message outside the list: its folder's unread count, which applyFlags keeps for the list's rows
    if (isRead) for (const m of done) if (!inList(m.id) && !!m.flags?.read !== value) bumpFolder(m.folder?.id, 0, value ? -1 : 1);
    applyFlags(r.ok, { [flag]: value });
    if (!isRead) refreshStarredCount();
    else for (const id of r.ok) if (value) keptUnread.delete(id); else keptUnread.add(id);
    // the rows the assistant holds say what the mailbox now says, also once the change is undone or redone
    const was = new Map(before.map(([flagged, id]) => [id, flagged]));
    const note = to => { for (const m of given) if (okSet.has(m.id)) m.flags = { ...(m.flags || {}), [flag]: to(m.id) }; };
    note(() => value);
    status(`AI: ${isRead ? `marked ${plural(done.length, "message")} ${value ? "read" : "unread"}` : `${value ? "starred" : "unstarred"} ${plural(done.length, "message")}`}`, r.ms);
    if (done.length) pushUndo({ label: `AI: ${aboutMessages(done, done.length, isRead ? "mark" : value ? "star" : "unstar", isRead ? (value ? " read" : " unread") : "")}`,
      count: done.length, touches: r.ok.map(id => `m:${id}:${isRead ? "read" : "star"}`),
      undo: async () => { const out = []; for (const [flagged, g] of groupBy(before.filter(([, id]) => okSet.has(id)))) out.push(await change(g, flagged)); note(id => was.get(id)); return out; },
      redo: async () => { const out = await change(r.ok, value); note(() => value); return out; } });
    return { changed: r.ok, failed: ids(r.failed) };
  }

  // To a folder: as doMove. A message moved to Trash is in Trash; nothing here goes the way a
  // message is deleted for good.
  async function move(given, dest) {
    const rows = current(given);
    const origins = rows.map(m => ({ id: m.id, from: m.folder?.id, unread: !m.flags?.read }));
    const moving = origins.filter(o => o.from !== dest.id), there = origins.filter(o => o.from === dest.id).map(o => o.id);
    if (!moving.length) return { folder: String(dest.id), moved: [], failed: [], already: there };
    const openWas = state.openId;
    // the folder each message is in, for a provider whose move depends on it (Gmail's labels)
    const from = Object.fromEntries(moving.filter(o => o.from != null).map(o => [o.id, o.from]));
    const r = await api.move(moving.map(o => o.id), dest.id, { from });
    const okSet = new Set(r.ok), done = moving.filter(o => okSet.has(o.id)), moved = rows.filter(m => okSet.has(m.id));
    const where = folderName(dest).split("/").pop();
    // the undo history's words, while the rows still say where the messages were
    const label = `AI: ${aboutMessages(moved, done.length, "move", ` to ${where}`)}`;
    for (const o of done) { bumpFolder(o.from, -1, o.unread ? -1 : 0); bumpFolder(dest.id, 1, o.unread ? 1 : 0); }
    const v = state.view;
    const leaves = v.kind === "folder" ? v.folderId !== dest.id : ["TRASH", "BULK"].includes(folderType(dest)) && !v.scope?.ids?.includes(dest.id);
    if (leaves) removeLocal(r.ok);
    else { for (const m of byIds(r.ok)) m.folder = { ...(m.folder || {}), id: dest.id, name: dest.name }; renderList(); }
    // messages that came into the folder being shown are listed once this change is over
    if (v.kind === "folder" && v.folderId === dest.id && done.length) listDirty.add(dest.id);
    if (readerRow && okSet.has(readerRow.id) && !inList(readerRow.id)) clearReader();
    updateFolderCounts();
    status(`AI: moved ${plural(done.length, "message")} to ${where}`, r.ms);
    const known = done.filter(o => o.from);
    // Contacts mirrors the mail outside Trash and Spam (see mailLeft in the app)
    const unsent = f => folderType(f) === "DRAFT", origin = new Map(known.map(o => [o.id, o.from]));
    const toDest = unsent(dest) ? [] : moved, toOrigin = moved.filter(m => !unsent(state.byId.get(origin.get(m.id))));
    const [went, came] = outOfMail(dest) ? [() => mailLeft(moved), () => mailBack(toOrigin)]
      : done.some(o => outOfMail(state.byId.get(o.from))) ? [() => mailBack(toDest), () => mailLeft(moved)] : [() => {}, () => {}];
    went();
    // the rows the assistant holds say where the messages now are, also once the move is undone or redone
    const place = to => { for (const m of given) { const f = okSet.has(m.id) && state.byId.get(to(m.id)); if (f) m.folder = { ...(m.folder || {}), id: f.id, name: f.name }; } };
    place(() => dest.id);
    // A provider that can take back exactly what its move changed says how (undo); otherwise each
    // message moves back to the folder it came from. A redo's own answer undoes the redo.
    let last = r;
    if (done.length) pushUndo({ label, reopen: openWas && okSet.has(openWas) ? openWas : null, count: done.length, touches: done.map(o => `m:${o.id}:folder`),
      undo: async () => {
        const out = [];
        if (last.undo) out.push(await last.undo());
        else for (const [to, g] of groupBy(known.map(o => [o.from, o.id]))) out.push(await api.move(g, to));
        came(); place(id => origin.get(id));
        return out.flat();
      },
      redo: async () => { last = await api.move(done.map(o => o.id), dest.id, { from }); went(); place(() => dest.id); return last; } });
    return { folder: String(dest.id), moved: r.ok, failed: ids(r.failed), already: there };
  }

  // A folder made, or given another name: as New folder and Rename in the folder pane, which ask
  // for the name; here it is given. parent: the folder to make it in, or none.
  const named = full => state.folders.find(f => f.name.toLowerCase() === full.toLowerCase());
  async function createFolder(name, parent) {
    const where = parent ? parent.name : "", acct = acctOf(parent), why = checkFolderName(name, where, null, acct);
    if (why) throw new Error(why);
    const full = where ? `${where}/${name}` : name;
    await api.createFolder(full, acct);
    await loadFolders(true);
    if (parent) { state.expanded.add(parent.name); saveSettings(); renderFolders(); }
    status(`AI: created folder "${name}"`);
    return named(full) || null;
  }
  async function renameFolder(f, name) {
    if (!managed(f)) throw new Error("Only a folder of the user's own can be renamed.");
    if (name === leafName(f)) return f;
    const why = checkFolderName(name, parentPath(f), f);
    if (why) throw new Error(why);
    const was = leafName(f), to = parentPath(f) ? `${parentPath(f)}/${name}` : name;
    await api.renameFolder(f.id, to);
    renamePaths(f.name, to);
    await loadFolders(true);
    status(`AI: renamed "${was}" to "${name}"`);
    return named(to) || null;
  }

  // The composer opens a message by putting away the one that is open. An assistant's message
  // is never opened over the user's: mcp.js refuses while one is open, and since what is loaded
  // first takes time, in which the user may start one, it is asked again just before the opening.
  const STARTED = "A message was started in the mail tab meanwhile, so it was left alone and nothing was opened.";
  // The composer opened as Reply, Reply all, Forward or New opens it (startCompose), for a
  // message that need not be the one in the reader. The quoted original loads none of the
  // sender's remote pictures. Answers whether it opened.
  async function openComposer(mode, id) {
    const me = $("account").textContent;
    hideReaderForCompose(true);
    try {
      let opened;
      if (mode === "new") opened = await compose.open({ mode, myEmail: me });
      else {
        const body = await api.body(id);
        body.source = body.html;
        body.html = await inlineImages(cleanHtml(body.html, body), body);
        if (compose.isOpen()) throw new Error(STARTED);
        opened = await compose.open({ mode, message: body.message, body, images: false, myEmail: me });
      }
      hideReaderForCompose(compose.isOpen());
      return !!opened;
    } catch (e) { if (!compose.isOpen()) hideReaderForCompose(false); throw e; }
  }
  // A saved draft opened in the composer as a click on it in Drafts opens it (editDraft), for a
  // draft that need not be in the list: with its pictures in it and its attachments as files,
  // since each save replaces the draft and they must travel with it again. Where a picture or an
  // attachment cannot be loaded the draft stays closed, and unchanged. A draft that quotes mail
  // loads none of that mail's remote pictures here, where no click of the user's asked for it.
  // Answers whether it opened.
  async function openDraft(id) {
    const r = await api.body(id);
    r.html = await inlineImages(r.html, r, Infinity);
    const missing = imagesLeft(r.html, r);
    if (missing) throw new Error(`Could not load ${plural(missing, "picture")} of the draft, so it was not opened: saving it would leave ${missing === 1 ? "that picture" : "them"} out. The user can open it in the mail tab.`);
    const atts = (r.attachments || []).filter(a => a.disposition !== "inline" && a.partId);
    let files;
    try {
      files = await Promise.all(atts.map(async a => {
        const x = await api.partBytes(id, a);
        return new File([x.bytes], a.filename || x.filename || "attachment", { type: x.type || "application/octet-stream" });
      }));
    } catch (e) { throw new Error(`Could not load the draft's attachments, so it was not opened (it is unchanged): ${e.message}`); }
    if (compose.isOpen()) throw new Error(STARTED);
    hideReaderForCompose(true);
    try {
      const opened = await compose.open({ mode: "draft", message: r.message, body: r, files, partIds: atts.map(a => a.partId), myEmail: $("account").textContent, images: false });
      hideReaderForCompose(compose.isOpen());
      return !!opened;
    } catch (e) { if (!compose.isOpen()) hideReaderForCompose(false); throw e; }
  }
  // What an assistant added to the message being written is an entry of the undo history like
  // its other changes: Undo takes the text out of the message again, and Redo puts it back
  // (undo and redo are the composer's, from glue/compose.js). Each entry stands alone, so one can
  // be taken back whatever was added after it. An entry is for the message it was added to, while
  // that is the one being written (alive): once the composer closes, or opens another, it could
  // take nothing back, and leaves the history.
  let additions = 0, standing = [];
  function added({ undo, redo, alive }) {
    status("AI: added text to the message being written");
    const entry = { label: "AI: add text to the message being written", count: 1, touches: [`w:${++additions}`], undo, redo };
    pushUndo(entry);
    standing.push([entry, alive]);
  }
  new MutationObserver(() => {
    const gone = standing.filter(([, alive]) => !alive());
    if (!gone.length) return;
    standing = standing.filter(([, alive]) => alive());
    for (const [entry] of gone) history.remove(hist, entry);
    showUndo();
  }).observe($("compose"), { attributes: true, attributeFilter: ["class"] });
  // A draft was saved: the folder pane counts it, and a list of Drafts shows it.
  function draftsChanged() {
    loadFolders(true).catch(() => {});
    if (state.view.kind === "folder" && folderType(state.byId.get(state.view.folderId)) === "DRAFT") loadList("refresh");
  }

  import("./mcp.js").then(m => m.init({
    ready: () => state.signedIn, account: () => $("account").textContent,
    folders: () => state.folders, folderType, folderName, folderByType, subfolders, isHidden, cleanHtml,
    setFlag: (rows, flag, value) => inTurn(() => setFlag(rows, flag, value)),
    move: (rows, dest) => inTurn(() => move(rows, dest)),
    createFolder: (name, parent) => inTurn(() => createFolder(name, parent)),
    renameFolder: (f, name) => inTurn(() => renameFolder(f, name)),
    openComposer, openDraft, added, draftsChanged, openSettings: () => openSettings(true),
  })).catch(e => console.error("AI access could not start:", e));
}
