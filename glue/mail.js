// ---------- AI access ----------
// Appended to the app's mail.js by this repository's build (tools/build.js): it stands inside that
// module and uses its functions by name, and the app's own source has none of it. It hands mcp.js
// what the bridge needs of the mail page: what the folder pane holds, the reader's cleaning of a
// message, and the changes an assistant may make. Each change is made as the app's own action
// makes it (the undo history's entry, the folder counts, the list, the address book), for
// messages that need not be in the list; its entry in the undo history begins with "AI:". No
// function here sends a message, deletes one for good or empties a folder.
// uses: $ api compose state busy run pause status plural pushUndo aboutMessages groupBy applyFlags bumpFolder removeLocal byIds renderList clearReader readerRow updateFolderCounts keptUnread refreshStarredCount listDirty folderType folderName folderByType subfolders isHidden managed acctOf leafName parentPath checkFolderName renamePaths loadFolders renderFolders saveSettings loadList outOfMail mailLeft mailBack cleanHtml inlineImages hideReaderForCompose
// watches: doSetRead doSetStarred doMove startCompose createFolderIn renameFolderAsk run
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
        opened = await compose.open({ mode, message: body.message, body, images: false, myEmail: me });
      }
      hideReaderForCompose(compose.isOpen());
      return !!opened;
    } catch (e) { if (!compose.isOpen()) hideReaderForCompose(false); throw e; }
  }
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
    openComposer, draftsChanged,
  })).catch(e => console.error("AI access could not start:", e));
}
