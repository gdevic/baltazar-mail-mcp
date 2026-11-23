// Builds Baltazar Mail with AI access: each edition as the app's own repository builds it (the
// folder beside this one, or BALTAZAR_MAIL_REPO), with this repository's files laid over the
// result, into dist/ here. The app's repository is read and never written: its own build is asked
// for a copy in out/ here, and the overlay is made on that copy.
//
// The overlay is three things. The files of ext/ are added. Each file of glue/ is appended to the
// app's file of the same name: appended to a module, the glue stands inside it and uses the
// module's own functions by name, which is how AI access reaches the folder pane, the undo history
// and the composer without the app's source knowing of it. And the manifest lets the pages reach
// the one address on this computer where the assistant's server listens.
//
// A piece of glue says in its first lines which names of the app's file it uses ("uses:") and
// which of its functions it follows closely enough that a change to one should be looked at
// ("watches:"). A name that is gone stops the build. A watched function that has changed since
// its text was last recorded (glue/watched.json) is reported, and the build goes on; when the glue
// has been compared with it, --reviewed records the new text.
//
// VERSION here is the app's version this repository goes with, and after a dash the number of a
// release of this side alone (0.23.0, then 0.23.0-2). A build beside another version of the app
// says so; --release, which the Release workflow builds with, refuses it, as it refuses a watched
// function that has changed.
//
// node tools/build.js [yahoo|gmail] [--reviewed] [--release]
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const APP = path.resolve(process.env.BALTAZAR_MAIL_REPO || path.join(ROOT, "..", "baltazar-mail"));
if (!fs.existsSync(path.join(APP, "tools", "build.js"))) throw new Error(`Baltazar Mail's repository was not found at ${APP}. Put it beside this one, or name it in BALTAZAR_MAIL_REPO.`);
const app = require(path.join(APP, "tools", "build.js"));
const appBuild = app.build;      // the app's own build, whatever is put in its place later (tools/harness.js)
const ADDED = path.join(ROOT, "ext"), GLUE = path.join(ROOT, "glue"), WATCHED = path.join(GLUE, "watched.json");
const PORT = 18417, SOURCE = `http://127.0.0.1:${PORT}`;
const MARK = "---------- AI access ----------";
const version = () => fs.readFileSync(path.join(ROOT, "VERSION"), "utf8").trim();
const appVersion = () => fs.readFileSync(path.join(APP, "VERSION"), "utf8").trim();
const madeFor = () => version().replace(/-\d+$/, "");
const glued = () => fs.readdirSync(GLUE).filter(n => n !== path.basename(WATCHED)).sort();

// ---------- what the glue says of the app's file ----------
const listed = (glue, word) => (glue.match(new RegExp(`^(?://|/\\*) ${word}: (.*?)(?: \\*/)?$`, "m"))?.[1] || "").split(/[\s,]+/).filter(Boolean);
// Whether the file declares the name at its top level, or imports it.
function declares(code, name) {
  const alone = `(?<![\\w$])${name.replace(/[$]/g, "\\$&")}(?![\\w$])`;
  if (new RegExp(`^(?:export\\s+)?(?:(?:async\\s+)?function\\*?|class)\\s+${alone}|^import\\s[^\\n]*?${alone}[^\\n]*?\\sfrom\\s`, "m").test(code)) return true;
  for (const m of code.matchAll(/^(?:export\s+)?(?:const|let|var)\s+([^\n]*)/gm)) if (declared(m[1]).includes(name)) return true;
  return false;
}
// The names a const, let or var declares, from the line it begins on: the one after the word,
// and the one after each comma that is inside no bracket and no string.
function declared(line) {
  const out = [];
  for (let i = 0, depth = 0, next = true; i < line.length; i++) {
    const c = line[i];
    if (c === '"' || c === "'" || c === "`") { for (i++; i < line.length && line[i] !== c; i++) if (line[i] === "\\") i++; next = false; }
    else if ("([{".includes(c)) { depth++; next = false; }
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) next = true;
    else if (next && depth === 0 && /[A-Za-z_$]/.test(c)) { const id = line.slice(i).match(/^[\w$]+/)[0]; out.push(id); i += id.length - 1; next = false; }
    else if (!/\s/.test(c)) next = false;
  }
  return out;
}
// The text of a function declared at the top level, to its closing brace in the first column.
function functionText(code, name) {
  const at = code.search(new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\(`, "m"));
  if (at < 0) return null;
  const end = code.indexOf("\n}", at);
  return end < 0 ? null : code.slice(at, end + 2).replace(/\r\n/g, "\n");
}
const digest = text => crypto.createHash("sha256").update(text).digest("hex");
const recorded = () => { try { return JSON.parse(fs.readFileSync(WATCHED, "utf8")); } catch { return {}; } };

// What the glue watches in the app's files, as they are now: { "mail.js": { doMove: digest } }.
function watchedNow() {
  const out = {};
  for (const name of glued()) {
    const names = listed(fs.readFileSync(path.join(GLUE, name), "utf8"), "watches");
    if (!names.length) continue;
    const code = fs.readFileSync(path.join(APP, "ext", name), "utf8");
    out[name] = {};
    for (const fn of names) {
      const text = functionText(code, fn);
      if (text == null) throw new Error(`glue/${name} watches ${fn}, which the app's ${name} no longer has`);
      out[name][fn] = digest(text);
    }
  }
  return out;
}
// The watched functions whose text is not the one recorded: ["mail.js: doMove"].
function changed() {
  const now = watchedNow(), was = recorded();
  return Object.entries(now).flatMap(([file, fns]) => Object.keys(fns).filter(fn => was[file]?.[fn] !== fns[fn]).map(fn => `${file}: ${fn}`));
}

