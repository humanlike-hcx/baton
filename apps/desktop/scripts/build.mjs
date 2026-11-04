// Bundle the local application and package for macOS or Windows.
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
  // Pi embeds jiti and its extension imports when running from a single bundled file.
  define: { PI_BUNDLED_NODE: "true" },
  logLevel: "warning",
  // Some dependencies are CommonJS and call require() for Node built-ins.
  banner: { js: "import { createRequire as __batonCreateRequire } from 'node:module'; const require = __batonCreateRequire(import.meta.url);" },
};

await build({ ...common, entryPoints: [path.join(desktop, "src/main.ts")], outfile: path.join(appDir, "main.mjs"), external: ["electron"] });
await build({ ...common, entryPoints: [path.join(desktop, "src/server.ts")], outfile: path.join(appDir, "server.mjs") });

fs.cpSync(webDist, path.join(resources, "web"), { recursive: true });

const version = JSON.parse(fs.readFileSync(path.join(desktop, "package.json"), "utf8")).version;
fs.writeFileSync(path.join(appDir, "package.json"), JSON.stringify({ name: "baton", productName: "Baton", version, type: "module", main: "main.mjs" }, null, 2));
console.log(`bundled into ${path.relative(root, appDir)}`);
execFileSync(process.execPath, [path.join(desktop, "scripts/smoke-runtime.mjs"), path.join(appDir, "server.mjs")], { stdio: "inherit" });

if (!process.argv.includes("--no-package")) {
  const { packager } = await import("@electron/packager");
  const electronVersion = JSON.parse(fs.readFileSync(path.join(desktop, "node_modules/electron/package.json"), "utf8")).version;
  const [bundle] = await packager({
    dir: appDir,
    out: path.resolve(desktop, process.argv.find(a => a.startsWith("--out="))?.slice(6) ?? "out"),
    name: "Baton",
    platform: process.argv.find(a => a.startsWith("--platform="))?.split("=")[1] ?? process.platform,
    arch: process.argv.find(a => a.startsWith("--arch="))?.split("=")[1] ?? process.arch,
    electronVersion,
    appBundleId: "dev.baton.desktop",
    appCategoryType: "public.app-category.developer-tools",
    appVersion: version,
    win32metadata: { CompanyName: "Baton", ProductName: "Baton", FileDescription: "Baton local coding workspace" },
    overwrite: true,
    prune: false,
    asar: false,
  });
  const appPath = path.join(bundle, "Baton.app");
  // Without a signing identity, an ad-hoc signature keeps Apple-silicon Macs willing to launch it.
  if (process.platform === "darwin" && fs.existsSync(appPath)) execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
  console.log(`packaged ${path.relative(root, bundle)}`);
}
