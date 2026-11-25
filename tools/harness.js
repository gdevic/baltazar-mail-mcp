// The app's own test harness (its tools/harness.js: the extension in Chromium against the mocked
// mail services), launching the build with AI access, and the MCP server beside it.
//
// The app's harness builds the extension with the app's build. Before the harness is loaded, the
// build it will ask for (the one into the app's out/test) is answered with this repository's
// build of the same edition, in out/test here; every other build is the app's own. So every suite
// written for the harness runs the extension with AI access, the app's own suites too:
// node -r ./tools/harness.js ../baltazar-mail/tools/review.js
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");
const { app, APP, ROOT, PORT, buildForTest } = require("./build.js");

const plain = app.build;
const forTests = (edition, to) => !!to && !!app.EDITIONS[edition] && path.resolve(to) === path.join(APP, "out", "test", app.EDITIONS[edition].folder);
app.build = (edition, opts = {}) => forTests(edition, opts.to) && !opts.store ? buildForTest(edition) : plain(edition, opts);
const harness = require(path.join(APP, "tools", "harness.js"));

// The MCP server (server/baltazar-mail-mcp.mjs), started as an assistant starts it and given the
// pairing code. It listens on a free port of its own, so a server that an assistant on this
// machine runs is left alone; what the page asks of the port the extension knows is passed on to
// it, and noted (asked: the paths). rpc and call speak to it as the assistant does: a tool's
// answer is JSON (value), after a line of the server's own words where it has any and a line
// about its source when it holds mail, and after it the text given as it is (body: a message's,
// a small attachment's); an error is words (text).
async function mcpServer(h, code, env = {}) {
  const port = await new Promise(done => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => done(p)); }); });
  const child = spawn(process.execPath, [path.join(ROOT, "server", "baltazar-mail-mcp.mjs")], { stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, BALTAZAR_MAIL_PORT: String(port), BALTAZAR_MAIL_CODE: code, BALTAZAR_MAIL_WAIT: "8000", ...env } });
  const waiting = new Map(), said = [], asked = [];
  let buf = "", id = 0;
  child.stdout.setEncoding("utf8").on("data", d => {
    buf += d;
    for (let at; (at = buf.indexOf("\n")) >= 0;) { const m = JSON.parse(buf.slice(0, at)); buf = buf.slice(at + 1); waiting.get(m.id)?.(m); waiting.delete(m.id); }
  });
  child.stderr.setEncoding("utf8").on("data", d => said.push(d));
  const own = `http://127.0.0.1:${PORT}/`;
  const handler = async route => {
    const req = route.request();
    asked.push(new URL(req.url()).pathname);
    try { await route.fulfill({ response: await route.fetch({ url: req.url().replace(own, `http://127.0.0.1:${port}/`), timeout: 40000 }) }); }
    catch { await route.abort("connectionrefused").catch(() => {}); }
  };
  await h.ctx.route(own + "**", handler);
  const rpc = (method, params) => new Promise(done => { const mine = ++id; waiting.set(mine, done); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mine, method, params }) + "\n"); });
  const call = async (name, args = {}) => {
    const r = (await rpc("tools/call", { name, arguments: args })).result, text = r.content[0].text;
    const at = text.search(/^[[{"]/m);
    let value; try { value = JSON.parse(at < 0 ? text : text.slice(at)); } catch { /* words */ }
    return { error: !!r.isError, text, value, body: r.content[1]?.text ?? "" };
  };
  const stop = async () => { await h.ctx.unroute(own + "**", handler).catch(() => {}); child.stdin.end(); await new Promise(done => { child.once("exit", done); setTimeout(() => { child.kill(); done(); }, 3000); }); };
  return { rpc, call, stop, said, asked, port };
}

module.exports = { ...harness, mcpServer };
