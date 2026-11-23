// ---------- AI access ----------
// Appended to the app's compose.js by this repository's build (tools/build.js): it stands inside
// that module and uses its functions by name, and the app's own source has none of it. It hands
// mcp.js the composer's conversion of HTML to plain text, and the two things an assistant's draft
// needs of the open composer: to put its recipients, subject and text in, and to save to Drafts.
// Nothing here sends a message or discards one.
// uses: $ draft dirty fields editorSafe toText saveNow
// watches: openNow saveNow
{
  import("./mcp.js").then(m => m.composer({
    toText,
    // What the assistant wrote goes on top, above the signature and the quoted original the
    // composer opened with. Recipients given replace those it worked out; html is cleaned as
    // anything put into the editor is.
    fill({ to, cc, bcc, subject, html, text }) {
      if (to) fields.to.set(to);
      if (cc) fields.cc.set(cc);
      if (bcc) fields.bcc.set(bcc);
      if (!fields.cc.isEmpty() || !fields.bcc.isEmpty()) for (const id of ["c-cc-row", "c-bcc-row"]) $(id).classList.remove("hidden");
      if (subject != null) $("c-subject").value = subject;
      if (draft.html) $("c-editor").insertAdjacentHTML("afterbegin", editorSafe(html));
      else $("c-text").value = `${text}\n${$("c-text").value}`;
      dirty = true;
    },
    // Saved to Drafts: "" when it was, else why not.
    save: () => saveNow(true),
    savedId: () => draft?.savedId || null,
  })).catch(e => console.error("AI access could not start:", e));
}
