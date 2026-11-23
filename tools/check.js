// Everything this repository can check of itself, one after another: that the app's functions the
// glue follows are as they were when the glue was last compared with them, the overlay, the wire,
// the server, and both editions in a browser. With --app it also runs the app's own tests against
// the build with AI access (its check, and its long Yahoo suite), which tells whether the glue
// disturbs the app: every process they start loads tools/harness.js first, which answers the
// app's test build with this repository's.
// node tools/check.js [--app]
const path = require("path");
const { spawnSync } = require("child_process");
const { changed, APP, ROOT } = require("./build.js");

const own = ["build-test.mjs", "mcp-wire-test.mjs", "mcp-test.mjs", "mcp-runtime.js"];
const apps = process.argv.includes("--app") ? ["check.js", "yahoo-runtime.js"] : [];
let failed = 0;
const said = (name, good, took) => console.log(`${good ? "ok  " : "FAIL"} ${name}${took ? ` (${Math.round(took / 1000)} s)` : ""}`);

const differs = changed();
said(`the app's functions the glue follows are as recorded${differs.length ? `: changed, ${differs.join(", ")}` : ""}`, !differs.length);
if (differs.length) failed++;

function run(name, args, cwd, env = process.env) {
  const t0 = Date.now(), r = spawnSync(process.execPath, args, { cwd, env, encoding: "utf8", timeout: 20 * 60000 });
  const good = r.status === 0;
  said(name, good, Date.now() - t0);
  if (!good) { failed++; console.log(`${r.stdout || ""}${r.stderr || ""}`.trim().split("\n").slice(-40).join("\n")); }
}
for (const name of own) run(name, [path.join(ROOT, "tools", name)], ROOT);
const preload = `--require "${path.join(ROOT, "tools", "harness.js").replaceAll("\\", "/")}"`;
for (const name of apps) run(`the app's ${name}, with AI access`, [path.join(APP, "tools", name)], APP, { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, preload].filter(Boolean).join(" ") });

console.log(failed ? `${failed} FAILED` : "ALL PASS");
process.exit(failed ? 1 : 0);
