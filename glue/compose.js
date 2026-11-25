// ---------- AI access ----------
// Appended to the app's compose.js by this repository's build (tools/build.js): it stands inside
// that module and uses its functions by name, and the app's own source has none of it. It hands
// mcp.js the composer's conversion of HTML to plain text, and what an assistant's draft needs of
// the open composer: to put its recipients, subject and text into a message it opened, to read
// the message the user is writing and to add text to it, and to save to Drafts. Nothing here
// sends a message or discards one.
// uses: $ draft dirty fields editorSafe toText saveNow splitQuote CARET_HOLD
// watches: openNow saveNow
{
  // ---------- where an assistant's text goes in the message the user is writing ----------
  // Into the user's own text, as lines of its own, after a line of it: the one the caret is in,
  // or the one the assistant names. Never into the signature, a forwarded message or the words
  // of a quoted original, which would then read as someone else's; a caret inside a quoted
  // original splits the quote there, as Enter splits it, and the text stands between its parts.
  //
  // A draft that was saved and opened again is not as the composer first made it: each save put
  // the whole message into one more block, and the provider may have renamed the classes that
  // tell the signature and the quoted original. So nothing here rests on those names alone. A
  // line is found from the page as it is laid out: text runs on to a line break or to the next
  // block. A quoted original is told by the rule down its left side, which openNow gives it and
  // an indent the user made lacks, and a forwarded message by the line openNow puts above it.
  const FORWARDED = "---------- Forwarded message ----------";
  const plain = s => s.replaceAll(CARET_HOLD, "").replace(/\s+/g, " ").trim();
  const blank = n => n.nodeType === 3 ? !n.data.trim() : n.nodeType !== 1 || (!n.textContent.trim() && !n.matches("img, hr, table") && !n.querySelector("img, hr, table"));
  const blocky = n => n.nodeType === 1 && /^(block|list-item|table|flex|grid)/.test(getComputedStyle(n).display);
  const isQuote = b => !!b.closest(".ymq") || b.style.borderLeftStyle === "solid";
  // The nodes an assistant put into a message, so that what it adds next at the same place
  // follows them.
  const added = new WeakSet();

  // [parent, next]: the text goes into parent, before next (at its end when there is none).
  // want: the words that name the line to write after, or null for the line the caret is in.
  // Throws, and changes nothing, when the words name no line of the user's own, or several.
  function spot(ed, want) {
    const said = (want || "").slice(0, 80);
    const signature = ed.querySelector(".ymsig");
    let forward = null;
    for (let walk = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT), t; (t = walk.nextNode());) if (t.data.includes(FORWARDED)) { forward = t.parentElement === ed ? null : t.parentElement; break; }
    // the outermost quoted original around a node
    const quoteOf = n => { let out = null; for (let b = n.closest("blockquote"); b && b !== ed && ed.contains(b); b = b.parentElement.closest("blockquote")) if (isQuote(b)) out = b; return out; };
    const blockOf = n => { let b = n.nodeType === 1 ? n : n.parentElement; while (b !== ed && !blocky(b)) b = b.parentElement; return b; };
    // the line that introduces a quoted original ("... wrote:")
    const introduces = b => {
      if (b === ed || !/wrote:\s*$/.test(b.textContent)) return false;
      let after = b.nextSibling;
      while (after && blank(after)) after = after.nextSibling;
      return !!after && after.localName === "blockquote" && isQuote(after);
    };
    const own = n => { const el = n.nodeType === 1 ? n : n.parentElement; return !el.closest(".ymsig") && !forward?.contains(el) && !quoteOf(el) && !introduces(blockOf(n)); };
    const shows = el => el.checkVisibility?.({ opacityProperty: true, visibilityProperty: true, checkOpacity: true, checkVisibilityCSS: true }) ?? true;

    // Where the line that a node stands in ends: last is the line's last node, which tells one
    // line from another. A list or a table is not broken into: its line ends after the whole.
    const lineEnd = node => {
      const block = blockOf(node);
      let outer = null;
      for (let up = block.closest("ul, ol, table"); up && up !== ed && ed.contains(up); up = up.parentElement.closest("ul, ol, table")) outer = up;
      if (outer) return { last: outer, parent: outer.parentNode, next: outer.nextSibling };
      if (node === block) return block === ed ? { last: ed, parent: ed, next: null } : { last: block, parent: block.parentNode, next: blank(block) ? block : block.nextSibling };
      let last = node;
      while (last.parentNode !== block) last = last.parentNode;
      while (last.localName !== "br" && last.nextSibling && !blocky(last.nextSibling)) last = last.nextSibling;
      // The last line of a block that holds lines only ends where the block does; an empty one
      // takes the text in its place and then follows it.
      let rest = last.nextSibling;
      while (rest && rest.nodeType === 3 && !rest.data.trim()) rest = rest.nextSibling;
      if (block !== ed && !rest && ![...block.children].some(blocky)) return { last, parent: block.parentNode, next: blank(block) ? block : block.nextSibling };
      return { last, parent: block, next: last.nextSibling };
    };
    const place = end => { let next = end.next; while (next && added.has(next)) next = next.nextSibling; return [end.parent, next]; };

    if (want != null) {
      const lines = new Map();
      for (let walk = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT), t; (t = walk.nextNode());) {
        if (!own(t) || !shows(t.parentElement)) continue;
        const end = lineEnd(t), line = lines.get(end.last) || { ...end, text: "" };
        line.text += t.data;
        lines.set(end.last, line);
      }
      const hits = [...lines.values()].filter(l => plain(l.text).includes(want));
      if (hits.length > 1) throw new Error(`More than one line of what the user wrote has "${said}". Give more of the line, so that it names one.`);
      if (!hits.length) {
        throw new Error(plain(ed.textContent).includes(want) ? `"${said}" is in the signature or in a quoted or forwarded message, not in what the user wrote. What is added goes into the user's own text: name a line of that, or none.`
          : `What the user wrote has no line with "${said}". read_composer shows the message as it is.`);
      }
      return place(hits[0]);
    }

    // The caret's place at its deepest: a place between an element's children is the start of
    // the child after it, or the end of the last child.
    const sel = getSelection(), caret = sel.rangeCount ? sel.getRangeAt(0) : null;
    let node = caret && ed.contains(caret.endContainer) ? caret.endContainer : null, offset = caret?.endOffset || 0;
    while (node && node.nodeType === 1 && node.childNodes.length) {
      const last = offset >= node.childNodes.length;
      node = last ? node.lastChild : node.childNodes[offset];
      offset = !last ? 0 : node.nodeType === 3 ? node.data.length : node.childNodes.length;
    }
    // a selection that ends at the very start of a line ended with the line before it
    if (node && !caret.collapsed && offset === 0) {
      let before = null;
      for (let walk = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT), t; (t = walk.nextNode()) && t !== node && !(t.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING);) if (t.data.trim() && caret.intersectsNode(t)) before = t;
      if (before) { node = before; offset = before.data.length; }
    }
    // A caret at the very start of the message is where the composer put it when the message
    // opened, not where the user chose to write.
    let first = ed;
    while (first.firstChild) first = first.firstChild;
    const chosen = node && !(caret.collapsed && node === first && offset === 0);
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    if (chosen && !el.closest(".ymsig") && !forward?.contains(el)) {
      const quote = quoteOf(el);
      if (quote) {
        sel.collapseToEnd();
        splitQuote(quote, sel);      // leaves the caret in an empty line between the two parts
        return [sel.anchorNode.parentNode, sel.anchorNode];
      }
      if (!introduces(blockOf(node))) return place(lineEnd(node));
    }
    // Elsewhere: after the user's own text, which is before the signature, the forwarded
    // message or the first quoted original, whichever comes first, and before the empty lines
    // above it; at the end of a message that has none. A quoted original is taken with the line
    // that introduces it and with each block that holds nothing else before it.
    let quoted = [...ed.querySelectorAll("blockquote")].find(b => isQuote(b) && !forward?.contains(b)) || null;
    while (quoted && quoted.parentNode !== ed) {
      const all = [...quoted.parentNode.childNodes], before = all.slice(0, all.indexOf(quoted)).filter(n => !blank(n));
      if (before.length > 1 || (before.length === 1 && !/wrote:\s*$/.test(before[0].textContent))) break;
      quoted = quoted.parentNode;
    }
    const mark = [signature, forward, quoted].filter(Boolean).reduce((a, b) => (!a || (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING)) ? b : a, null);
    let next = mark;
    const parent = mark ? mark.parentNode : ed;
    for (let before; (before = next ? next.previousSibling : parent.lastChild) && blank(before);) next = before;
    return [parent, next];
  }

  import("./mcp.js").then(m => m.composer({
    toText,
    // What the assistant wrote goes on top, above the signature and the quoted original the
    // composer opened with. Recipients given replace those it worked out; html is cleaned as
    // anything put into the editor is. Answers the range of the editor that holds what was put
    // in, which mcp.js shows as if typed, or null for a message written as plain text.
    fill({ to, cc, bcc, subject, html, text }) {
      if (to) fields.to.set(to);
      if (cc) fields.cc.set(cc);
      if (bcc) fields.bcc.set(bcc);
      if (!fields.cc.isEmpty() || !fields.bcc.isEmpty()) for (const id of ["c-cc-row", "c-bcc-row"]) $(id).classList.remove("hidden");
      if (subject != null) $("c-subject").value = subject;
      let wrote = null;
      if (draft.html) {
        const ed = $("c-editor"), first = ed.firstChild;
        ed.insertAdjacentHTML("afterbegin", editorSafe(html));
        wrote = document.createRange();
        wrote.setStart(ed, 0);
        if (first) wrote.setEndBefore(first); else wrote.setEnd(ed, ed.childNodes.length);
      } else $("c-text").value = `${text}\n${$("c-text").value}`;
      dirty = true;
      return wrote;
    },
    // What the assistant wrote goes into the message the user is writing (see spot, above, for
    // where), and nothing else of the message changes: the user's own text, the recipients and
    // the subject stay as they are. after: words that name the line to write after, in place of
    // the caret's; spaces and line breaks in them count as one space. A message written as plain
    // text takes it the same way, by its own lines: one that begins with ">" is quoted, and is
    // not the user's own. Where nothing can be put in, nothing is changed, and the error says why.
    // Answers the range of the editor that holds what was put in (wrote, as fill answers it);
    // undo and redo, which take it out of the message and put it back, for the message it was
    // added to and while that is the one being written (alive); each saves as the composer's own
    // autosave does.
    add({ html, text, after = null }) {
      const want = after == null ? null : plain(after), said = (want || "").slice(0, 80), wasHtml = !!draft.html, mine = draft;
      if (want === "") throw new Error("after names a line by its words, and was given none.");
      let wrote = null, back, again;
      if (draft.html) {
        const ed = $("c-editor"), made = document.createElement("template");
        made.innerHTML = editorSafe(html);
        const nodes = [...made.content.childNodes];
        if (!nodes.length) throw new Error("Nothing to add: nothing is left of the body once it is cleaned.");
        const [parent, next] = spot(ed, want);
        parent.insertBefore(made.content, next);
        for (const n of nodes) added.add(n);
        wrote = document.createRange(); wrote.setStartBefore(nodes[0]); wrote.setEndAfter(nodes.at(-1));
        // Taken back: the lines still in the message leave it, with whatever the user has changed
        // in them since, and where they stood is kept for putting them back. A quote that was
        // split for them stays split.
        let taken = null, stood = null;
        back = () => {
          taken = nodes.filter(n => n.isConnected && ed.contains(n));
          if (!taken.length) throw new Error("What was added is no longer in the message.");
          stood = [taken[0].parentNode, taken[0].previousSibling, taken.at(-1).nextSibling];
          for (const n of taken) n.remove();
        };
        again = () => {
          const [to, before, behind] = stood || [];
          if (!to?.isConnected || !ed.contains(to)) throw new Error("The place it was added at is no longer in the message.");
          const at = behind?.parentNode === to ? behind : before?.parentNode === to ? before.nextSibling : null;
          for (const n of taken) to.insertBefore(n, at);
        };
      } else {
        const box = $("c-text"), value = box.value;
        let at, put;
        if (want != null) {
          const ends = [];
          let from = 0;
          for (const line of value.split("\n")) { if (!line.startsWith(">") && plain(line).includes(want)) ends.push(from + line.length); from += line.length + 1; }
          if (ends.length > 1) throw new Error(`More than one line of what the user wrote has "${said}". Give more of the line, so that it names one.`);
          if (!ends.length) throw new Error(plain(value).includes(want) ? `"${said}" is in a quoted message, not in what the user wrote. Name a line of the user's own, or none.` : `What the user wrote has no line with "${said}". read_composer shows the message as it is.`);
          at = ends[0]; put = `\n${text}`;
        } else {
          // After the line the caret is in; an empty line takes the text and then follows it. A
          // box that never had the caret holds it at its end: the text then goes on top.
          const caret = document.activeElement !== box && box.selectionStart === value.length ? 0 : box.selectionStart ?? 0;
          const from = value.lastIndexOf("\n", caret - 1) + 1, eol = value.indexOf("\n", caret), to = eol < 0 ? value.length : eol;
          [at, put] = from === to ? [from, `${text}\n`] : [to, `\n${text}`];
        }
        box.setRangeText(put, at, at, "preserve");
        // Taken back where it is found: at its place, or wherever it stands alone once the user
        // has written above it.
        back = () => {
          const found = box.value.slice(at, at + put.length) === put ? at : box.value.indexOf(put);
          if (found < 0 || (found !== at && box.value.indexOf(put, found + 1) >= 0)) throw new Error("What was added has been changed since, so it was left as it is.");
          at = found;
          box.setRangeText("", at, at + put.length, "preserve");
        };
        again = () => { at = Math.min(at, box.value.length); box.setRangeText(put, at, at, "preserve"); };
      }
      dirty = true;
      const alive = () => draft === mine;
      const step = change => async () => {
        if (!alive()) throw new Error("The message it was added to is no longer being written.");
        if (!!draft.html !== wasHtml) throw new Error("The message was switched between formatted and plain text since, so what was added was left as it is.");
        change();
        dirty = true;
        await saveNow(true, { tick: true });
      };
      return { wrote, undo: step(back), redo: step(again), alive };
    },
    // The message being written, as it stands, for an assistant to read; nothing of it is
    // changed. Its text is the editor's HTML (html), or what the plain text box holds (text),
    // with the mark put where the caret is; caret tells whether the caret is in the text at all,
    // selected is the text selected there.
    look(mark) {
      const who = f => f.list.map(a => ({ name: a.name || "", email: a.email }));
      const out = { kind: $("c-title").textContent, from: $("c-from").value, to: who(fields.to), cc: who(fields.cc), bcc: who(fields.bcc), subject: $("c-subject").value,
        files: [...draft.files.map(f => f.name), ...draft.refs.map(r => r.filename)], html: null, text: null, caret: false, selected: "" };
      if (draft.html) {
        const ed = $("c-editor"), sel = getSelection(), caret = sel.rangeCount ? sel.getRangeAt(0) : null, copy = ed.cloneNode(true);
        if (caret && ed.contains(caret.endContainer)) {
          // the same place in the copy: the way down from the editor, child by child
          const way = [];
          for (let n = caret.endContainer; n !== ed; n = n.parentNode) way.unshift([...n.parentNode.childNodes].indexOf(n));
          const there = document.createRange();
          there.setStart(way.reduce((n, i) => n.childNodes[i], copy), caret.endOffset);
          there.insertNode(document.createTextNode(mark));
          out.caret = true;
          if (!caret.collapsed && ed.contains(caret.startContainer)) out.selected = sel.toString();
        }
        out.html = copy.innerHTML;
      } else {
        const box = $("c-text"), at = box.selectionStart ?? 0;
        out.text = box.value.slice(0, at) + mark + box.value.slice(at);
        out.caret = true; out.selected = box.value.slice(at, box.selectionEnd ?? at);
      }
      return out;
    },
    // Saved to Drafts: "" when it was, else why not. passing: as the composer's own autosave
    // saves, which leaves an address the user is still typing as it is.
    save: (passing = false) => saveNow(true, { tick: passing }),
    savedId: () => draft?.savedId || null,
  })).catch(e => console.error("AI access could not start:", e));
}
