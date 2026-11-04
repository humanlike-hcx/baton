// Exercise extension loading from the bundled runtime, without a model request.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const bundle = process.argv[2];
if (!bundle) throw new Error("Pass the bundled server.mjs path");
const { AppState } = await import(pathToFileURL(path.resolve(bundle)).href);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "baton-bundle-"));
const home = path.join(root, "data");
const projectRoot = path.join(root, "project");
fs.mkdirSync(path.join(home, "v2"), { recursive: true });
fs.mkdirSync(projectRoot);
// The slash-command check below never calls this synthetic model endpoint.
fs.writeFileSync(path.join(home, "v2/gateway.json"), JSON.stringify({
  url: "http://127.0.0.1:1/v1", token: "",
  models: [{ id: "bundle-test", name: "Bundle test", api: "openai-completions", verified: true, thinking: [] }],
}));
const extension = path.join(projectRoot, "extension.ts");
fs.writeFileSync(extension, `
import { Type } from "typebox";
export default function(pi) {
  const marker: string = "BUNDLED_EXTENSION_READY";
  pi.registerTool({ name: "bundle_echo", label: "Bundle echo", description: "Echo", parameters: Type.Object({text: Type.String()}), execute: async (_id, args) => ({content: [{type: "text", text: args.text}]}) });
  pi.on("session_start", (_event, ctx) => ctx.ui.notify(marker));
}
`);
fs.writeFileSync(`${extension}.baton.json`, JSON.stringify({ host: "baton-v2", ui: "none" }));
const state = new AppState({ home });
try {
  await state.init();
  const project = state.openProject(projectRoot);
  const resource = state.setResource(project.id, { path: extension, kind: "extension", enabled: true });
  const thread = state.createThread(project.id, { id: "bundle-test" });
  state.inspectMcp(thread.id);
  await state.wait(thread.id);
  assert.equal(thread.runs[0].status, "succeeded", thread.runs[0].error);
  assert.equal(resource.error, undefined, resource.error);
  assert(thread.items.some(i => i.text.includes("BUNDLED_EXTENSION_READY")), JSON.stringify(thread.items));
  console.log("bundled TypeScript extension smoke passed");
} finally {
  await state.stopAll();
  fs.rmSync(root, { recursive: true, force: true });
}
