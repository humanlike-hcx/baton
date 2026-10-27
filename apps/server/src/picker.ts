import { execFile } from "node:child_process";

/** Undefined means the user cancelled. */
export type DirectoryPicker = () => Promise<string | undefined>;

const CHOOSE_DIRECTORY_SCRIPT = `
tell application "Finder" to activate
try
  set chosenFolder to choose folder with prompt "选择要在 Baton 里打开的项目目录"
  POSIX path of chosenFolder
on error number -128
  ""
end try
`;

/** macOS system folder dialog. The panel includes New Folder, and activating Finder brings it forward. */
export function chooseDirectory(): Promise<string | undefined> {
  if (process.platform !== "darwin") return Promise.reject(new Error("这个系统没有文件夹选择框，请手填目录路径"));
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", CHOOSE_DIRECTORY_SCRIPT], { timeout: 10 * 60_000 }, (error, stdout, stderr) => {
      const output = `${stdout ?? ""}\n${stderr ?? ""}`;
      if (error) {
        if (output.includes("-128") || /user canceled/i.test(output)) return resolve(undefined);
        return reject(new Error("文件夹选择框没有打开，请手填目录路径"));
      }
      resolve(stdout.trim() || undefined);
    });
  });
}