// ---------- the overlay ----------
// dir: a folder holding the app's own build of the edition, which becomes the build with AI access.
function overlay(edition, dir) {
  for (const name of fs.readdirSync(ADDED)) {
    if (fs.existsSync(path.join(APP, "ext", name)) || fs.existsSync(path.join(APP, edition, name))) throw new Error(`the app has a file named ${name} of its own`);
    fs.copyFileSync(path.join(ADDED, name), path.join(dir, name));
  }
  for (const name of glued()) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) throw new Error(`glue/${name} has no file of the app to go with`);
    const text = fs.readFileSync(file, "utf8"), glue = fs.readFileSync(path.join(GLUE, name), "utf8").replace(/\r\n/g, "\n");
    if (text.includes(MARK)) throw new Error(`${name} of the app's build has the glue in it already`);
    const gone = listed(glue, "uses").filter(n => !declares(text, n));
    if (gone.length) throw new Error(`glue/${name} uses ${gone.join(", ")}, which the app's ${name} no longer declares`);
    // the glue takes the line endings of the file it joins
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    fs.writeFileSync(file, text.replace(/\s*$/, "") + eol + eol + glue.replace(/\n/g, eol));
    if (name.endsWith(".js")) {
      const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(`${name} with its glue is not a module that parses:\n${r.stderr}`);
    }
  }
  const at = path.join(dir, "manifest.json"), manifest = JSON.parse(fs.readFileSync(at, "utf8"));
  const csp = manifest.content_security_policy, pages = csp.extension_pages.replace(/(^|;\s*)(connect-src [^;]*)/, `$1$2 ${SOURCE}`);
  if (pages === csp.extension_pages) throw new Error(`the ${edition} manifest has no connect-src to add the assistant's server to`);
  manifest.content_security_policy = { ...csp, extension_pages: pages };
  // what the browser's list of extensions shows for the version, so the two builds tell apart;
  // the version itself is the app's
  manifest.version_name = madeFor() === manifest.version ? `${version()} with AI access` : `${manifest.version} with AI access (made for ${madeFor()})`;
  fs.writeFileSync(at, JSON.stringify(manifest, null, 2) + "\n");
  return dir;
}

// The app's build in base, with the overlay, brought to out. It is put together beside its target
// and brought over file by file, as the app's own build does: a file that has not changed is not
// written, so a browser that has the folder loaded, or another suite running from it, never sees
// it half built.
function laidOver(edition, base, out) {
  const stage = `${out}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.rmSync(stage, { recursive: true, force: true });
  try {
    fs.cpSync(base, stage, { recursive: true });
    overlay(edition, stage);
    app.sync(stage, out);
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  return out;
}
const folderOf = edition => { const f = app.EDITIONS[edition]?.folder; if (!f) throw new Error(`unknown edition ${edition}`); return f; };

// The edition for a browser to load: dist/<folder> here.
function build(edition) {
  const folder = folderOf(edition);
  return laidOver(edition, appBuild(edition, { to: path.join(ROOT, "out", "base", folder) }), path.join(ROOT, "dist", folder));
}

// The edition as the test suites load it: built the same on every machine (no local.json), in
// out/test here. plain: the app's own build alone, to compare with.
function buildForTest(edition, { plain = false } = {}) {
  const folder = folderOf(edition), base = appBuild(edition, { local: {}, to: path.join(ROOT, "out", plain ? "plain" : "test-base", folder) });
  return plain ? base : laidOver(edition, base, path.join(ROOT, "out", "test", folder));
}

if (require.main === module) {
  const named = process.argv.slice(2).filter(a => !a.startsWith("--")), release = process.argv.includes("--release");
  const apart = madeFor() === appVersion() ? "" : `This repository is at ${version()}, made for Baltazar Mail ${madeFor()}; the app beside it is at ${appVersion()}.`;
  if (release && apart) throw new Error(apart);
  if (release && changed().length) throw new Error(`changed in the app since the glue was last compared with it: ${changed().join(", ")}`);
  if (process.argv.includes("--reviewed")) { fs.writeFileSync(WATCHED, JSON.stringify(watchedNow(), null, 2) + "\n"); console.log("recorded the watched functions as they are now"); }
  for (const edition of named.length ? named : Object.keys(app.EDITIONS)) {
    const out = build(edition);
    console.log(`built ${path.relative(ROOT, out)} (${JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8")).version_name})`);
  }
  const differs = changed();
  if (differs.length) console.log(`\nCHANGED IN THE APP since the glue was last compared with it: ${differs.join(", ")}.\nCompare each with the glue that follows it (glue/), run node tools/check.js, then: node tools/build.js --reviewed`);
  if (apart) console.log(`\n${apart} Once the checks pass against it (node tools/check.js --app), set VERSION here to match.`);
}

module.exports = { build, buildForTest, overlay, changed, glued, listed, declares, functionText, version, appVersion, madeFor, app, APP, ROOT, PORT, SOURCE, MARK };
