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

  // Whose text is whose in the message as it is now: its signature, a forwarded message, the
  // outermost quoted original around a node (quoteOf), the block a node stands in (blockOf),
  // whether a block is the line that introduces a quoted original ("... wrote:"), whether a node
  // is in the user's own text (own), whether an element is shown at all (shows), and where the
  // line that a node stands in ends (lineEnd).
  function parts(ed) {
    const signature = ed.querySelector(".ymsig");
    let forward = null;
    for (let walk = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT), t; (t = walk.nextNode());) if (t.data.includes(FORWARDED)) { forward = t.parentElement === ed ? null : t.parentElement; break; }
    const quoteOf = n => { let out = null; for (let b = n.closest("blockquote"); b && b !== ed && ed.contains(b); b = b.parentElement.closest("blockquote")) if (isQuote(b)) out = b; return out; };
    const blockOf = n => { let b = n.nodeType === 1 ? n : n.parentElement; while (b !== ed && !blocky(b)) b = b.parentElement; return b; };
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
    return { signature, forward, quoteOf, blockOf, introduces, own, shows, lineEnd };
  }

  // [parent, next]: the text goes into parent, before next (at its end when there is none).
  // want: the words that name the line to write after, or null for the line the caret is in.
  // Throws, and changes nothing, when the words name no line of the user's own, or several.
  function spot(ed, want) {
    const said = (want || "").slice(0, 80);
    const { signature, forward, quoteOf, blockOf, introduces, own, shows, lineEnd } = parts(ed);
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

  // ---------- what an assistant wrote can be taken out again ----------
  // undo and redo, for the message the text was put into and while that is the one being written
  // (alive); each saves as the composer's own autosave does. range answers the range of the
  // editor that holds the text now, or null when none of it is there (or the message is written
  // as plain text).
  function steps(back, again, range = () => null) {
    const mine = draft, wasHtml = !!draft.html;
    const alive = () => draft === mine;
    const step = change => async () => {
      if (!alive()) throw new Error("The message it was written into is no longer being written.");
      if (!!draft.html !== wasHtml) throw new Error("The message was switched between formatted and plain text since, so what was written was left as it is.");
      change();
      dirty = true;
      await saveNow(true, { tick: true });
    };
    return { undo: step(back), redo: step(again), alive, range };
  }
  // For lines put into the editor. Taken back: the lines still in the message leave it, with
  // whatever the user has changed in them since, and where they stood is kept for putting them
  // back. A quote that was split for them stays split.
  function linesPut(ed, nodes) {
    let taken = null, stood = null;
    const there = () => nodes.filter(n => n.isConnected && ed.contains(n));
    return steps(() => {
      taken = there();
      if (!taken.length) throw new Error("What was written is no longer in the message.");
      stood = [taken[0].parentNode, taken[0].previousSibling, taken.at(-1).nextSibling];
      for (const n of taken) n.remove();
    }, () => {
      const [to, before, behind] = stood || [];
      if (!to?.isConnected || !ed.contains(to)) throw new Error("The place it was written at is no longer in the message.");
      const at = behind?.parentNode === to ? behind : before?.parentNode === to ? before.nextSibling : null;
      for (const n of taken) to.insertBefore(n, at);
    }, () => {
      const now = there();
      if (!now.length) return null;
      const range = document.createRange();
      range.setStartBefore(now[0]); range.setEndAfter(now.at(-1));
      return range;
    });
  }
  // For text put into the plain text box at a place. Taken back where it is found: at its place,
  // or wherever it stands alone once the user has written above it.
  function textPut(box, at, put) {
    return steps(() => {
      const found = box.value.slice(at, at + put.length) === put ? at : box.value.indexOf(put);
      if (found < 0 || (found !== at && box.value.indexOf(put, found + 1) >= 0)) throw new Error("What was written has been changed since, so it was left as it is.");
      at = found;
      box.setRangeText("", at, at + put.length, "preserve");
    }, () => { at = Math.min(at, box.value.length); box.setRangeText(put, at, at, "preserve"); });
  }

  import("./mcp.js").then(m => m.composer({
    toText,
    // What the assistant wrote goes on top, above the signature and the quoted original the
    // composer opened with. Recipients given replace those it worked out; html is cleaned as
    // anything put into the editor is. Answers as add does; with no text to put in, wrote is null
    // and there is nothing to take back.
    fill({ to, cc, bcc, subject, html, text }) {
      if (to) fields.to.set(to);
      if (cc) fields.cc.set(cc);
      if (bcc) fields.bcc.set(bcc);
      if (!fields.cc.isEmpty() || !fields.bcc.isEmpty()) for (const id of ["c-cc-row", "c-bcc-row"]) $(id).classList.remove("hidden");
      if (subject != null) $("c-subject").value = subject;
      dirty = true;
      if (!draft.html) {
        const box = $("c-text"), put = `${text}\n`;
        box.value = put + box.value;
        return { wrote: null, ...(text.trim() ? textPut(box, 0, put) : {}) };
      }
      const ed = $("c-editor"), made = document.createElement("template");
      made.innerHTML = editorSafe(html);
      const nodes = [...made.content.childNodes];
      ed.insertBefore(made.content, ed.firstChild);
      for (const n of nodes) added.add(n);
      if (!nodes.some(n => n.textContent.trim())) return { wrote: null };
      const wrote = document.createRange();
      wrote.setStartBefore(nodes[0]); wrote.setEndAfter(nodes.at(-1));
      return { wrote, ...linesPut(ed, nodes) };
    },
    // What the assistant wrote goes into the message the user is writing (see spot, above, for
    // where), and nothing else of the message changes: the user's own text, the recipients and
    // the subject stay as they are. after: words that name the line to write after, in place of
    // the caret's; spaces and line breaks in them count as one space. A message written as plain
    // text takes it the same way, by its own lines: one that begins with ">" is quoted, and is
    // not the user's own. Where nothing can be put in, nothing is changed, and the error says why.
    // Answers the range of the editor that holds what was put in (wrote, which mcp.js shows as if
    // typed; null for a message written as plain text), and what steps answers, for taking it out
    // of the message again.
    add({ html, text, after = null }) {
      const want = after == null ? null : plain(after), said = (want || "").slice(0, 80);
      if (want === "") throw new Error("after names a line by its words, and was given none.");
      if (draft.html) {
        const ed = $("c-editor"), made = document.createElement("template");
        made.innerHTML = editorSafe(html);
        const nodes = [...made.content.childNodes];
        if (!nodes.length) throw new Error("Nothing to add: nothing is left of the body once it is cleaned.");
        const [parent, next] = spot(ed, want);
        parent.insertBefore(made.content, next);
        for (const n of nodes) added.add(n);
        const wrote = document.createRange();
        wrote.setStartBefore(nodes[0]); wrote.setEndAfter(nodes.at(-1));
        dirty = true;
        return { wrote, ...linesPut(ed, nodes) };
      }
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
      dirty = true;
      return { wrote: null, ...textPut(box, at, put) };
    },
    // What the user has selected in the message being written is corrected in place, and nothing
    // outside the selection is. Each edit names words of the selection (find) and what is to
    // stand in their place (with), and any number of them go in at once, so that a selection of
    // several paragraphs, or of the whole message, is corrected by one request. The paragraphs,
    // and the formatting around what is replaced, stay as they are, since each edit lies within
    // one paragraph and changes only the words it names.
    // The selection is the user's word for what may change: whatever of the message is in it
    // can be named, a quoted or forwarded message and the signature too, where they are shown.
    // An edit's words must stand exactly once in the selection, with spaces and line breaks in
    // them counting as one space, and no two edits may meet. All the edits are found before any is made: where one
    // cannot be, nothing is changed, and the error says which and why. What goes in is plain
    // text, a line break in it a line break.
    // Answers how many were made (made), the ranges that hold what was put in (ranges), and what
    // steps answers: undo puts back the words that stood there, all of them.
    replace(edits) {
      const said = s => `"${plain(s).slice(0, 60)}"`;
      const pattern = s => new RegExp(plain(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+"), "g");
      const nothing = () => new Error("Nothing is selected in the text of the message being written. Ask the user to select what is to be changed.");
      const none = s => new Error(`What the user has selected has no ${said(s)} within one paragraph, so nothing was changed. read_composer shows the selection as it is; name fewer words, as they stand there.`);
      const several = s => new Error(`${said(s)} stands more than once in what the user has selected, so nothing was changed. Give more of the words around the place that is meant.`);
      const meet = s => new Error(`The edit for ${said(s)} meets another edit, so nothing was changed. Give each place once.`);
      if (!draft.html) {
        // By the box's own lines, as far as the selection reaches into each.
        const box = $("c-text"), was = box.value, first = box.selectionStart ?? 0, last = box.selectionEnd ?? 0, found = [];
        if (last <= first) throw nothing();
        for (const { find, with: put } of edits) {
          const hits = [];
          let from = 0;
          for (const line of was.split("\n")) {
            const a = Math.max(from, first), b = Math.min(from + line.length, last);
            if (b > a) for (const m of was.slice(a, b).matchAll(pattern(find))) hits.push([a + m.index, a + m.index + m[0].length]);
            from += line.length + 1;
          }
          if (hits.length !== 1) throw hits.length ? several(find) : none(find);
          found.push([...hits[0], put, find]);
        }
        found.sort((a, b) => a[0] - b[0]);
        for (const [i, [start, , , find]] of found.entries()) if (i && start < found[i - 1][1]) throw meet(find);
        let now = was;
        for (const [start, end, put] of [...found].reverse()) now = now.slice(0, start) + put + now.slice(end);
        box.value = now;
        dirty = true;
        // one step for both ways: the text as it stands gives way to the text as it stood
        let other = was;
        const turn = () => {
          if (box.value !== now) throw new Error("The message has been changed since, so it was left as it is.");
          box.value = other;
          [now, other] = [other, now];
        };
        return { made: found.length, ...steps(turn, turn), ranges: () => [] };
      }
      // The text within the selection, by its lines: each line with the pieces of text that make
      // it up there, a piece being a text node and the part of it that is selected.
      const ed = $("c-editor"), sel = getSelection(), chosen = sel.rangeCount ? sel.getRangeAt(0) : null;
      if (!chosen || chosen.collapsed || !ed.contains(chosen.commonAncestorContainer)) throw nothing();
      const { shows, lineEnd } = parts(ed), lines = new Map();
      for (let walk = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT), t; (t = walk.nextNode());) {
        if (!chosen.intersectsNode(t) || !shows(t.parentElement)) continue;
        const from = t === chosen.startContainer ? chosen.startOffset : 0, to = t === chosen.endContainer ? chosen.endOffset : t.data.length;
        if (to <= from) continue;
        const key = lineEnd(t).last;
        if (!lines.has(key)) lines.set(key, []);
        lines.get(key).push([t, from, to]);
      }
      if (!lines.size) throw new Error("The selection holds no text that is shown, so there is nothing in it to change.");
      const order = [...lines.values()];
      // Each edit's place: the line it is in, and where in that line's selected text it begins and ends.
      const found = [];
      for (const { find, with: put } of edits) {
        const hits = [];
        for (const [n, pieces] of order.entries()) for (const m of pieces.map(([t, from, to]) => t.data.slice(from, to)).join("").matchAll(pattern(find))) hits.push([n, m.index, m.index + m[0].length]);
        if (hits.length !== 1) throw hits.length ? several(find) : none(find);
        found.push([...hits[0], put, find]);
      }
      found.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
      for (const [i, [n, start, , , find]] of found.entries()) if (i && n === found[i - 1][0] && start < found[i - 1][2]) throw meet(find);
      // The place as a range of the page: the text node and the offset in it of each end.
      const at = (pieces, offset, end) => {
        let passed = 0;
        for (const [t, from, to] of pieces) {
          if (end ? offset <= passed + to - from : offset < passed + to - from) return [t, from + offset - passed];
          passed += to - from;
        }
        return [pieces.at(-1)[0], pieces.at(-1)[2]];
      };
      const ranges = found.map(([n, start, end]) => { const r = document.createRange(); r.setStart(...at(order[n], start, false)); r.setEnd(...at(order[n], end, true)); return r; });
      // Made from the last to the first, so that a place found earlier in a text is still where
      // it was found when its turn comes.
      const done = [];
      for (let i = found.length - 1; i >= 0; i--) {
        const made = document.createDocumentFragment();
        for (const [k, line] of found[i][3].split("\n").entries()) { if (k) made.append(document.createElement("br")); if (line) made.append(document.createTextNode(line)); }
        const nodes = [...made.childNodes], taken = [...ranges[i].extractContents().childNodes];
        ranges[i].insertNode(made);
        done.push({ nodes, inside: nodes, outside: taken });
      }
      dirty = true;
      const standing = nodes => nodes.filter(n => n.isConnected && ed.contains(n));
      // one step for both ways, for every place still there: what stands in it gives way to what stood in it before
      const turn = () => {
        let turned = 0;
        for (const d of done) {
          const there = standing(d.inside);
          if (!there.length) continue;
          for (const n of d.outside) there[0].parentNode.insertBefore(n, there[0]);
          for (const n of there) n.remove();
          [d.inside, d.outside] = [d.outside, there];
          turned++;
        }
        if (!turned) throw new Error("None of what was changed is in the message any more.");
      };
      return { made: done.length, ...steps(turn, turn), ranges: () => done.map(d => {
        const now = standing(d.nodes);
        if (!now.length) return null;
        const range = document.createRange();
        range.setStartBefore(now[0]); range.setEndAfter(now.at(-1));
        return range;
      }).filter(Boolean) };
    },
    // What the user has selected gives way, whole, to what the assistant wrote, which may be
    // anything the user asked for: other words, more or fewer paragraphs, another form (html: the
    // assistant's HTML, cleaned as anything put into the editor is, or its plain text as a block
    // for each line; text: the plain text; formatted: whether it wrote HTML). Nothing outside the
    // selection changes. The selection is the user's word for what may change: a quoted or
    // forwarded message and the signature go with it where the user selected them, which is how
    // an assistant takes them out of a message when asked to. Words selected within one line are
    // replaced within it when what was written is of one line too. Otherwise the selected lines are replaced as lines: what of the first and of
    // the last was not selected stays, and joins the first and the last line written where those
    // are plain lines. Answers as add does; undo puts back what stood there, as it was.
    rewrite({ html, text, formatted }) {
      const nothing = () => new Error("Nothing is selected in the text of the message being written. Ask the user to select what is to be changed.");
      if (!draft.html) {
        // All that is selected, but for the empty lines at its end, which stay between what is
        // written and what follows it.
        const box = $("c-text"), was = box.value, first = box.selectionStart ?? 0;
        let last = box.selectionEnd ?? 0;
        while (last > first && /\s/.test(was[last - 1])) last--;
        if (last <= first) throw nothing();
        box.setRangeText(text, first, last, "end");
        dirty = true;
        // one step for both ways: what stands there now gives way to what stood there before
        let now = text, other = was.slice(first, last);
        const turn = () => {
          if (box.value.slice(first, first + now.length) !== now) throw new Error("The text has been changed since, so it was left as it is.");
          box.setRangeText(other, first, first + now.length, "preserve");
          [now, other] = [other, now];
        };
        return { wrote: null, ...steps(turn, turn) };
      }
      const ed = $("c-editor"), sel = getSelection(), chosen = sel.rangeCount ? sel.getRangeAt(0) : null;
      if (!chosen || chosen.collapsed || !ed.contains(chosen.commonAncestorContainer)) throw nothing();
      // The text the selection holds, piece by piece: what is replaced runs from the first of it
      // to the last.
      const { blockOf } = parts(ed), held = [];
      for (let walk = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT), t; (t = walk.nextNode());) {
        if (!chosen.intersectsNode(t)) continue;
        const from = t === chosen.startContainer ? chosen.startOffset : 0, to = t === chosen.endContainer ? chosen.endOffset : t.data.length;
        if (to > from && t.data.slice(from, to).trim()) held.push([t, from, to]);
      }
      if (!held.length) throw nothing();
      const range = document.createRange();
      range.setStart(held[0][0], held[0][1]); range.setEnd(held.at(-1)[0], held.at(-1)[2]);
      const made = document.createElement("template");
      made.innerHTML = editorSafe(html);
      const BLOCKS = "div, p, ul, ol, li, table, blockquote, pre, h1, h2, h3, h4, hr";
      const standing = nodes => nodes.filter(n => n.isConnected && ed.contains(n));
      // What the assistant wrote, as it stands in the message, for the tint and for showing it as typed.
      let written;
      const rangeOf = () => {
        const now = standing(written);
        if (!now.length) return null;
        const r = document.createRange();
        r.setStartBefore(now[0]); r.setEndAfter(now.at(-1));
        return r;
      };
      // One step for both ways: the nodes that stand there now give way to those that stood there before.
      let inside, outside;
      const turn = () => {
        const there = standing(inside);
        if (!there.length) throw new Error("What stood in place of the selection is no longer in the message.");
        for (const n of outside) there[0].parentNode.insertBefore(n, there[0]);
        for (const n of there) n.remove();
        [inside, outside] = [outside, there];
      };
      const oneLine = formatted ? !made.content.querySelector(BLOCKS) : !text.includes("\n");
      if (oneLine && blockOf(range.startContainer) === blockOf(range.endContainer)) {
        written = formatted ? [...made.content.childNodes] : [document.createTextNode(text)];
        if (!written.length) throw new Error("Nothing to put in place of the selection: nothing is left of the body once it is cleaned.");
        outside = [...range.extractContents().childNodes];
        for (const n of [...written].reverse()) range.insertNode(n);
        inside = written.slice();
      } else {
        const fresh = [...made.content.childNodes].filter(n => n.nodeType === 1 || n.data.trim());
        if (!fresh.length) throw new Error("Nothing to put in place of the selection: nothing is left of the body once it is cleaned.");
        written = fresh.slice();
        // The block that holds the selected lines side by side: not a line itself, nor the inside of a list or a table.
        const isLine = n => blocky(n) && ![...n.children].some(blocky);
        let holder = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
        while (holder !== ed && (!blocky(holder) || isLine(holder) || holder.matches("ul, ol, li, table, thead, tbody, tr, td, th"))) holder = holder.parentElement;
        const childOf = n => { while (n.parentNode !== holder) n = n.parentNode; return n; };
        const first = childOf(range.startContainer), last = childOf(range.endContainer);
        // What of the first and of the last was not selected, as copies: before the selection, and after it.
        const head = document.createRange(), tail = document.createRange();
        head.setStartBefore(first); head.setEnd(range.startContainer, range.startOffset);
        tail.setStart(range.endContainer, range.endOffset); tail.setEndAfter(last);
        const lead = [...head.cloneContents().childNodes].filter(n => !blank(n)), trail = [...tail.cloneContents().childNodes].filter(n => !blank(n));
        // A plain line takes the words that go on in it: told by its tag here, since what is not
        // in the page yet has no layout to tell it by.
        const plainLine = n => n?.nodeType === 1 && /^(div|p)$/.test(n.localName) && !n.querySelector(BLOCKS);
        const before = lead.at(-1), after = trail[0];
        if (plainLine(before) && plainLine(fresh[0])) {
          const words = [...fresh[0].childNodes];
          before.append(...words);
          written.splice(0, 1, ...words);
          fresh.shift();
        }
        if (plainLine(after) && plainLine(fresh.at(-1))) {
          const line = fresh.at(-1), words = [...line.childNodes];
          line.append(...after.childNodes);
          written.splice(written.indexOf(line), 1, ...words);
          trail.shift();
        } else if (plainLine(after) && !fresh.length && plainLine(before)) { before.append(...after.childNodes); trail.shift(); }
        if (!written.length) throw new Error("Nothing to put in place of the selection: the body holds no text.");
        outside = [];
        for (let n = first; n; n = n.nextSibling) { outside.push(n); if (n === last) break; }
        inside = [...lead, ...fresh, ...trail];
        const next = last.nextSibling;
        for (const n of outside) n.remove();
        for (const n of inside) holder.insertBefore(n, next);
      }
      const end = standing(written).at(-1);
      if (end) sel.collapse(end.parentNode, [...end.parentNode.childNodes].indexOf(end) + 1);
      dirty = true;
      return { wrote: rangeOf(), ...steps(turn, turn, rangeOf) };
    },
    // The message being written, as it stands, for an assistant to read; nothing of it is
    // changed. Its text is the editor's HTML (html), or what the plain text box holds (text),
    // with marks put into it: caret where the caret is, or from and to around what is selected.
    // caret tells whether the caret is in the text at all; selected is the text selected there.
    look({ caret: mark, from: opens, to: closes }) {
      const who = f => f.list.map(a => ({ name: a.name || "", email: a.email }));
      const out = { kind: $("c-title").textContent, from: $("c-from").value, to: who(fields.to), cc: who(fields.cc), bcc: who(fields.bcc), subject: $("c-subject").value,
        files: [...draft.files.map(f => f.name), ...draft.refs.map(r => r.filename)], html: null, text: null, caret: false, selected: "" };
      if (draft.html) {
        const ed = $("c-editor"), sel = getSelection(), chosen = sel.rangeCount ? sel.getRangeAt(0) : null, copy = ed.cloneNode(true);
        // the same place in the copy: the way down from the editor, child by child
        const put = (node, offset, words) => {
          const way = [];
          for (let n = node; n !== ed; n = n.parentNode) way.unshift([...n.parentNode.childNodes].indexOf(n));
          const there = document.createRange();
          there.setStart(way.reduce((n, i) => n.childNodes[i], copy), offset);
          there.insertNode(document.createTextNode(words));
        };
        if (chosen && ed.contains(chosen.endContainer)) {
          out.caret = true;
          // the later place first, which leaves the way to the earlier one as it was
          if (chosen.collapsed || !ed.contains(chosen.startContainer)) put(chosen.endContainer, chosen.endOffset, mark);
          else { put(chosen.endContainer, chosen.endOffset, closes); put(chosen.startContainer, chosen.startOffset, opens); out.selected = sel.toString(); }
        }
        out.html = copy.innerHTML;
      } else {
        const box = $("c-text"), start = box.selectionStart ?? 0, end = box.selectionEnd ?? start, v = box.value;
        out.text = end > start ? v.slice(0, start) + opens + v.slice(start, end) + closes + v.slice(end) : v.slice(0, start) + mark + v.slice(start);
        out.caret = true; out.selected = v.slice(start, end);
      }
      return out;
    },
    // Saved to Drafts: "" when it was, else why not. passing: as the composer's own autosave
    // saves, which leaves an address the user is still typing as it is.
    save: (passing = false) => saveNow(true, { tick: passing }),
    savedId: () => draft?.savedId || null,
  })).catch(e => console.error("AI access could not start:", e));
}
