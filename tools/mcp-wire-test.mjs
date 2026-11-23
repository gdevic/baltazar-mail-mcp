// AI access, the part without a page (ext/mcpwire.js): the pairing handshake and the signing of
// messages against golden values, what a forged or altered message gets, the row an assistant is
// given for each edition's message, and that the port is the same wherever it is written.
// node tools/mcp-wire-test.mjs
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { PORT, WIRE, isCode, newCode, idOf, proofOf, sessionKey, seal, unseal, rowShaper } from "../ext/mcpwire.js";

const build = createRequire(import.meta.url)("./build.js");
// rows are shaped with the app's own removal of direction controls, as the page shapes them
const shape = rowShaper((await import(pathToFileURL(path.join(build.APP, "ext", "text.js")))).noBidi);
let fail = 0;
const ok = (cond, what) => { if (!cond) { fail++; console.log("FAIL", what); } };

// ---------- the handshake and the seal ----------
{
  const code = "00112233445566778899aabbccddeeff", cn = "0123456789abcdef0123456789abcdef", sn = "fedcba9876543210fedcba9876543210";
  const proof = await proofOf(code, cn, sn);
  ok(proof === "40067144c1c8e6968808f50d6eac75dff65a5efd478b16195bddcc86e9cc7224", "the server's proof is the golden value: " + proof);
  ok(await proofOf(code, sn, cn) !== proof && await proofOf(code.replace("0", "1"), cn, sn) !== proof, "another code, or the numbers the other way round, give another proof");
  const id = await idOf(code);
  ok(id === "5c4d87ad83e74827" && await idOf(code.replace("0", "1")) !== id && !proof.includes(id), "a code's id is the golden value, and another code's is another: " + id);
  const key = await sessionKey(code, cn, sn), msg = { sid: sn, n: 1, role: "tab" };
  const sealed = await seal(key, "c", "/join", msg);
  ok(sealed === 'fd5ff1b7deec0fb16a0f511191da0e336a9a029f63d41086999ac34750bce4ec\n{"sid":"fedcba9876543210fedcba9876543210","n":1,"role":"tab"}', "a sealed message is the golden value: " + sealed);
  ok(JSON.stringify(await unseal(key, "c", "/join", sealed)) === JSON.stringify(msg), "a sealed message opens to what was sealed");
  ok(await unseal(key, "s", "/join", sealed) === null && await unseal(key, "c", "/next", sealed) === null, "it does not open as an answer, nor at another path");
  ok(await unseal(key, "c", "/join", sealed.replace('"n":1', '"n":2')) === null && await unseal(key, "c", "/join", sealed.replace(/^./, c => c === "0" ? "1" : "0")) === null, "an altered message or mac does not open");
  ok(await unseal(await sessionKey(code, cn, cn), "c", "/join", sealed) === null, "another session's key does not open it");
  ok(await unseal(key, "c", "/join", "") === null && await unseal(key, "c", "/join", "x\n{}") === null && await unseal(key, "c", "/join", null) === null, "what is not a sealed message does not open");
  const mine = newCode();
  ok(isCode(mine) && mine !== newCode() && !isCode("ABCDEF0123456789abcdef0123456789") && !isCode(mine.slice(1)) && !isCode(null), "a pairing code is 32 lower-case hex digits, new each time");
}

// ---------- rows ----------
{
  // a Yahoo row as its list gives it, found by a search (hit markers in the subject)
  const yahoo = { id: "AB12", conversationId: "4001", folder: { id: "1", name: "Inbox" }, snippet: "  Dear  all,\n the plan ", attachmentCount: 3, attachments: [{ disposition: "attachment" }, { disposition: "attachment" }, { disposition: "inline" }],
    flags: { read: false, flagged: true }, headers: { subject: "The ^_plan^_ for May", date: "1767225600",
      from: [{ name: "Ana Kovač", email: "ana@example.com" }], to: [{ email: "me@example.com" }, { name: "bo@example.com", email: "bo@example.com" }], cc: [] } };
  const want = { id: "AB12", folder: "1", from: ["Ana Kovač <ana@example.com>"], to: ["me@example.com", "bo@example.com"], subject: "The plan for May", date: "2026-01-01T00:00:00.000Z",
    snippet: "Dear all, the plan", read: false, starred: true, attachments: 2 };
  ok(JSON.stringify(shape(yahoo)) === JSON.stringify(want), "a Yahoo row: " + JSON.stringify(shape(yahoo)));
  // a Gmail row as toRow builds it: no attachmentCount for a body's message, inline parts apart
  const gmail = { id: "18c0ffee", threadId: "18c0ffee", labelIds: ["INBOX"], folder: { id: "INBOX", name: "Inbox" }, snippet: "x".repeat(300),
    attachments: [{ disposition: "inline", filename: "logo.png" }, { disposition: "attachment", filename: "a.pdf" }], flags: { read: true, flagged: false },
    headers: { subject: "", date: "0", from: [{ name: "", email: "noreply@example.org" }], to: [], cc: [{ name: `Carl ${String.fromCharCode(0x202e)}evil`, email: "carl@example.org" }] } };
  const g = shape(gmail);
  ok(g.attachments === 1 && g.snippet.length === 200 && g.date === "" && g.subject === "" && g.read === true && g.starred === false && g.folder === "INBOX", "a Gmail row: " + JSON.stringify(g));
  ok(JSON.stringify(g.cc) === JSON.stringify(["Carl evil <carl@example.org>"]) && JSON.stringify(g.from) === JSON.stringify(["noreply@example.org"]), "names lose their direction controls, and Cc shows only when there is one: " + JSON.stringify([g.from, g.cc]));
  ok(JSON.stringify(shape({})) === JSON.stringify({ id: "", folder: "", from: [], to: [], subject: "", date: "", snippet: "", read: false, starred: false, attachments: 0 }), "a row with nothing in it: " + JSON.stringify(shape({})));
}

// ---------- one port, one version ----------
{
  const server = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server", "baltazar-mail-mcp.mjs"), "utf8");
  ok(build.PORT === PORT && new RegExp(`BALTAZAR_MAIL_PORT\\) \\|\\| ${PORT};`).test(server), `the build, the page and the server name the same port (${PORT})`);
  ok(new RegExp(`const WIRE = ${WIRE};`).test(server), "the page and the server speak the same version");
}
console.log(fail ? `${fail} FAIL` : "PASS");
process.exit(fail ? 1 : 0);
