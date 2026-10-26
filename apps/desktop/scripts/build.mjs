// Bundles the desktop main process, the Baton service and the MCP server into build/app,
// then (unless --no-package) wraps it into out/Baton-darwin-<arch>/Baton.app.
// Expects the web app to be built already (`pnpm build` at the repo root; `pnpm desktop` does both).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";

const desktop = path.resolve(import.meta.dirname, "..");
const root = path.resolve(desktop, "../..");
const appDir = path.join(desktop, "build/app");
const resources = path.join(appDir, "resources");
const webDist = path.join(root, "apps/web/dist");

if (!fs.existsSync(path.join(webDist, "index.html"))) {
  console.error("apps/web/dist is missing — run `pnpm build` at the repo root first (or use `pnpm desktop`).");
  process.exit(1);
}

fs.rmSync(appDir, { recursive: true, force: true });

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "warning",
  // Some dependencies are CommonJS and call require() for Node built-ins.
  banner: { js: "import { createRequire as __batonCreateRequire } from 'node:module'; const require = __batonCreateRequire(import.meta.url);" },
};

await build({ ...common, entryPoints: [path.join(desktop, "src/main.ts")], outfile: path.join(appDir, "main.mjs"), external: ["electron"] });
await build({ ...common, entryPoints: [path.join(desktop, "src/server.ts")], outfile: path.join(appDir, "server.mjs") });
await build({ ...common, entryPoints: [path.join(root, "packages/mcp/bin/baton-mcp.mjs")], outfile: path.join(resources, "mcp/baton-mcp.mjs") });

fs.cpSync(webDist, path.join(resources, "web"), { recursive: true });
fs.mkdirSync(path.join(resources, "fixtures"), { recursive: true });
fs.copyFileSync(path.join(root, "packages/core/fixtures/mock-acp-agent.mjs"), path.join(resources, "fixtures/mock-acp-agent.mjs"));

const version = JSON.parse(fs.readFileSync(path.join(desktop, "package.json"), "utf8")).version;
fs.writeFileSync(path.join(appDir, "package.json"), JSON.stringify({ name: "baton", productName: "Baton", version, type: "module", main: "main.mjs" }, null, 2));
console.log(`bundled into ${path.relative(root, appDir)}`);

if (!process.argv.includes("--no-package")) {
  const { packager } = await import("@electron/packager");
  const electronVersion = JSON.parse(fs.readFileSync(path.join(desktop, "node_modules/electron/package.json"), "utf8")).version;
  const [bundle] = await packager({
    dir: appDir,
    out: path.join(desktop, "out"),
    name: "Baton",
    platform: "darwin",
    arch: process.arch,
    electronVersion,
    appBundleId: "dev.baton.desktop",
    appCategoryType: "public.app-category.developer-tools",
    appVersion: version,
    overwrite: true,
    prune: false,
    asar: false,
  });
  const appPath = path.join(bundle, "Baton.app");
  // Without a signing identity, an ad-hoc signature keeps Apple-silicon Macs willing to launch it.
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
  console.log(`packaged ${path.relative(root, appPath)}`);
}
