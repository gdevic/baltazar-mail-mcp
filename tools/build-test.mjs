// The overlay (tools/build.js): the build with AI access is the app's own build with this
// repository's files added (the page's side of AI access, and the assistant's server in a folder
// of its own, which runs from there), its glue appended to the files it names, and one address
// added to what the pages may reach, and nothing else of the app's build is touched; how the
// build reads what a piece of glue uses and watches of the app's file.
// node tools/build-test.mjs
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const { buildForTest, glued, listed, declares, functionText, version, appVersion, madeFor, app, ROOT, SOURCE, MARK } = createRequire(import.meta.url)("./build.js");
let fail = 0;
const ok = (cond, what) => { if (!cond) { fail++; console.log("FAIL", what); } };
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
const json = f => JSON.parse(fs.readFileSync(f, "utf8"));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------- the version: the app's, and after a dash the number of a release of this side alone ----------
ok(/^\d+\.\d+\.\d+(-[1-9]\d*)?$/.test(version()) && madeFor() === appVersion(), `this repository's version (${version()}) is the version of the app beside it (${appVersion()})`);

// ---------- the build with AI access beside the app's own ----------
// What the build adds, each file as the build names it, with where this repository has it.
const SERVER = "server/baltazar-mail-mcp.mjs";
const from = (dir, to = "") => fs.readdirSync(path.join(ROOT, dir)).map(f => [to + f, path.join(ROOT, dir, f)]);
const sources = Object.fromEntries([...from("ext"), ...from("server", "server/")]), added = Object.keys(sources).sort(), glue = glued();
ok(added.includes(SERVER), `the assistant's server is among what the build adds: ${added.join(", ")}`);
for (const edition of Object.keys(app.EDITIONS)) {
  const plain = buildForTest(edition, { plain: true }), ours = buildForTest(edition);
  const files = dir => walk(dir).map(f => path.relative(dir, f).replaceAll("\\", "/")).sort();
  ok(same(files(ours), [...files(plain), ...added].sort()), `${edition}: the files are the app's and the ${added.length} added: ` + files(ours).filter(f => !files(plain).includes(f)).join(", "));
  for (const f of files(plain)) {
    const a = fs.readFileSync(path.join(plain, f)), b = fs.readFileSync(path.join(ours, f));
    if (glue.includes(f)) {
      const was = a.toString("utf8").replace(/\s*$/, ""), now = b.toString("utf8");
      ok(now.startsWith(was) && now.split(MARK).length === 2 && now.slice(was.length).trimStart().startsWith(f.endsWith(".css") ? "/* " + MARK : "// " + MARK), `${edition}: ${f} is the app's own, whole, with the glue after it`);
    } else if (f !== "manifest.json") ok(a.equals(b), `${edition}: ${f} is the app's own, byte for byte`);
  }
  for (const f of added) ok(fs.readFileSync(path.join(ours, f)).equals(fs.readFileSync(sources[f])), `${edition}: ${f} is this repository's`);
  const helped = spawnSync(process.execPath, [path.join(ours, SERVER), "help"], { encoding: "utf8", input: "", timeout: 20000 });
  ok(helped.status === 0 && / setup /.test(helped.stdout), `${edition}: the server runs from the build's own folder: ` + `${helped.stdout}${helped.stderr}`.slice(0, 200));
  const mp = json(path.join(plain, "manifest.json")), mo = json(path.join(ours, "manifest.json"));
  ok(!JSON.stringify(mo).includes("server/"), `${edition}: the manifest names nothing in the server's folder`);
  const connect = m => m.content_security_policy.extension_pages.match(/connect-src ([^;]*)/)[1].split(" ");
  const rest = m => { const { content_security_policy, version_name, ...others } = m; return others; };
  ok(same(connect(mo), [...connect(mp), SOURCE]), `${edition}: the pages may reach what the app's may, and the assistant's server: ` + connect(mo).join(" "));
  ok(same(mo.content_security_policy.extension_pages.replace(` ${SOURCE}`, ""), mp.content_security_policy.extension_pages) && mo.content_security_policy.sandbox === mp.content_security_policy.sandbox, `${edition}: the rest of the Content Security Policy is the app's`);
  ok(same(rest(mo), rest(mp)) && mo.version === appVersion() && mo.version_name === `${version()} with AI access` && !("version_name" in mp), `${edition}: the manifest is otherwise the app's (its permissions, its key, its version), and says what it is: ${mo.version_name}`);
}

// ---------- what a piece of glue says of the app's file ----------
{
  for (const name of glue.filter(n => n.endsWith(".js"))) {
    const text = fs.readFileSync(path.join(ROOT, "glue", name), "utf8");
    ok(listed(text, "uses").length > 3 && listed(text, "watches").length > 0, `glue/${name} says what it uses and what it watches`);
    ok(text.startsWith("// " + MARK), `glue/${name} begins with the mark that tells it from the app's own code`);
  }
  const code = 'import * as api from "./api.js";\nimport { esc, noBidi as plain } from "./text.js";\nconst $ = id => id, state = { a: 1 };\nlet busy = false, kept;\nexport async function run(fn) {\n  const inner = 1;\n  return fn(inner);\n}\nfunction* each() {}\nclass Field {}\n';
  ok(["api", "esc", "plain", "$", "state", "busy", "kept", "run", "each", "Field"].every(n => declares(code, n)), "a name the file declares at its top level, or imports, is found: " + ["api", "esc", "plain", "$", "state", "busy", "kept", "run", "each", "Field"].filter(n => !declares(code, n)));
  ok(!["inner", "fn", "a", "id", "tate", "bus", "missing"].some(n => declares(code, n)), "a name inside a function, a part of a name, and a name that is not there are not: " + ["inner", "fn", "a", "id", "tate", "bus", "missing"].filter(n => declares(code, n)));
  ok(functionText(code, "run") === "export async function run(fn) {\n  const inner = 1;\n  return fn(inner);\n}" && functionText(code, "walk") === null, "a watched function is its text to its closing brace");
}
console.log(fail ? `${fail} FAIL` : "PASS");
process.exit(fail ? 1 : 0);
